"""The plan's usage limits (the 5-hour and weekly windows) as a Claude Code status line last saw them.

Claude Code hands `rate_limits` only to the status line command, on its stdin; nothing else keeps it. So a status line
that wants ccprobe to show it saves that object to ~/.cache/ccprobe/rate-limits.json (README: "Plan limits"), and
ccprobe reads the file: read only, a small regular file, never served as it is.

    {"rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": 1794150000},
                     "seven_day": {"used_percentage": 61, "resets_at": 1794400000}, …}}

The file's own time is when it was last seen (the writer refreshes it at least once a minute while a session runs).
"""
import datetime as dt
import json
import os
import re
import stat

PATH = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "ccprobe", "rate-limits.json")
MAX_BYTES = 65536
HOUR, DAY = 3600, 86400
# window key -> (label, its length in seconds); a model's own weekly limit ("seven_day_opus") is a week too
KNOWN = {"five_hour": ("5-hour", 5 * HOUR), "seven_day": ("week", 7 * DAY)}
_cache = {"key": None, "value": None}


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _when(v):
    """resets_at: Unix seconds (as the status line gives it), milliseconds, or an ISO time; None otherwise."""
    n = _num(v)
    if n is not None:
        return n / 1000 if n > 1e11 else n
    if isinstance(v, str):
        try:
            t = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
            return (t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)).timestamp()
        except ValueError:
            return None
    return None


def _label(key):
    if key in KNOWN:
        return KNOWN[key]
    m = re.fullmatch(r"seven_day_([a-z0-9]+)", key)
    if m:
        return f"week · {m.group(1).capitalize()}", 7 * DAY
    m = re.fullmatch(r"five_hour_([a-z0-9]+)", key)
    if m:
        return f"5-hour · {m.group(1).capitalize()}", 5 * HOUR
    return None


def parse(d, seen):
    """{"seen", "windows": [{key, label, used, resets_at, span}]} from the saved object, or None with no window."""
    rl = d.get("rate_limits") if isinstance(d, dict) else None
    if not isinstance(rl, dict):
        return None
    out = []
    for key, w in rl.items():
        if not isinstance(key, str) or not isinstance(w, dict):
            continue
        used, lab = _num(w.get("used_percentage")), _label(key)
        if used is None or lab is None:
            continue
        out.append({"key": key, "label": lab[0], "span": lab[1], "used": max(0.0, min(used, 100.0)),
                    "resets_at": _when(w.get("resets_at"))})
    order = {"five_hour": 0, "seven_day": 1}
    out.sort(key=lambda x: (order.get(x["key"], 2), x["key"]))
    return {"seen": seen, "windows": out} if out else None


def read(path=None):
    """The latest reading, or None (no file, too big, not JSON, no window). Parsed again only when the file changes."""
    path = path or PATH
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES:
        return None
    key = (path, st.st_mtime_ns, st.st_size)
    if _cache["key"] != key:
        try:
            with open(path) as f:
                value = parse(json.load(f), st.st_mtime)
        except (OSError, ValueError):
            value = None
        _cache["key"], _cache["value"] = key, value
    return _cache["value"]
