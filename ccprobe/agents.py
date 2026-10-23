"""Transcript reducer: folds new JSONL entries into what ccprobe shows (state, tools, messages, context).

The state rules follow DESIGN.md §5.5 as revised by the audit (docs/advice/design-audit.md B1–B3, M1):
only conversational entries move `last_kind`; a hand-back's own tool_result is not news; text ends a turn only with
stop_reason "end_turn"; received messages are `user` entries with a top-level `origin` or `queued_command` attachments.
"""
import collections
import json
import os
import re
import time
from datetime import datetime

from .redact import clip, redact
from .tail import Tailer

RE_NOTIFY_ID = re.compile(r"<tool-use-id>(toolu_[A-Za-z0-9_]+)</tool-use-id>")
RE_QSTATE = re.compile(r"queue\.py\b[^|;&\n]*?\bstate\s+(\d+)\s+--text\s+[\"']([^\"'`]{0,80})")
RE_POLL = re.compile(r"\b(until|while)\b")
# `echo "art-advisor round0 captures $(date)" > .autopilot/app.lock/who`: the literal part names the lock holder
RE_WHO = re.compile(r"""(?:echo|printf)\s+(?:-\w+\s+)*(["'])((?:(?!\1).){2,200}?)\1\s*>>?\s*[^\s;&|]*/who\b""")
HOME = os.path.expanduser("~")
QUIET_S = 180          # thinking → "quiet" after this long without a conversational entry or a model call
STUCK_S = 600          # → "stuck?" after this long


ASK_TOOLS = ("AskUserQuestion", "ExitPlanMode")   # tools that leave the lead waiting on the user

def ts_of(d):
    t = d.get("timestamp")
    if not t:
        return None
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def first_line(text, n=200):
    for line in str(text).splitlines():
        line = line.strip()
        if line:
            return clip(redact(line.replace("**", "")), n)
    return ""


def tool_arg(name, inp):
    if not isinstance(inp, dict):
        return ""
    if name == "SendMessage":
        a = inp.get("summary") or inp.get("message") or ""
    elif name == "Agent":
        a = inp.get("description") or ""
    else:
        a = (inp.get("command") or inp.get("file_path") or inp.get("description") or inp.get("pattern")
             or inp.get("url") or inp.get("query") or inp.get("prompt") or "")
    return clip(redact(" ".join(str(a).split())).replace(HOME, "~"), 110)


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


