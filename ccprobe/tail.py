"""Incremental JSONL tailer: reads only the bytes a file gained since the last call, never the whole file.

Claude Code transcripts reach 1 GB, so on first sight a file is read from `backfill` bytes before its end, and every
later call reads only what was appended. Entry types ccprobe never uses are dropped by their first bytes, undecoded.
"""
import json
import os
import re

MAX_DECODE = 8 * 1024 * 1024      # longer lines are not decoded; only their tool_result ids and timestamp are pulled out
MAX_BUFFER = 64 * 1024 * 1024     # an unfinished line longer than this is dropped (read on to its end, then resume)
MAX_READ = 32 * 1024 * 1024       # new bytes read per file per call; the rest waits for the next call
# top-level entry types ccprobe has no use for: these lines start with their type, so a prefix test is exact
SKIP_PREFIXES = tuple(b'{"type":"' + t for t in (b"api-request-blob", b"api-request-shape", b"file-history",
                                                   b"atis-latch", b"frame-link", b"artifact-", b"last-prompt",
                                                   b"mode\"", b"cost-state", b"bridge-session"))
# an api-request line means "a model call is in flight": keep only its timestamp (the best thinking signal there is)
API_REQUEST = b'{"type":"api-request"'
BACK_STEP = 4 * 1024 * 1024
RE_RESULT_ID = re.compile(rb'"tool_use_id":"(toolu_[A-Za-z0-9_]+)"')
RE_TS = re.compile(rb'"timestamp":"([0-9T:.\-Z]+)"')
RE_SIDE = re.compile(rb'"type":"(user|assistant)"')


class Tailer:
    def __init__(self, path, backfill, since=None, max_backfill=None):
        self.path = path
        self.backfill = backfill          # bytes read before the end on first sight ...
        self.since = since                # ... or, with `since`, back to that time (up to max_backfill bytes)
        self.max_backfill = max_backfill or backfill
        self.ino = None
        self.offset = 0
        self.partial = b""
        self.discarding = False           # inside a line too long to buffer: skip to its end
        self.stats = {"decode_errors": 0, "big_lines": 0, "skipped": 0}

    def size(self):
        try:
            return os.stat(self.path).st_size
        except OSError:
            return 0

    def read(self):
        """New complete entries (dicts) since the last call; [] when the file is missing or unchanged."""
        try:
            st = os.stat(self.path)
        except OSError:
            return []
        if self.ino is None or st.st_ino != self.ino or st.st_size < self.offset:
            # first sight, replaced or truncated: start again from the tail, dropping the first (partial) line
            self.ino = st.st_ino
            self.offset = self._start(st.st_size)
            self.partial = b""
            self.discarding = self.offset > 0
        if st.st_size == self.offset:
            return []
        try:
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = f.read(min(st.st_size - self.offset, MAX_READ))
        except OSError:
            return []
        self.offset += len(data)
        if self.discarding:
            nl = data.find(b"\n")
            if nl < 0:
                return []
            data = data[nl + 1:]
            self.discarding = False
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()        # an unfinished last line waits for its end
        if len(self.partial) > MAX_BUFFER:
            self.partial = b""
            self.discarding = True
            self.stats["big_lines"] += 1
        out = []
        for line in lines:
            d = self.decode(line)
            if d is not None:
                out.append(d)
        return out

    def _start(self, size):
        """Where to start reading a file seen for the first time: `backfill` bytes from its end, or far enough back to
        reach `since` (whole 4 MB steps, at most `max_backfill`)."""
        pos = max(0, size - self.backfill)
        if self.since is None:
            return pos
        try:
            with open(self.path, "rb") as f:
                while pos > 0 and size - pos < self.max_backfill:
                    f.seek(pos)
                    m = RE_TS.search(f.read(256 * 1024))
                    if m and _epoch(m.group(1).decode()) < self.since:
                        break
                    pos = max(0, pos - BACK_STEP)
        except OSError:
            pass
        return max(pos, size - self.max_backfill, 0)

    def decode(self, line):
        if line.startswith(API_REQUEST):
            ts = RE_TS.search(line[:400])
            return {"type": "api-request", "timestamp": ts.group(1).decode()} if ts else None
        if not line or line.startswith(SKIP_PREFIXES):
            if line:
                self.stats["skipped"] += 1
            return None
        if len(line) > MAX_DECODE:
            # too big to decode cheaply (a tool result with images): keep only what the state rules need
            self.stats["big_lines"] += 1
            ts = RE_TS.search(line)
            side = RE_SIDE.search(line)
            return {"type": side.group(1).decode() if side else "user", "_big": True,
                    "timestamp": ts.group(1).decode() if ts else None,
                    "_result_ids": [m.decode() for m in RE_RESULT_ID.findall(line)]}
        try:
            d = json.loads(line)
        except ValueError:
            self.stats["decode_errors"] += 1
            return None
        return d if isinstance(d, dict) else None


def _epoch(iso):
    from datetime import datetime
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0
