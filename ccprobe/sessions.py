"""Discovery: every Claude Code process on this Mac, whether it is alive, and the tmux pane it runs in."""
import glob
import json
import os
import re
import subprocess
import time

CLAUDE = os.path.expanduser("~/.claude")
KEEP = ("pid", "sessionId", "cwd", "name", "version", "status", "statusUpdatedAt", "startedAt", "kind")


def project_dir(cwd):
    """~/.claude/projects/<cwd with every non-alphanumeric character turned into ->."""
    return os.path.join(CLAUDE, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError):
        return False


def read_registry():
    """The session registry: one <pid>.json per Claude process. Only these files are read (never the .key files)."""
    out = []
    for path in glob.glob(os.path.join(CLAUDE, "sessions", "[0-9]*.json")):
        if not re.fullmatch(r"\d+\.json", os.path.basename(path)):
            continue
        try:
            with open(path) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("pid") and d.get("cwd"):
            out.append({k: d.get(k) for k in KEEP})
    return out


def _run(args, timeout=2):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


class Tmux:
    """tmux panes keyed by pane pid, refreshed at most every `ttl` seconds."""

    def __init__(self, ttl=5):
        self.ttl = ttl
        self.at = 0
        self.panes = {}

    def get(self):
        if time.time() - self.at >= self.ttl:
            self.at = time.time()
            panes = {}
            fmt = "#{pane_pid}\t#{session_name}\t#{window_index}.#{pane_index}\t#{session_attached}\t#{pane_title}"
            for line in _run(["tmux", "list-panes", "-a", "-F", fmt]).splitlines():
                parts = line.split("\t", 4)
                if len(parts) == 5 and parts[0].isdigit():
                    # attached: how many terminals show this tmux session (0: its window was closed, it runs unseen)
                    panes[int(parts[0])] = {"session": parts[1], "pane": parts[2], "attached": int(parts[3] or 0) if parts[3].isdigit() else None,
                                            "title": parts[4]}
            self.panes = panes
        return self.panes


def parent_pids():
    out = {}
    for line in _run(["ps", "-A", "-o", "pid=,ppid="]).splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            out[int(parts[0])] = int(parts[1])
    return out


def discover(tmux):
    """Every registered Claude session, with `alive`, `tmux` (or None) and its transcript paths."""
    panes = tmux.get()
    ppid = parent_pids()
    out = []
    for s in read_registry():
        pid = s["pid"]
        s["alive"] = alive(pid)
        pane = panes.get(ppid.get(pid))
        s["tmux"] = dict(pane) if pane else None
        pdir = project_dir(s["cwd"])
        sid = s.get("sessionId") or ""
        s["transcript"] = os.path.join(pdir, sid + ".jsonl")
        s["subagents"] = os.path.join(pdir, sid, "subagents")
        out.append(s)
    return out
