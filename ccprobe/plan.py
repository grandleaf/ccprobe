"""The plan's usage limits (the 5-hour and weekly windows, and a model's own week) as Claude Code last gave them.

Two small files under ~/.cache/ccprobe, both written by the status line (README: "Plan limits"); ccprobe only reads
them: regular files, at most 64 KB, never served as they are.

- rate-limits.json: Claude Code hands `rate_limits` only to the status line command, on its stdin, and the status line
  saves it. The file's own time is when it was last seen (refreshed at least once a minute while a session runs).

      {"rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": 1794150000},
                       "seven_day": {"used_percentage": 61, "resets_at": 1794400000}, …}}

- plan-usage.json: the claude.ai usage endpoint's rows, which hold what rate_limits does not, a model's own weekly limit
  (the Fable week). The worker skill's plan_usage.py asks a headless Claude Code for them (`get_usage`) every few
  minutes while a session draws its status line, and saves them as sent:

      {"fetched_at": 1794615441, "limits": [{"kind": "weekly_all", "percent": 24, "resets_at": "2026-11-19T15:00:00Z"},
          {"kind": "weekly_scoped", "percent": 40, "scope": {"model": {"display_name": "Fable"}}, …}, …]}

Both give the all-models week; per window the reading kept is the higher figure for the same reset (use only grows
inside a window), else the later reset, as the status line's writer keeps it.
"""
import datetime as dt
import json
import os
import re
import stat

_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "ccprobe")
PATH = os.path.join(_DIR, "rate-limits.json")
USAGE_PATH = os.path.join(_DIR, "plan-usage.json")
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
    """{"seen", "windows": [{key, label, used, resets_at, span, seen, src}]} from the status line's saved object, or None
    with no window."""
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
                    "resets_at": _when(w.get("resets_at")), "seen": seen, "src": "status line"})
    out.sort(key=_order)
    return {"seen": seen, "windows": out} if out else None


def _name(row):
    """A scoped row's label as the server gives it: its model's ("Fable"), else its surface's; None without one."""
    sc = row.get("scope")
    for part in (sc.get("model"), sc.get("surface")) if isinstance(sc, dict) else ():
        nm = part.get("display_name") if isinstance(part, dict) else None
        if isinstance(nm, str) and nm.strip():
            return " ".join(nm.split())[:40]
    return None


def parse_usage(d):
    """The windows in the usage endpoint's rows (plan-usage.json), as parse gives them: `weekly_all` is the week,
    `session` the 5-hour one, `weekly_scoped` a model's own week (key `seven_day_fable`, label `week · Fable`)."""
    rows, seen = (d.get("limits"), _num(d.get("fetched_at"))) if isinstance(d, dict) else (None, None)
    if not isinstance(rows, list) or seen is None:
        return []
    out = []
    for r in rows:
        used = _num(r.get("percent")) if isinstance(r, dict) else None
        if used is None:
            continue
        kind = r.get("kind")
        if kind == "weekly_all":
            key, label, span = "seven_day", "week", 7 * DAY
        elif kind == "session":
            key, label, span = "five_hour", "5-hour", 5 * HOUR
        elif kind == "weekly_scoped" and _name(r):
            nm = _name(r)
            key, label, span = "seven_day_" + (re.sub(r"[^a-z0-9]+", "_", nm.lower()).strip("_") or "model"), f"week · {nm}", 7 * DAY
        else:
            continue
        rs = _when(r.get("resets_at"))     # 14:59:59.86 as sent: to the minute, so it reads as the week's 15:00
        out.append({"key": key, "label": label, "span": span, "used": max(0.0, min(used, 100.0)),
                    "resets_at": round(rs / 60) * 60.0 if rs else rs, "seen": seen, "src": "usage"})
    return out


def _order(w):
    return ({"five_hour": 0, "seven_day": 1}.get(w["key"], 2), w["key"])


def merge(*lists):
    """One reading per window: for the same reset (an hour apart at most: the endpoint's time has fractions) the higher
    figure, seen as of the newer reading; else the one with the later reset."""
    by = {}
    for w in (w for ws in lists for w in ws):
        o = by.get(w["key"])
        if o is None:
            by[w["key"]] = w
        elif o["resets_at"] and w["resets_at"] and abs(o["resets_at"] - w["resets_at"]) < HOUR:
            top = w if w["used"] > o["used"] or (w["used"] == o["used"] and w["seen"] > o["seen"]) else o
            by[w["key"]] = {**top, "seen": max(o["seen"], w["seen"])}
        elif (w["resets_at"] or 0) > (o["resets_at"] or 0):
            by[w["key"]] = w
    return sorted(by.values(), key=_order)


def _load(path):
    """(the file's key for the cache, its JSON, its time), or (None, None, None): no file, too big, not JSON."""
    try:
        st = os.stat(path)
    except OSError:
        return None, None, None
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES:
        return None, None, None
    try:
        with open(path) as f:
            return (st.st_mtime_ns, st.st_size), json.load(f), st.st_mtime
    except (OSError, ValueError):
        return (st.st_mtime_ns, st.st_size), None, st.st_mtime


def _stat_key(path):
    try:
        st = os.stat(path)
        return st.st_mtime_ns, st.st_size, stat.S_ISREG(st.st_mode)
    except OSError:
        return None


def read(path=None, usage_path=None):
    """The latest reading, {"seen", "windows"}, or None with no window. Parsed again only when a file changes."""
    path, usage_path = path or PATH, usage_path or USAGE_PATH
    key = (path, _stat_key(path), usage_path, _stat_key(usage_path))
    if _cache["key"] != key:
        _, d, seen = _load(path)
        sl = parse(d, seen) if d is not None else None
        _, u, _ = _load(usage_path)
        ws = merge(sl["windows"] if sl else [], parse_usage(u))
        _cache["key"], _cache["value"] = key, ({"seen": max(w["seen"] for w in ws), "windows": ws} if ws else None)
    return _cache["value"]
