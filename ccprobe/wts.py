"""Read-only bridge to the worker skill's queue.py, so ccprobe's WTS and `queue.py wts` can never disagree."""
import importlib.util
import os
import re
import subprocess
import sys
import time

from .redact import redact

QUEUE_PY = os.path.expanduser("~/.claude/skills/worker/scripts/queue.py")
PRIS = ("HP", "MP", "LP")
OPEN = ("asks", "active", "paused", "parked", "queued", "other")
_mod = {"mtime": None, "m": None, "error": None}
_last_good = {}      # root -> (rows count, model): a torn read of queue.md keeps the last good one (audit M6)
_proc_cache = {}     # (kind, arg) -> (time, value)


def queue_module():
    """queue.py loaded as a module (its CLI sits behind __main__), reloaded when the file changes."""
    try:
        mt = os.path.getmtime(QUEUE_PY)
    except OSError:
        _mod.update(m=None, error="queue.py not found")
        return None
    if mt != _mod["mtime"]:
        # never write __pycache__ into the skill's folder (ccprobe writes nothing outside its own files: audit M3)
        old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
        try:
            spec = importlib.util.spec_from_file_location("ccprobe_worker_queue", QUEUE_PY)
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            _mod.update(mtime=mt, m=m, error=None)
        except BaseException as e:  # a broken queue.py (even one that calls sys.exit) must not stop ccprobe
            if _mod["m"] is None:
                _mod.update(error=f"queue.py failed to load: {e}")
            _mod["mtime"] = mt          # keep the previous module, if any
        finally:
            sys.dont_write_bytecode = old
    return _mod["m"]


def is_project(root):
    return os.path.isfile(os.path.join(root, ".autopilot", "worker", "queue.md"))


def _cached(key, ttl, fn):
    hit = _proc_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    v = fn()
    _proc_cache[key] = (time.time(), v)
    return v


def caffeinated(m):
    def probe():
        try:
            return bool(m.caffeinated())
        except BaseException:
            return subprocess.run(["pgrep", "-x", "caffeinate"], capture_output=True).returncode == 0
    return _cached(("caf",), 5, probe)


def app_running(name):
    if not name:
        return None
    return _cached(("app", name), 5, lambda: subprocess.run(["pgrep", "-x", name], capture_output=True).returncode == 0)


def read(root):
    """The WTS model for one project root. Calls only queue.py's readers, never a writer."""
    m = queue_module()
    if m is None:
        return {"root": root, "error": _mod["error"], "raw": _raw_wts(root)}
    qpath = os.path.join(root, ".autopilot", "worker", "queue.md")
    try:
        before = os.stat(qpath)
        q = m.Queue(root)
        rows = q.rows()
        after = os.stat(qpath)
        prev = _last_good.get(root)
        torn = (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size) or after.st_size == 0
        if prev and (torn or len(rows) < prev[0] * 0.8):
            return prev[1]           # read during a rewrite: show the last good table this tick
        pinned = q.pinned()
        groups = {}
        for pri in PRIS:
            mine = [r for r in rows if r["pri"] == pri and r["n"] not in pinned]
            by_n = {r["n"]: r for r in mine}
            out = []
            # table_rows gives the exact rows and order of `wts`: (n, title, runs_on, status, accepted)
            for n, title, runs_on, status, acc in m.table_rows(q, mine, False):
                r = by_n.get(int(n))
                out.append({"n": int(n), "title": redact(title), "runs_on": runs_on, "status": redact(status), "acc": acc,
                            "kind": m.Queue.kind(r) if r else "other", "state": _clip(redact(r["state"]) if r else "", 300),
                            "task": _clip(redact(_plain(r["task"])) if r else "", 600)})
            groups[pri] = out
        lock_rel = q.cfg.get("lock", ".autopilot/run.lock")
        lock_path = os.path.join(root, lock_rel)
        who = q.lock_text()
        since = None
        if who:
            try:
                since = os.path.getmtime(lock_path)
            except OSError:
                pass
        res = {
            "root": root, "error": None, "app": q.cfg.get("app_process") or None,
            "app_running": app_running(q.cfg.get("app_process")),
            "hp_line": m.hp_line(q), "state_file": q.read_state(),
            "modes": {"MP": q.group_mode("MP"), "LP": q.group_mode("LP")},
            "caffeinate": caffeinated(m),
            "lock_path": lock_path,
            "window": {"held": bool(who), "who": who, "since": since, "holder": None, "waiters": []},
            "groups": groups,
            "worker_model": q.cfg.get("worker_model"),
        }
        _last_good[root] = (len(rows), res)
        return res
    except BaseException as e:
        return {"root": root, "error": f"queue.py read failed: {e}", "raw": _raw_wts(root)}


_raw_cache = {}


def _raw_wts(root):
    """Fallback: the text `queue.py wts` prints, at most every 10 s."""
    hit = _raw_cache.get(root)
    if hit and time.time() - hit[0] < 10:
        return hit[1]
    try:
        out = subprocess.run(["python3", QUEUE_PY, "--root", root, "wts"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    _raw_cache[root] = (time.time(), out)
    return out


def _plain(s):
    return re.sub(r"\*\*|`", "", s)


def _clip(s, n):
    return s if len(s) <= n else s[: n - 1] + "…"
