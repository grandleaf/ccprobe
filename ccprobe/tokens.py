"""Token statistics: every API reply in a transcript, counted once, over the whole file.

The tailer (tail.py) reads only a transcript's last hours, but totals need every reply since the session began. So a
Ledger reads each file forward from its start, once, and from then on only what the file gains. Only lines that
carry a usage object are decoded (a 1 GB transcript holds about 15k of them), so several GB are counted in seconds.

Claude Code writes one reply as one entry per content block, all with the same message id and usage: the last one
wins. A tool result that quotes a usage object (an Agent tool's summary) is a `user` entry and is not counted, so a
subagent's tokens are counted once, in its own file.

Books keeps the ledgers and reads them on its own thread, so a first count of a big session never slows the tick.
"""
import collections
import glob
import json
import os
import re
import threading
import time
from datetime import datetime

from .agents import ts_of

KINDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
NEEDLE = b'"usage":{'
ASSISTANT = b'"type":"assistant"'
COMPACT = b'"subtype":"compact_boundary"'
CHUNK = 32 << 20                  # bytes read per step
MAX_DECODE = 8 << 20              # longer reply lines are not decoded whole: their usage object is cut out
MAX_BUFFER = 64 << 20             # an unfinished line longer than this is dropped (read on to its end)
SERIES_S = 6 * 3600 + 600         # per-minute buckets kept: the timeline's longest span (6h)
RECENT_IDS = 256                  # message ids remembered, to replace a reply's earlier entries
STEP_S = 3.0                      # how often the books thread looks for new bytes
GLOB_S = 60.0                     # how often it looks for transcripts written today
DROP_S = 600.0                    # a ledger nobody asked for this long (and not written today) is dropped
RE_MSG_ID = re.compile(rb'"id":"(msg_[A-Za-z0-9_]+)"')
RE_TS = re.compile(rb'"timestamp":"([0-9T:.\-Z+]+)"')
# a write to a WTS row's State (`queue.py … state 119 --text "done $(date +%H:%M): …"`, or the skill's `Q state …`)
RE_QWRITE = re.compile(r"\bstate\s+(\d{1,4})\s+--text\s+[\"']?\W*?(in progress|in hand|done|paused|parked|queued|waiting|on hold|hold|needs the user)\b", re.I)


def day_of(t):
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d")


def midnight(now=None):
    d = datetime.fromtimestamp(now or time.time())
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def add(a, b, sign=1):
    for i in range(4):
        a[i] += sign * b[i]


