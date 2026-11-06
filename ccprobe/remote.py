"""Other machines' sessions, over SSH, with nothing installed, written or listened on there.

For each remote, this machine runs `ssh <host> python3 -c <boot>` and sends this package's source down the pipe. The far
side keeps the source in memory, runs the same read-only collector on its own ~/.claude, and streams its model back as
JSON lines. It answers the panel's questions (an agent's detail, the Events list, a task's notes) on the same pipe, and
exits when the pipe closes. The Hub merges the remote models into this one and sends each question to the machine that
owns the session."""
import base64
import hashlib
import json
import os
import shlex
import subprocess
import sys
import threading
import time

from . import wts as wts_mod
from .redact import redact

PKG = os.path.dirname(os.path.abspath(__file__))
PING_S = 5          # the far side's heartbeat while its model is unchanged
DEAD_S = 30         # silent this long: the link is dead, start again
KEEP_S = 30         # a lost link keeps its sessions on screen this long (a blip must not empty the rail)
ASK_S = 10          # how long a panel question waits for its answer

# The far side's whole start: a finder that imports this package from the source on stdin's first line.
BOOT = r'''
import importlib.abc, importlib.util, json, sys
sys.dont_write_bytecode = True
src = json.loads(sys.stdin.buffer.readline())
class Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path=None, target=None):
        k = name.replace(".", "/")
        if k + "/__init__.py" in src:
            return importlib.util.spec_from_loader(name, self, is_package=True)
        if k + ".py" in src:
            return importlib.util.spec_from_loader(name, self)
    def create_module(self, spec):
        return None
    def exec_module(self, m):
        k = m.__name__.replace(".", "/")
        k = k + "/__init__.py" if k + "/__init__.py" in src else k + ".py"
        m.__file__ = "<ccprobe>/" + k
        exec(compile(src[k], m.__file__, "exec"), m.__dict__)
sys.meta_path.insert(0, Finder())
from ccprobe import remote
remote.serve_stdio(json.loads(sys.argv[1]))
'''


def bundle():
    """This package's source, as the far side's first line."""
    src = {}
    for name in sorted(os.listdir(PKG)):
        if name.endswith(".py"):
            with open(os.path.join(PKG, name), encoding="utf-8") as f:
                src["ccprobe/" + name] = f.read()
    return json.dumps(src).encode() + b"\n"


def boot_args(opts):
    """python3's arguments on the far side: the boot code (base64: no quoting to get wrong) and the options."""
    b64 = base64.b64encode(BOOT.encode()).decode()
    return ["python3", "-u", "-c", f"import base64;exec(base64.b64decode('{b64}'))", json.dumps(opts)]


# ---- the far side ----------------------------------------------------------------------------------------------------
def serve_stdio(opts):
    """Run the collector here and stream its model to stdout; answer questions from stdin; exit when stdin closes."""
    from . import model, server
    col = model.Collector(window_s=opts.get("window", 6 * 3600), ctx_max=opts.get("ctx_max", 1_000_000))
    server.run_collector(col, opts.get("interval", 1.5))
    out, lock = sys.stdout.buffer, threading.Lock()

    def send(obj):
        line = json.dumps(obj, default=str, separators=(",", ":")).encode() + b"\n"
        try:
            with lock:
                out.write(line)
                out.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)

    def answer(q):
        op, args = q.get("op"), q.get("args") or []
        try:
            if op == "agent":
                body = col.agent_detail(*args)
            elif op == "feed":
                body = col.feed_for(*args)
            elif op == "notes":
                body = col.notes(*args)
            elif op == "pic":
                pic = col.notes_pic(*args)
                body = {"type": pic[0], "b64": base64.b64encode(pic[1]).decode()} if pic else None
            else:
                body = None
        except Exception:     # a question must never stop the stream
            body = None
        send({"t": "reply", "id": q.get("id"), "body": body})

    def reader():
        for raw in sys.stdin.buffer:
            try:
                q = json.loads(raw)
            except ValueError:
                continue
            if isinstance(q, dict):
                threading.Thread(target=answer, args=(q,), daemon=True).start()
        os._exit(0)           # the other machine hung up

    threading.Thread(target=reader, name="stdin", daemon=True).start()
    last, ping = None, 0.0
    while True:
        m, d = col.snapshot()
        if m is not None and d != last:
            last = d
            send({"t": "model", "digest": d, "model": m})
            ping = time.time()
        elif time.time() - ping >= PING_S:
            send({"t": "ping", "now": time.time()})
            ping = time.time()
        col.changed.wait(1.0)