class Transcript:
    """One transcript (a session's main one, or an agent's), reduced incrementally."""

    def __init__(self, path, backfill, since=None, max_backfill=None):
        self.tail = Tailer(path, backfill, since=since, max_backfill=max_backfill)
        self.pending = {}                      # tool_use_id -> {name, arg, cmd, t, timeout}
        self.handbacks = set()                 # tool_use ids of SubagentHandback calls (their results are not news)
        self.bg_pending = {}                   # background Bash tool_use_id -> start time
        self.last_ts = 0.0                     # newest conversational entry's own timestamp
        self.last_activity = 0.0               # newest conversational entry or model call (api-request)
        self.last_kind = None                  # tool | handback | end | text | result | received | user | turn_end
        self.ctx = 0
        self.model = None
        self.said = ""
        self.recent = collections.deque(maxlen=8)
        self.events = collections.deque(maxlen=1500)      # (t, tool)
        self.messages = collections.deque(maxlen=200)     # {t, kind: send|handback, to, to_id, summary, tid}
        self.received = collections.deque(maxlen=200)     # {t, kind, from, sender, handback}
        self.qstate = collections.deque(maxlen=20)        # {t, n, head, id, error}
        self.who_writes = collections.deque(maxlen=10)    # (t, literal prefix written to <lock>/who)
        self.stops = {}                        # task or agent id -> when this transcript stopped it (TaskStop)
        self.compactions = collections.deque(maxlen=50)   # (t, pre, post)
        self.limit = None                      # {"since": t, "text": …} while a usage limit holds
        self.title = None
        self.perm_mode = None
        self.unknown = collections.Counter()

    def update(self):
        entries = self.tail.read()
        for d in entries:
            try:
                self.apply(d)
            except Exception:              # one odd entry must never stop the tick
                self.unknown["apply-error"] += 1
        return bool(entries)

    # --- one entry ------------------------------------------------------------------------------------------
    KNOWN_IGNORED = {"queue-operation", "message", "mode", "last-prompt", "atis-latch", "frame-link", "bridge-session",
                     "artifact-autoreact-ledger", "artifact-comment-monitor", "file-history-snapshot", "file-history-delta",
                     "cost-state", "api-request-blob", "api-request-shape", "summary", "custom-title", "tag"}

    def _touch(self, t):
        self.last_ts = max(self.last_ts, t)
        self.last_activity = max(self.last_activity, t)

    def apply(self, d):
        typ = d.get("type")
        t = ts_of(d) or self.last_ts or time.time()
        if typ == "api-request":
            self.last_activity = max(self.last_activity, t)
        elif typ == "assistant":
            self._touch(t)
            self._assistant(d.get("message") or {}, t)
        elif typ == "user":
            self._user(d, t)
        elif typ == "attachment":
            att = d.get("attachment") or {}
            if att.get("type") == "queued_command":
                self._touch(t)
                self._received(att.get("origin") or {}, str(att.get("prompt") or ""), t)
        elif typ == "system":
            st = d.get("subtype")
            if st == "turn_duration":
                self._touch(t)
                self.last_kind = "turn_end"
            elif st == "compact_boundary":
                m = d.get("compactMetadata") or {}
                self.compactions.append((t, m.get("preTokens"), m.get("postTokens")))
            elif st == "informational":
                text = clip(str(d.get("content", "")), 160)
                low = text.lower()
                if "usage limit reached" in low:
                    self.limit = {"since": t, "text": text}
                elif "usage limit reset" in low:
                    self.limit = None
        elif typ == "ai-title":
            self.title = clip(str(d.get("aiTitle") or ""), 80) or self.title
        elif typ == "permission-mode":
            self.perm_mode = d.get("permissionMode") or self.perm_mode
        elif typ not in self.KNOWN_IGNORED and typ is not None:
            self.unknown[str(typ)] += 1

    def _assistant(self, msg, t):
        if self.limit and t > self.limit["since"]:
            self.limit = None                  # a model reply after the notice: the limit is over
        u = msg.get("usage")
        if isinstance(u, dict):
            ctx = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
            if ctx:
                self.ctx = ctx
        self.model = msg.get("model") or self.model
        content = msg.get("content")
        if not isinstance(content, list):
            return
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text" and str(c.get("text", "")).strip():
                self.said = first_line(c["text"])
                # the writer emits one entry per block: text is a turn's end only when the message says so
                self.last_kind = "end" if msg.get("stop_reason") == "end_turn" else "text"
            elif c.get("type") == "tool_use":
                self._tool_use(c, t)

    def _tool_use(self, c, t):
        name, inp, tid = c.get("name") or "?", c.get("input") or {}, c.get("id")
        arg = tool_arg(name, inp)
        self.events.append((t, name))
        if name == "SubagentHandback":
            if tid:
                self.handbacks.add(tid)
            self.messages.append({"t": t, "kind": "handback", "to": None, "to_id": None,
                                  "summary": first_line(inp.get("message", ""), 140), "tid": tid})
            self.last_kind = "handback"
            return
        cmd = str(inp.get("command") or "") if name == "Bash" else ""
        bg = name == "Bash" and inp.get("run_in_background") in (True, "true")
        if tid and not bg:
            self.pending[tid] = {"name": name, "arg": arg, "cmd": cmd[:4000], "t": t,
                                 "timeout": _num(inp.get("timeout"), 120000) / 1000 if name == "Bash" else None}
        if bg and tid:
            self.bg_pending[tid] = t
        if name == "TaskStop" and inp.get("task_id"):
            self.stops[str(inp["task_id"])] = t
            if tid in self.pending:
                self.pending[tid]["stop"] = str(inp["task_id"])
        if name == "SendMessage":
            self.messages.append({"t": t, "kind": "send", "to": str(inp.get("to") or ""), "to_id": None, "summary": arg, "tid": tid})
        if cmd:
            m = RE_QSTATE.search(cmd)
            if m:
                self.qstate.append({"t": t, "n": int(m.group(1)), "head": m.group(2).strip(), "id": tid, "error": False})
            for w in RE_WHO.finditer(cmd):
                prefix = w.group(2).split("$(")[0].split("`")[0].strip()
                if len(prefix) >= 3:
                    self.who_writes.append((t, prefix))
        self.recent.append({"t": t, "tool": name, "arg": arg, "to": inp.get("to") if name == "SendMessage" else None})
        self.last_kind = "tool"

    def _user(self, d, t):
        origin = d.get("origin")
        content = (d.get("message") or {}).get("content")
        if isinstance(origin, dict) and origin.get("kind"):
            self._touch(t)
            self._received(origin, _text_of(content), t)
            return
        ids = d.get("_result_ids")
        errs = set()
        if ids is None:
            ids = []
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        ids.append(c.get("tool_use_id"))
                        if c.get("is_error") or "Error" in _text_of(c.get("content"))[:200]:
                            errs.add(c.get("tool_use_id"))
            elif isinstance(content, str) and content.strip() and not d.get("isMeta"):
                if d.get("isCompactSummary"):
                    return                       # a compaction's summary (even "compacted while idle"): the turn is where it was
                if content.lstrip().startswith("<local-command-stdout>"):
                    self.last_kind = "turn_end"  # a local slash command (/compact, /model …) is done: back to the user
                    return
                self._touch(t)
                self.last_kind = "user"          # a prompt typed into this session
        known = [i for i in ids if i in self.pending]
        res = d.get("toolUseResult") if isinstance(d.get("toolUseResult"), dict) else {}
        for i in known:
            p = self.pending.pop(i)
            if p.get("stop") and i in errs:
                self.stops.pop(p["stop"], None)      # the stop failed: nothing was stopped
            if p["name"] == "SendMessage" and res:
                rid = res.get("resumedAgentId") or res.get("revivedAgentId") or (res.get("pin") or {}).get("id")
                if rid:
                    for m in reversed(self.messages):
                        if m.get("tid") == i:
                            m["to_id"] = rid
                            break
        for q in self.qstate:
            if q["id"] in errs:
                q["error"] = True
        # a result for a call we never saw pending (a hand-back's, or one from before the backfill) is not news
        if known:
            self._touch(t)
            self.last_kind = "result"

    def _received(self, origin, text, t):
        kind = origin.get("kind")
        for tid in RE_NOTIFY_ID.findall(text):
            self.bg_pending.pop(tid, None)
        self.received.append({"t": t, "kind": kind, "from": origin.get("from"), "sender": origin.get("senderTaskId"),
                              "handback": bool(origin.get("handback"))})
        self.last_kind = "received"

    # --- reading the reduced state ----------------------------------------------------------------------------
    def oldest_pending(self):
        if not self.pending:
            return None
        return min(self.pending.values(), key=lambda p: p["t"])

    def events_since(self, t0, cap=600):
        ev = [[round(t, 1), n] for t, n in self.events if t >= t0]
        return ev[-cap:]