class Ledger:
    """One transcript's token totals, read forward incrementally."""

    def __init__(self, path):
        self.path = path
        self.reset(None)

    def reset(self, ino):
        self.ino = ino
        self.offset = 0
        self.size = 0
        self.partial = b""
        self.discarding = False
        self.total = [0, 0, 0, 0]          # input, cache write, cache read, output (thinking included)
        self.replies = 0
        self.compactions = 0
        self.model = None
        self.first = self.last = None      # the first and last reply's time (how long an agent worked)
        self.qwrites = set()               # (time, row, what) for each write to a WTS row's State
        self.minutes = {}                  # minute start -> [4], the last SERIES_S only
        self.days = {}                     # local date -> [4]
        self.day_replies = collections.Counter()
        self.recent = collections.OrderedDict()   # message id -> (vec, minute, day)
        self.done = False                  # has reached the file's end at least once

    def behind(self):
        return max(0, self.size - self.offset)

    def read(self, lock, max_bytes=None):
        """Read what the file gained (up to max_bytes); the numbers change under `lock`. Returns the bytes read."""
        try:
            st = os.stat(self.path)
        except OSError:
            self.done = True               # nothing to count (yet)
            return 0
        if self.ino is None or st.st_ino != self.ino or st.st_size < self.offset:
            with lock:
                self.reset(st.st_ino)      # first sight, replaced or truncated: count again from the start
        self.size = st.st_size
        got = 0
        try:
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                while self.offset < self.size and (max_bytes is None or got < max_bytes):
                    data = f.read(min(CHUNK, self.size - self.offset))
                    if not data:
                        break
                    got += len(data)
                    with lock:
                        self.offset += len(data)
                        self._feed(data)
        except OSError:
            return got
        if self.offset >= self.size:
            self.done = True
        with lock:
            cut = (time.time() - SERIES_S) // 60 * 60
            for m in [m for m in self.minutes if m < cut]:
                del self.minutes[m]
        return got

    def _feed(self, data):
        if self.discarding:
            nl = data.find(b"\n")
            if nl < 0:
                return
            data = data[nl + 1:]
            self.discarding = False
        buf = self.partial + data if self.partial else data
        end = buf.rfind(b"\n") + 1
        self.partial = buf[end:]
        if len(self.partial) > MAX_BUFFER:
            self.partial = b""
            self.discarding = True
        self.compactions += buf.count(COMPACT, 0, end)
        pos = 0
        while True:
            i = buf.find(NEEDLE, pos, end)
            if i < 0:
                break
            s = buf.rfind(b"\n", 0, i) + 1
            e = buf.find(b"\n", i, end)
            pos = e + 1
            line = buf[s:e]
            if ASSISTANT in line:
                try:
                    self._reply(line)
                except Exception:          # one odd line must never stop the count
                    pass

    def _reply(self, line):
        if len(line) > MAX_DECODE:
            d = _cut(line)
        else:
            try:
                d = json.loads(line)
            except ValueError:
                return
        if not isinstance(d, dict) or d.get("type") != "assistant":
            return
        msg = d.get("message") or {}
        u = msg.get("usage")
        if not isinstance(u, dict):
            return
        vec = [int(u.get(k) or 0) for k in KINDS]
        t = ts_of(d) or time.time()
        self.first = t if self.first is None else min(self.first, t)
        self.last = t if self.last is None else max(self.last, t)
        key = msg.get("id") or d.get("uuid")
        old = self.recent.pop(key, None) if key else None
        if old:
            self._add(*old, sign=-1)       # the same reply again: its last entry wins
        entry = (vec, int(t // 60 * 60), day_of(t))
        if not old:
            self.replies += 1
            self.day_replies[entry[2]] += 1
        self._add(*entry)
        if key:
            self.recent[key] = entry
            if len(self.recent) > RECENT_IDS:
                self.recent.popitem(last=False)
        for b in msg.get("content") if isinstance(msg.get("content"), list) else []:
            cmd = (b.get("input") or {}).get("command") if isinstance(b, dict) and b.get("type") == "tool_use" else None
            if isinstance(cmd, str) and "--text" in cmd:
                for m in RE_QWRITE.finditer(cmd):
                    self.qwrites.add((t, int(m.group(1)), m.group(2).lower()))
        if msg.get("model") and not str(msg["model"]).startswith("<"):
            self.model = msg["model"]

    def _add(self, vec, minute, day, sign=1):
        add(self.total, vec, sign)
        add(self.minutes.setdefault(minute, [0, 0, 0, 0]), vec, sign)
        add(self.days.setdefault(day, [0, 0, 0, 0]), vec, sign)


def _cut(line):
    """A reply line too long to decode: its usage object, message id and timestamp, cut out of the raw bytes."""
    i = line.find(NEEDLE) + len(NEEDLE) - 1
    depth, j = 0, i
    while j < len(line):
        c = line[j]
        if c == 0x7B:
            depth += 1
        elif c == 0x7D:
            depth -= 1
            if depth == 0:
                break
        j += 1
    u = json.loads(line[i:j + 1])
    mid, ts = RE_MSG_ID.search(line), RE_TS.search(line)
    return {"type": "assistant", "timestamp": ts.group(1).decode() if ts else None,
            "message": {"id": mid.group(1).decode() if mid else None, "usage": u}}


class Books:
    """Every ledger, read on one background thread. The collector says which files it shows (`want`); the books also
    count every transcript written today, for the all-sessions total."""

    def __init__(self, projects):
        self.projects = projects
        self.ledgers = {}
        self.wanted = {}                   # path -> last time the collector asked for it
        self.today_files = []
        self.next_glob = 0.0
        self.lock = threading.Lock()
        self.stopping = False

    def want(self, paths):
        now = time.time()
        with self.lock:
            for p in paths:
                self.wanted[p] = now
                if p not in self.ledgers:
                    self.ledgers[p] = Ledger(p)

    def get(self, path):
        return self.ledgers.get(path)

    def step(self):
        now = time.time()
        if now >= self.next_glob:
            self.next_glob = now + GLOB_S
            cut = midnight(now)
            files = glob.glob(os.path.join(self.projects, "*", "*.jsonl")) + \
                glob.glob(os.path.join(self.projects, "*", "*", "subagents", "agent-*.jsonl"))
            today = []
            for f in files:
                try:
                    if os.path.getmtime(f) >= cut:
                        today.append(f)
                except OSError:
                    pass
            with self.lock:
                self.today_files = today
                for p in today:
                    if p not in self.ledgers:
                        self.ledgers[p] = Ledger(p)
                keep = set(today) | {p for p, t in self.wanted.items() if now - t < DROP_S}
                for p in [p for p in self.ledgers if p not in keep]:
                    del self.ledgers[p]
                    self.wanted.pop(p, None)
        # the files on screen first, so a session's numbers are ready before the all-sessions total
        with self.lock:
            order = sorted(self.ledgers.values(), key=lambda L: (self.wanted.get(L.path, 0) < now - 30, L.path))
        for L in order:
            if self.stopping:
                return
            L.read(self.lock)

    def run(self):
        while not self.stopping:
            t0 = time.time()
            try:
                self.step()
            except Exception:              # try again next step
                pass
            time.sleep(max(0.5, STEP_S - (time.time() - t0)))

    def start(self):
        th = threading.Thread(target=self.run, name="books", daemon=True)
        th.start()
        return th

    def today(self):
        """All transcripts written today: the totals since local midnight, and whether every file has been read."""
        day = day_of(time.time())
        v, n, ready = [0, 0, 0, 0], 0, True
        with self.lock:
            today = set(self.today_files)
            for L in self.ledgers.values():
                if L.path in today or day in L.days:
                    add(v, L.days.get(day, [0, 0, 0, 0]))
                    n += L.day_replies.get(day, 0)
                    ready = ready and L.done
        return {"day": day, "v": v, "n": n, "ready": ready}