# ---- this side -------------------------------------------------------------------------------------------------------
def remotes_for(specs, opts, wake):
    """One Remote per spec (a repeated spec counts once). Two specs that come to the same name are refused: the name
    keys a machine's cards, alerts and status line, so they would collide."""
    out, by_name = [], {}
    for spec in dict.fromkeys(specs):
        r = Remote(spec, opts, wake)
        if r.name in by_name:
            raise ValueError(f'"{spec}" and "{by_name[r.name]}" are both named "{r.name}": '
                             f'give one another name, as in "{r.name}2={r.dest}"')
        by_name[r.name] = spec
        out.append(r)
    return out


class Remote:
    """One machine reached over SSH: its latest model, the link's state, and the questions waiting for answers."""

    def __init__(self, spec, opts, wake):
        name, _, dest = spec.partition("=")
        self.dest = dest or name                       # "ubuntu" or "box=user@192.0.2.9"
        self.name = name if dest else name.split("@")[-1]
        self.opts, self.wake = opts, wake
        self.state, self.error, self.since = "connecting", None, time.time()
        self.latest, self.seen, self.until = (None, None), 0.0, 0.0   # (model, digest): one read, never a torn pair
        self.proc, self.lock, self.pending, self.next_id = None, threading.Lock(), {}, 0
        self.stopping = False

    def command(self):
        ssh = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"]
        return ssh + ["--", self.dest, " ".join(shlex.quote(a) for a in boot_args(self.opts))]

    def start(self):
        threading.Thread(target=self._run, name=f"remote-{self.name}", daemon=True).start()
        threading.Thread(target=self._watch, name=f"watch-{self.name}", daemon=True).start()
        return self

    def stop(self):
        self.stopping = True
        p = self.proc
        if p and p.poll() is None:
            p.kill()

    def _set(self, state, error=None):
        if state != self.state or error != self.error:
            self.state, self.error, self.since = state, error, time.time()
            self.wake()

    def _run(self):
        wait = 3
        while not self.stopping:
            err = []
            try:
                p = self.proc = subprocess.Popen(self.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                 stderr=subprocess.PIPE)
            except OSError as e:
                self._set("down", f"ssh: {e}")
                time.sleep(60)
                continue
            threading.Thread(target=self._stderr, args=(p, err), daemon=True).start()
            try:
                p.stdin.write(bundle())
                p.stdin.flush()
                for raw in p.stdout:
                    self.seen = time.time()
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(msg, dict):          # a stray line from the far shell ("42", "null")
                        continue
                    if msg.get("t") == "model":
                        self.latest, self.until = (msg.get("model"), msg.get("digest")), 0.0
                        wait = 3
                        self._set("live")
                        self.wake()
                    elif msg.get("t") == "reply":
                        hit = self.pending.get(msg.get("id"))
                        if hit:
                            hit[1] = msg.get("body")
                            hit[0].set()
                    # a ping only proves the link is alive: `seen` is enough
            except (OSError, ValueError):
                pass
            try:
                p.kill()
            except OSError:
                pass
            rc = p.wait()
            for ev, _ in list(self.pending.values()):   # questions in flight get no answer
                ev.set()
            if self.stopping:
                return
            self.until = time.time() + KEEP_S
            self._set("down", redact(err[-1]) if err else f"ssh exited with {rc}")
            time.sleep(wait)
            wait = min(wait * 2, 60)
            if not self.stopping:
                self._set("connecting", self.error)

    @staticmethod
    def _stderr(p, err):
        for raw in p.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                err[:] = (err + [line[:300]])[-5:]

    def _watch(self):
        while not self.stopping:
            time.sleep(5)
            p = self.proc
            if self.state == "live" and p and p.poll() is None and time.time() - self.seen > DEAD_S:
                p.kill()            # silent for too long: _run starts it again

    def view(self):
        """(model, digest) to show: the live one, or a lost link's last one for a short while; (None, None) otherwise."""
        if self.state == "live" or time.time() < self.until:
            return self.latest
        return None, None

    def shown(self):
        return self.view()[0]

    def ask(self, op, *args):
        """Ask the far side; None when the link is down or the answer is late."""
        p = self.proc
        if self.state != "live" or not p or p.poll() is not None:
            return None
        with self.lock:
            self.next_id += 1
            qid = self.next_id
            hit = self.pending[qid] = [threading.Event(), None]
            try:
                p.stdin.write(json.dumps({"id": qid, "op": op, "args": list(args)}).encode() + b"\n")
                p.stdin.flush()
            except OSError:
                self.pending.pop(qid, None)
                return None
        hit[0].wait(ASK_S)
        self.pending.pop(qid, None)
        return hit[1]

    def status(self):
        m = self.shown()
        return {"name": self.name, "state": self.state, "error": self.error, "since": self.since,
                "sessions": len((m or {}).get("sessions") or [])}


