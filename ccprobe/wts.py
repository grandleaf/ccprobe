"""Read-only bridge to the worker skill's queue.py, so ccprobe's WTS and `queue.py wts` can never disagree."""
import importlib.util
import os
import re
import stat
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
_pic_cache = {}      # (root, n) -> ((notes mtime, size), time, pictures): one scan serves every thumbnail


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


# ---- a task's documents: the worker's notes (<root>/.autopilot/worker/<N>.md, the skill's convention) and the lead's
# briefs (<N>-brief.md, <N>-redo2-brief.md …), plus the pictures the notes name. Read-only; served by task number and
# picture index, never by a path from the URL. ----
RE_NOTE = re.compile(r"^(\d{1,4})\.md$")
RE_PIC = re.compile(r"[\w./~-]*[\w-]\.(?:png|jpe?g|webp|gif)\b", re.I)
RE_DIR = re.compile(r"[\w.~-][\w./~-]*/")
PIC_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
DOC_MAX, PIC_MAX, PICS_MAX = 400_000, 40_000_000, 40


def worker_dir(root):
    return os.path.join(root, ".autopilot", "worker")


def notes_index(root):
    """{task number: mtime} of the notes files in the worker folder, looked at most every 3 s."""
    def scan():
        out = {}
        try:
            with os.scandir(worker_dir(root)) as it:
                for e in it:
                    m = RE_NOTE.match(e.name)
                    if m and e.is_file():
                        out[int(m.group(1))] = e.stat().st_mtime
        except OSError:
            pass
        return out
    return _cached(("notes", root), 3, scan)


def _inside(root, p):
    return p.startswith(os.path.realpath(root) + os.sep)