def _num(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _ladder(tr, now):
    quiet = now - (tr.last_activity or tr.last_ts or now)
    if quiet < QUIET_S:
        return {"key": "thinking", "label": "thinking", "since": tr.last_activity, "detail": ""}
    if quiet < STUCK_S:
        return {"key": "thinking", "label": f"thinking · quiet {_dur(quiet)}", "since": tr.last_activity, "detail": ""}
    return {"key": "stuck", "label": f"stuck? silent {_dur(quiet)}", "since": tr.last_activity, "detail": ""}


def pending_state(tr, now, lock_name, is_holder):
    """The state from the oldest pending tool call, or None when nothing is pending."""
    p = tr.oldest_pending()
    if not p:
        return None
    age = now - p["t"]
    lock_loop = p["name"] == "Bash" and lock_name and lock_name in p["cmd"] and RE_POLL.search(p["cmd"]) and "mkdir" in p["cmd"]
    if lock_loop and not is_holder:
        return {"key": "waiting_window", "label": "waiting for the window", "since": p["t"], "detail": p["arg"], "via": "loop"}
    if p["name"] == "Bash" and p.get("timeout") and age > p["timeout"] + 120:
        return {"key": "stuck", "label": f"stuck? Bash past its timeout · {_dur(age)}", "since": p["t"], "detail": p["arg"]}
    if p["name"] == "Bash" and not lock_loop and RE_POLL.search(p["cmd"]) and "sleep" in p["cmd"]:
        return {"key": "polling", "label": f"polling · {_dur(age)}", "since": p["t"], "detail": p["arg"]}
    return {"key": "running", "label": f"{p['name']} · {_dur(age)}", "since": p["t"], "detail": p["arg"]}


def agent_state(tr, now, *, alive=True, lock_name=None, is_holder=False, row_open=None, row_waits_window=False,
                recently_messaged=False):
    """{key, label, since, detail} for an agent; first rule that matches wins."""
    if not alive:
        return {"key": "dead", "label": "dead", "since": tr.last_ts, "detail": "its session has ended"}
    st = pending_state(tr, now, lock_name, is_holder)
    if st:
        return st
    ended = tr.last_kind in ("handback", "end", "turn_end")
    if ended and tr.bg_pending:
        return {"key": "ended_bg", "label": "waiting on its background job", "since": tr.last_ts, "detail": ""}
    if ended:
        if row_waits_window and not is_holder:
            return {"key": "waiting_window", "label": "waiting for the window", "since": tr.last_ts, "detail": "its row says so", "via": "row"}
        if row_open or (row_open is None and recently_messaged):
            return {"key": "ended", "label": "turn ended · waiting for a message", "since": tr.last_ts, "detail": "", "sub": "waiting"}
        return {"key": "ended", "label": "done", "since": tr.last_ts, "detail": "", "sub": "done"}
    if tr.last_kind is None:
        return {"key": "unknown", "label": "no recent entries", "since": tr.last_ts, "detail": ""}
    return _ladder(tr, now)


def lead_state(tr, session, now):
    """The lead from its own transcript (the registry's busy/idle is only a hint: audit B3)."""
    if not session.get("alive"):
        return {"key": "dead", "label": "session ended", "since": tr.last_ts if tr else 0, "detail": ""}
    if session.get("status") == "shell":
        return {"key": "shell", "label": "in a shell", "since": (session.get("statusUpdatedAt") or 0) / 1000, "detail": ""}
    if tr is None:
        return {"key": "unknown", "label": session.get("status") or "?", "since": 0, "detail": ""}
    p = tr.oldest_pending()
    asks = next((q for q in tr.pending.values() if q["name"] in ASK_TOOLS), None)
    if asks:                                   # a question or a plan left open for the user: really waiting for you
        what = "a plan for you to approve" if asks["name"] == "ExitPlanMode" else "a question for you"
        return {"key": "waiting_user", "label": "waiting for you", "since": asks["t"], "detail": what}
    if p:
        age = now - p["t"]
        st = pending_state(tr, now, None, False)
        if age > 60:
            st["detail"] = (st.get("detail") or "") + " (or waiting for your approval?)"
        return st
    if tr.last_kind in ("turn_end", "end", "handback"):      # its turn is over: idle until you write
        return {"key": "idle", "label": "idle", "since": tr.last_ts, "detail": ""}
    if tr.last_kind is None:
        return {"key": "idle" if session.get("status") == "idle" else "unknown",
                "label": "idle" if session.get("status") == "idle" else "no recent entries", "since": tr.last_ts, "detail": ""}
    return _ladder(tr, now)


def _dur(s):
    s = max(0, int(s))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    return f"{s // 3600}h {s % 3600 // 60}m"


def read_meta(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}