class Hub:
    """This machine's collector plus the remotes, with the collector's interface the server uses: one merged model, and
    each question sent to the machine whose session it is."""

    def __init__(self, local, remotes):
        self.local, self.remotes = local, remotes
        self.owner = {}            # session id -> its Remote
        self.lock = threading.Lock()
        self._key, self._lm, self._model, self._digest, self._json, self._json_for = None, None, None, None, None, None

    # the server waits on these
    @property
    def stopping(self):
        return self.local.stopping

    @property
    def changed(self):
        return self.local.changed

    def wake(self):
        ev = self.local.changed
        ev.set()
        ev.clear()

    def stop(self):
        for r in self.remotes:
            r.stop()

    def snapshot(self):
        lm, ld = self.local.snapshot()
        if lm is None:
            return None, None
        views = [(r,) + r.view() for r in self.remotes]
        shown = [(r, m) for r, m, _ in views]
        key = (ld,) + tuple((r.name, d if m is not None else None, r.state, r.error) for r, m, d in views)
        with self.lock:
            # the digest follows the key (an idle system pushes nothing), but the model is rebuilt with each local tick
            # so its clock, today's tokens and the server's figures stay as fresh as the local model's
            if key == self._key and self._lm is lm:
                return self._model, self._digest
            self._model, self.owner = merge(lm, shown)
            self._lm = lm
            if key != self._key:
                self._digest, self._key = hashlib.sha1(json.dumps(key).encode()).hexdigest(), key
            return self._model, self._digest

    def snapshot_json(self):
        m, _ = self.snapshot()
        if m is None:
            return None
        with self.lock:
            if self._json_for is not m:
                self._json, self._json_for = json.dumps(m, default=str), m
            return self._json

    def _route(self, sid):
        with self.lock:
            return self.owner.get(sid)

    def agent_detail(self, sid, aid):
        r = self._route(sid)
        return r.ask("agent", sid, aid) if r else self.local.agent_detail(sid, aid)

    def feed_for(self, sid):
        r = self._route(sid)
        return r.ask("feed", sid) if r else self.local.feed_for(sid)

    def notes(self, sid, n):
        r = self._route(sid)
        return r.ask("notes", sid, n) if r else self.local.notes(sid, n)

    def notes_pic(self, sid, n, i):
        r = self._route(sid)
        if not r:
            return self.local.notes_pic(sid, n, i)
        d = r.ask("pic", sid, n, i)
        try:
            return (d["type"], base64.b64decode(d["b64"])) if d and d.get("type") in PIC_TYPES else None
        except (ValueError, TypeError, KeyError):
            return None


PIC_TYPES = set(wts_mod.PIC_TYPES.values())


def merge(local, shown):
    """The local model with each remote's sessions (tagged with its host), alerts and today's tokens added."""
    m = dict(local)
    sessions, alerts, owner = list(local.get("sessions") or []), list(local.get("alerts") or []), {}
    tt = dict(local.get("tokens_today") or {"v": [0, 0, 0, 0], "n": 0, "ready": True})
    tt["v"] = list(tt.get("v") or [0, 0, 0, 0])
    for r, rm in shown:
        if not rm:
            continue
        for s in rm.get("sessions") or []:
            sessions.append(dict(s, host=r.name, ssh=r.dest))
            owner[s.get("id")] = r
        for a in rm.get("alerts") or []:
            alerts.append(dict(a, key=f"{r.name}:{a.get('key')}", host=r.name,
                               project=f"{a.get('project') or ''} @{r.name}"))
        rt = rm.get("tokens_today") or {}
        for i, x in enumerate((rt.get("v") or [])[:4]):
            tt["v"][i] += x or 0
        tt["n"] = (tt.get("n") or 0) + (rt.get("n") or 0)
        tt["ready"] = bool(tt.get("ready")) and bool(rt.get("ready", True))
    m["sessions"], m["alerts"], m["tokens_today"] = sessions, alerts, tt
    m["server"] = dict(local.get("server") or {}, remotes=[r.status() for r, _ in shown])
    return m, owner