def _read_doc(root, path):
    """A document in the worker folder: only a regular file inside the project (never a link out of it, nor a FIFO)."""
    rp = os.path.realpath(path)
    if not _inside(root, rp):
        return None
    try:
        fd = os.open(rp, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    with os.fdopen(fd, "rb") as f:
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                return None
            raw = f.read(DOC_MAX)
        except OSError:
            return None
    return {"name": os.path.basename(path), "mtime": st.st_mtime, "size": st.st_size, "cut": st.st_size > DOC_MAX,
            "text": redact(raw.decode("utf-8", "replace"))}


def notes(root, n):
    """Task n's notes and briefs, newest brief last; None when it has neither."""
    wd = worker_dir(root)
    docs = []
    d = _read_doc(root, os.path.join(wd, f"{n}.md"))
    if d:
        docs.append(dict(d, kind="notes"))
    try:
        names = [x for x in os.listdir(wd) if re.match(rf"^{n}(?:-[\w.-]+)?-brief\.md$", x)]
    except OSError:
        names = []
    briefs = [x for x in (_read_doc(root, os.path.join(wd, x)) for x in names) if x]
    docs += [dict(x, kind="brief") for x in sorted(briefs, key=lambda x: x["mtime"])]
    if not docs:
        return None
    pics = [{"i": i, "refs": refs, "name": os.path.basename(p), "size": size}
            for i, (refs, p, size) in enumerate(_doc_pics(root, n, docs[0]) if docs[0]["kind"] == "notes" else [])]
    return {"n": n, "docs": docs, "pics": pics}


def notes_pic(root, n, i):
    """(content type, bytes) of the i-th picture task n's notes name, or None."""
    path = os.path.join(worker_dir(root), f"{n}.md")
    try:
        st = os.stat(path)
    except OSError:
        return None
    hit = _pic_cache.get((root, n))
    if hit and hit[0] == (st.st_mtime, st.st_size) and time.time() - hit[1] < 10:
        pics = hit[2]
    else:
        d = _read_doc(root, path)
        pics = _doc_pics(root, n, d) if d else []
    if not 0 <= i < len(pics):
        return None
    path = pics[i][1]
    try:
        with open(path, "rb") as f:
            return PIC_TYPES[os.path.splitext(path)[1].lower()], f.read()
    except (OSError, KeyError):
        return None


def _doc_pics(root, n, d):
    """_pics of a notes document, kept for its version: the reader asks for every thumbnail at once."""
    pics = _pics(root, n, d["text"])
    _pic_cache[(root, n)] = ((d["mtime"], d["size"]), time.time(), pics)
    return pics


def _pics(root, n, text):
    """The pictures the notes name that exist inside the project: [(refs, real path, size)]. A bare name is looked for
    in the project, the worker folder, its <n>/ folder and every folder the notes mention."""
    real_root = os.path.realpath(root)
    inside = lambda p: p.startswith(real_root + os.sep)    # (as _inside, with the root resolved once)
    wd = worker_dir(root)
    dirs = [root, wd, os.path.join(wd, str(n))]
    for m in RE_DIR.finditer(text):
        for base in (root, wd):
            d = os.path.join(base, os.path.expanduser(m.group(0)))
            if d not in dirs and inside(os.path.realpath(d)) and os.path.isdir(d):
                dirs.append(d)
        if len(dirs) > 60:
            break
    out, at = [], {}
    for m in RE_PIC.finditer(text):
        ref = m.group(0)
        if ref in at:            # found, or looked for in vain, already
            continue
        cands = [os.path.expanduser(ref)] if ref.startswith(("/", "~")) else [os.path.join(d, ref) for d in dirs]
        for c in cands:
            rp = os.path.realpath(c)
            if inside(rp) and os.path.splitext(rp)[1].lower() in PIC_TYPES and os.path.isfile(rp):
                size = os.path.getsize(rp)
                if size > PIC_MAX:
                    break
                k = next((j for j, o in enumerate(out) if o[1] == rp), None)
                if k is None:
                    if len(out) >= PICS_MAX:
                        break
                    out.append(([ref], rp, size))
                    k = len(out) - 1
                else:
                    out[k][0].append(ref)
                at[ref] = k
                break
        else:
            at[ref] = None
    return out


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
        settled = time.time_ns() - after.st_mtime_ns > 2_000_000_000     # untouched for 2 s: not mid-rewrite
        if prev and (torn or (len(rows) < prev[0] * 0.8 and not settled)):
            return prev[1]           # read during a rewrite: show the last good table this tick
        pinned = q.pinned()
        nidx = notes_index(root)
        groups = {}
        for pri in PRIS:
            mine = [r for r in rows if r["pri"] == pri and r["n"] not in pinned]
            by_n = {r["n"]: r for r in mine}
            out = []
            # table_rows gives the exact rows and order of `wts`: (n, title, runs_on, status, accepted)
            for n, title, runs_on, status, acc in m.table_rows(q, mine, False):
                r = by_n.get(int(n))
                status = status.replace(" · reviewed by me", "")   # every done row is reviewed: only the exceptions are worth showing
                out.append({"n": int(n), "title": redact(title), "runs_on": runs_on, "status": redact(status), "acc": acc,
                            "kind": m.Queue.kind(r) if r else "other", "state": _clip(redact(r["state"]) if r else "", 300),
                            "task": _clip(redact(_plain(r["task"])) if r else "", 600), "notes": nidx.get(int(n))})
            groups[pri] = out
        # the window slots: "locks" (a list, two game windows side by side) or the one "lock"; older queue.py has only the one
        if hasattr(q, "lock_paths"):
            lock_paths = q.lock_paths()
        else:
            lock_paths = [os.path.join(root, q.cfg.get("lock", ".autopilot/run.lock"))]
        slots = []
        for path in lock_paths:
            who = q.one_lock_text(path) if hasattr(q, "one_lock_text") else q.lock_text()
            since = None
            if who:
                try:
                    since = os.path.getmtime(path)
                except OSError:
                    pass
            slots.append({"name": os.path.basename(path), "held": bool(who), "who": who, "since": since, "holder": None})
        res = {
            "root": root, "error": None, "app": q.cfg.get("app_process") or None,
            "app_running": app_running(q.cfg.get("app_process")),
            "hp_line": m.hp_line(q), "state_file": q.read_state(),
            "modes": {"MP": q.group_mode("MP"), "LP": q.group_mode("LP")},
            "caffeinate": caffeinated(m),
            "lock_paths": lock_paths,
            # held: any slot is; full: every slot is (an agent that needs one waits)
            "window": {"held": any(x["held"] for x in slots), "full": all(x["held"] for x in slots), "slots": slots, "waiters": []},
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
