"""One collector tick: sessions + transcripts + WTS → the JSON model the page draws (DESIGN.md §10)."""
import glob
import hashlib
import json
import os
import re
import threading
import time

from . import alerts as alerts_mod
from . import sessions as sessions_mod
from . import wts as wts_mod
from .agents import Transcript, agent_state, lead_state, read_meta
from .redact import clip, redact

VERSION = "1.0.0"
MAIN_BACKFILL, MAIN_MAX = 8 << 20, 64 << 20
AGENT_BACKFILL, AGENT_MAX = 2 << 20, 32 << 20
HISTORY_S = 2 * 3600            # how far back a transcript is read on first sight (time-based, capped in bytes)
RE_TASK = re.compile(r"^(?:Task|MP|LP|HP)\s*#?(\d{1,4})\s*:")      # "Task 74: Part 5 rebuild" (anchored: audit minor 4)
RE_NAME_TASK = re.compile(r"^(?:mp|lp|hp|task)(\d{1,4})$", re.I)    # meta.name "mp111"
RE_HP_NAME = re.compile(r"^hp(\d{1,4})$", re.I)                      # the HP worker, one fresh agent per task: "hp154"
RE_WHO_ROW = re.compile(r"^(?:MP|LP|HP|task)\s*(\d{1,4})\b", re.I)
HOT_S = 60
DEAD_KEEP_S = 600
LIVE = ("running", "thinking", "polling", "waiting_window")


class Collector:
    def __init__(self, window_s=6 * 3600, ctx_max=1_000_000):
        self.window_s = window_s
        self.ctx_max = ctx_max
        self.tmux = sessions_mod.Tmux()
        self.trs = {}            # transcript path -> Transcript
        self.metas = {}          # meta path -> (mtime, dict)
        self.dead_since = {}     # session id -> first time seen dead
        self.mem = alerts_mod.Memory()
        self.lock = threading.Lock()
        self.model = None
        self.digest = None
        self._json, self._json_for = None, None
        self.started = time.time()
        self.stopping = False
        self.changed = threading.Event()
        self.last_error = None

    # --- the tick -------------------------------------------------------------------------------------------
    def tick(self):
        t0 = time.time()
        now = t0
        out = []
        for s in sessions_mod.discover(self.tmux):
            sid = s.get("sessionId") or str(s["pid"])
            if not s["alive"]:
                first = self.dead_since.setdefault(sid, now)
                if now - first > DEAD_KEEP_S:
                    continue
            else:
                self.dead_since.pop(sid, None)
            if not os.path.exists(s["transcript"]):
                found = glob.glob(os.path.join(sessions_mod.CLAUDE, "projects", "*", f"{sid}.jsonl"))
                if found:   # the projects-dir name rule did not hold (long paths are hashed): find it by session id
                    s["transcript"] = found[0]
                    s["subagents"] = os.path.join(found[0][:-6], "subagents")
            try:
                out.append(self.session_model(s, now))
            except Exception as e:  # one broken session must not blank the others
                out.append({"id": sid, "pid": s["pid"], "alive": s["alive"], "project": os.path.basename(s["cwd"]),
                            "cwd": s["cwd"], "error": f"{type(e).__name__}: {e}", "agents": [], "edges": [],
                            "messages": [], "events": {}, "lead": None, "wts": None, "status": s.get("status"),
                            "tmux": s.get("tmux"), "version": s.get("version"), "status_since": 0})
        rank = lambda x: -sum(1 for a in [x.get("lead") or {}] + (x.get("agents") or []) if (a.get("state") or {}).get("key") in LIVE)
        out.sort(key=lambda x: (not x.get("alive"), rank(x), x.get("project") or ""))
        alerts = alerts_mod.compute(out, now, self.mem)
        unknown, stats = {}, {"decode_errors": 0, "big_lines": 0, "skipped": 0}
        for tr in self.trs.values():
            for k, v in tr.unknown.items():
                unknown[k] = unknown.get(k, 0) + v
            for k in stats:
                stats[k] += tr.tail.stats.get(k, 0)
        model = {
            "v": 1, "now": now,
            "server": {"version": VERSION, "started": self.started, "tick_ms": 0, "window_s": self.window_s,
                       "history_s": HISTORY_S, "error": self.last_error, "parser": dict(stats, unknown_types=unknown)},
            "sessions": out, "alerts": alerts,
        }
        # the change hash leaves out the clock, so an idle system pushes nothing new (audit minor 7)
        body = json.dumps({"s": out, "a": alerts}, sort_keys=True, default=str)
        digest = hashlib.sha1(re.sub(r'"(now|since)": [0-9.]+', "", body).encode()).hexdigest()
        model["server"]["tick_ms"] = round((time.time() - t0) * 1000)
        with self.lock:
            self.model = model
            self.digest = digest
        self._gc()
        return model

    def snapshot(self):
        with self.lock:
            return self.model, self.digest

    def snapshot_json(self):
        """The current model as JSON, serialized once per tick however many clients ask (None before the first tick)."""
        with self.lock:
            if self.model is None:
                return None
            if self._json_for is not self.model:
                self._json, self._json_for = json.dumps(self.model, default=str), self.model
            return self._json

    # --- transcripts ----------------------------------------------------------------------------------------
    def transcript(self, path, backfill, max_backfill):
        tr = self.trs.get(path)
        if tr is None:
            tr = self.trs[path] = Transcript(path, backfill, since=time.time() - HISTORY_S, max_backfill=max_backfill)
        tr.update()
        tr.seen_at = time.time()
        return tr

    def meta(self, path):
        try:
            mt = os.path.getmtime(path)
        except OSError:
            return {}
        hit = self.metas.get(path)
        if hit and hit[0] == mt:
            return hit[1]
        d = read_meta(path)
        self.metas[path] = (mt, d)
        return d

    def _gc(self):
        cutoff = time.time() - 120
        for p in [p for p, tr in self.trs.items() if getattr(tr, "seen_at", 0) < cutoff]:
            del self.trs[p]

    # --- one session ----------------------------------------------------------------------------------------
    def session_model(self, s, now):
        sid = s.get("sessionId") or str(s["pid"])
        main = self.transcript(s["transcript"], MAIN_BACKFILL, MAIN_MAX) if os.path.exists(s["transcript"]) else None
        w = wts_mod.read(s["cwd"]) if wts_mod.is_project(s["cwd"]) else None
        wok = bool(w and not w.get("error"))
        rows = {}
        if wok:
            for pri, rs in w["groups"].items():
                for r in rs:
                    rows[r["n"]] = dict(r, group=pri)
        lock_name = os.path.basename(w["lock_path"]) if wok and w.get("lock_path") else None

        # every agent file (stat only); the ones in view get tailed
        cands = []
        try:
            with os.scandir(s["subagents"]) as it:
                for e in it:
                    if e.name.startswith("agent-") and e.name.endswith(".jsonl"):
                        st = e.stat()
                        cands.append({"id": e.name[6:-6], "path": e.path, "mtime": st.st_mtime,
                                      "birth": getattr(st, "st_birthtime", st.st_mtime),
                                      "meta": self.meta(e.path[:-6] + ".meta.json")})
        except OSError:
            pass
        cands.sort(key=lambda c: c["birth"])
        latest_by_name = {}
        for c in cands:
            if c["meta"].get("name"):
                latest_by_name[c["meta"]["name"]] = c["id"]
        # the HP worker: the agent named for the running HP task, else the newest hp<N> (or a "worker" from before the
        # skill named them by task); every other HP agent is retired
        hp_running = None
        if wok:
            m = re.match(r"running\s+(\d+)", w.get("state_file") or "")
            hp_running = int(m.group(1)) if m else None
        worker_id = None
        if wok:
            worker_id = latest_by_name.get(f"hp{hp_running}") if hp_running is not None else None
            if not worker_id:
                hp_named = [c for c in cands if _is_worker_name(c["meta"].get("name"))]
                worker_id = hp_named[-1]["id"] if hp_named else None
        in_view = [c for c in cands if now - c["mtime"] <= self.window_s or c["id"] == worker_id]
        trs = {c["id"]: self.transcript(c["path"], AGENT_BACKFILL, AGENT_MAX) for c in in_view}
        ids = set(trs)

        # row binding: the HP worker by the state file; others by name ("mp111"), anchored description, own writes
        task_of = {}
        for c in in_view:
            aid, meta = c["id"], c["meta"]
            n = hp_running if aid == worker_id and meta.get("name") == "worker" else None   # an hp<N> says its own task
            for rx, src in ((RE_NAME_TASK, meta.get("name") or ""), (RE_TASK, meta.get("description") or "")):
                if n is None:
                    mm = rx.match(src)
                    n = int(mm.group(1)) if mm else None
            if n is None and trs[aid].qstate:
                n = trs[aid].qstate[-1]["n"]
            if n is not None and n in rows:
                task_of[aid] = n
        agent_of_row = {}
        for c in in_view:                     # newest agent wins a row; the worker always keeps its HP row
            n = task_of.get(c["id"])
            if n is not None and agent_of_row.get(n) != worker_id:
                agent_of_row[n] = c["id"]
        for aid in list(task_of):
            if agent_of_row.get(task_of[aid]) != aid:
                task_of.pop(aid)

        # the window holder: whoever last wrote the literal start of the current `who` text (audit M1)
        win = w["window"] if wok else {}
        holder = None
        if win.get("held"):
            holder = _holder(win.get("who") or "", main, trs, task_of, latest_by_name, worker_id)

        def resolve(to):
            if not to:
                return None
            if to in ("main", "lead"):
                return "lead"
            if to in ids:
                return to
            aid = latest_by_name.get(to)
            return aid if aid in ids else None

        # messages: sends (exact ids from the result when the target was revived), hand-backs (to whoever received
        # them, falling back to the parent) and spawns
        recv_handback = []          # (t, receiver, sender id)
        for rid, tr in ([("lead", main)] if main else []) + list(trs.items()):
            for r in tr.received:
                if r["handback"] and r["sender"]:
                    recv_handback.append((r["t"], rid, r["sender"]))
        parent_of = {c["id"]: (c["meta"].get("parentAgentId") if c["meta"].get("parentAgentId") in ids else "lead") for c in in_view}
        msgs = []
        for src, tr in ([("lead", main)] if main else []) + list(trs.items()):
            for m in tr.messages:
                if now - m["t"] > self.window_s:
                    continue
                if m["kind"] == "send":
                    to = m.get("to_id") if m.get("to_id") in ids else resolve(m["to"])
                else:
                    near = [(t - m["t"], r) for (t, r, snd) in recv_handback if snd == src and 0 <= t - m["t"] <= 600]
                    to = min(near)[1] if near else parent_of.get(src, "lead")
                if to and (to == "lead" or to in ids) and to != src:
                    msgs.append({"id": f"{src}>{to}@{m['t']:.3f}", "t": m["t"], "from": src, "to": to, "kind": m["kind"],
                                 "summary": m["summary"]})
        for c in in_view:
            msgs.append({"id": f"{parent_of[c['id']]}>{c['id']}@spawn", "t": c["birth"], "from": parent_of[c["id"]], "to": c["id"],
                         "kind": "spawn", "summary": clip(redact(c["meta"].get("description") or ""), 80)})
        msgs = sorted((m for m in msgs if now - m["t"] <= self.window_s), key=lambda m: m["t"])[-200:]

        talked = {}                 # agent -> last time it sent or got a message (spawns aside)
        for m in msgs:
            if m["kind"] != "spawn":
                for x in (m["from"], m["to"]):
                    talked[x] = max(talked.get(x, 0), m["t"])

        names = {c["id"]: c["meta"].get("name") for c in in_view}
        stopped = {}                # agent id -> (when, by whom) it was stopped with TaskStop
        for src, tr in ([("lead", main)] if main else []) + list(trs.items()):
            for tid, t in tr.stops.items():
                if tid in ids and t > stopped.get(tid, (0, None))[0]:
                    stopped[tid] = (t, src)

        agents = []
        for c in in_view:
            aid, meta, tr = c["id"], c["meta"], trs[c["id"]]
            n = task_of.get(aid)
            row = rows.get(n) if n is not None else None
            row_open = (row["kind"] in wts_mod.OPEN) if row else None
            st = agent_state(tr, now, alive=s["alive"], lock_name=lock_name, is_holder=holder == aid, row_open=row_open,
                             row_waits_window=bool(row and "waiting for the window" in row["status"]),
                             recently_messaged=bool(tr.bg_pending) or now - talked.get(aid, 0) < 1800)
            stop_t, stopper = stopped.get(aid, (0, None))
            if stop_t and tr.last_ts <= stop_t + 5 and st["key"] != "dead":   # nothing since the stop: it was not woken again
                by = "the lead" if stopper == "lead" else (names.get(stopper) or "another agent")
                st = {"key": "ended", "label": f"stopped by {by}", "since": stop_t, "detail": "", "sub": "stopped"}
            # a row paused or parked on purpose: an agent that is not at work there is paused, whatever its last turn said
            if row and row["kind"] in ("paused", "parked") and st["key"] in ("ended", "stuck", "unknown") and st.get("sub") != "stopped":
                st = {"key": "parked", "label": "paused", "since": st["since"], "detail": "its row says so"}
            if holder == aid and st["key"] in ("running", "polling", "waiting_window"):
                st = dict(st, key="running", label="holds the window · " + _dur(now - (win.get("since") or now)))
            role = "worker" if aid == worker_id else (row["group"].lower() if row and row["group"] in ("MP", "LP") else "helper")
            label = meta.get("name") or _short_desc(meta.get("description")) or aid[:7]
            hp = RE_HP_NAME.match(meta.get("name") or "")
            if role in ("mp", "lp") and n is not None:
                label = f"{role.upper()} {n}"
            elif hp:
                label = f"HP {int(hp.group(1))}"
            # a fresh agent per task: an older holder of a name, or an HP worker that is not the current one, is retired
            # once its turn has ended
            superseded = bool(meta.get("name")) and latest_by_name.get(meta["name"]) != aid
            retired = superseded or (_is_worker_name(meta.get("name")) and wok and aid != worker_id)
            if superseded:
                label = f"{meta['name']} (earlier)"
            finished = st["key"] == "dead" or (st["key"] == "ended" and (retired or st.get("sub") == "stopped" or (st.get("sub") == "done" and now - st["since"] > 120)))
            agents.append({
                "id": aid, "name": meta.get("name"), "label": label, "desc": clip(redact(meta.get("description") or ""), 120),
                "role": role, "task": n, "task_title": row["title"] if row else None, "group": row["group"] if row else None,
                "parent": parent_of[aid], "depth": meta.get("spawnDepth") or 1, "model": tr.model or meta.get("model"),
                "state": st, "ctx": tr.ctx, "ctx_max": self.ctx_max, "said": tr.said, "recent": list(tr.recent),
                "last_ts": tr.last_ts, "born": c["birth"], "finished": finished,
                "qstate": list(tr.qstate)[-3:], "compactions": [x[0] for x in tr.compactions if now - x[0] <= self.window_s],
                "talked": talked.get(aid, 0), "anchor": None,
            })
        by_id = {a["id"]: a for a in agents}

        # anchors: a helper sits beside the agent it talks to most (not the lead), else its parent
        for a in agents:
            if a["role"] != "helper":
                continue
            count = {}
            for m in msgs:
                if m["kind"] == "send" and a["id"] in (m["from"], m["to"]):
                    other = m["to"] if m["from"] == a["id"] else m["from"]
                    if other != "lead":
                        count[other] = count.get(other, 0) + 1
            a["anchor"] = max(count, key=count.get) if count else (a["parent"] if a["parent"] != "lead" else None)

        # edges: parent→child, plus a message edge for every pair that talked; hot when a message crossed it lately,
        # or when the child is busy on what its parent last sent it
        edges = {}
        last_from = {}
        for m in msgs:
            last_from[m["to"]] = m["from"]
        for a in agents:
            key = _ekey(a["parent"], a["id"])
            busy = a["state"]["key"] in ("running", "thinking", "polling")
            kind = "task" if busy and last_from.get(a["id"]) == a["parent"] or (a["role"] == "worker" and busy) else "spawn"
            edges[key] = {"key": key, "from": a["parent"], "to": a["id"], "kind": kind, "hot": kind == "task", "last": 0}
        for m in msgs:
            if m["kind"] == "spawn":
                continue
            key = _ekey(m["from"], m["to"])
            e = edges.setdefault(key, {"key": key, "from": m["from"], "to": m["to"], "kind": "msg", "hot": False, "last": 0})
            e["last"] = max(e["last"], m["t"])
            if now - m["t"] <= HOT_S:
                e["hot"] = True

        wpub = None
        if w:
            wpub = {k: v for k, v in w.items() if k != "lock_path"}
            wpub["lock_name"] = lock_name
            if wok:
                wpub["window"] = dict(win, who=redact(win.get("who") or "") or None, holder=holder,
                                      waiters=[a["id"] for a in agents if a["state"]["key"] == "waiting_window"])
                wpub["groups"] = {g: [dict(r, agent=agent_of_row.get(r["n"])) for r in rs] for g, rs in w["groups"].items()}

        lead = {"state": lead_state(main, s, now), "ctx": main.ctx if main else 0, "ctx_max": self.ctx_max,
                "model": main.model if main else None, "said": main.said if main else "",
                "recent": list(main.recent) if main else [], "last_ts": main.last_ts if main else 0,
                "compactions": [x[0] for x in main.compactions if now - x[0] <= self.window_s] if main else [],
                "limit": main.limit if main else None}
        if holder == "lead" and lead["state"]["key"] in ("waiting_user", "idle", "running", "thinking"):
            lead["holds_window"] = True

        events = {}
        t0 = now - self.window_s
        if main:
            events["lead"] = main.events_since(t0)
        for aid, tr in trs.items():
            events[aid] = tr.events_since(t0)

        return {
            "id": sid, "pid": s["pid"], "alive": s["alive"], "name": s.get("name"), "project": os.path.basename(s["cwd"].rstrip("/")),
            "cwd": s["cwd"], "title": (main.title if main else None) or _pane_title(s), "version": s.get("version"),
            "status": s.get("status") if s["alive"] else "dead", "status_since": (s.get("statusUpdatedAt") or 0) / 1000,
            "started": (s.get("startedAt") or 0) / 1000, "tmux": s["tmux"], "perm_mode": main.perm_mode if main else None,
            "has_transcript": main is not None, "history_from": now - HISTORY_S,
            "lead": lead, "agents": agents, "edges": list(edges.values()), "messages": msgs, "events": events, "wts": wpub,
        }


def _dur(s):
    s = int(max(0, s))
    return f"{s}s" if s < 60 else f"{s // 60}m" if s < 3600 else f"{s // 3600}h {s % 3600 // 60}m"


def _ekey(a, b):
    return "~".join(sorted((a, b)))


def _short_desc(d):
    d = (d or "").strip()
    return d if len(d) <= 22 else d[:21] + "…"


def _pane_title(s):
    t = (s.get("tmux") or {}).get("title") or ""
    return re.sub(r"^[^\w]+", "", t).strip() or None


def _is_worker_name(name):
    return name == "worker" or bool(RE_HP_NAME.match(name or ""))


def _holder(who, main, trs, task_of, by_name, worker_id=None):
    """The node holding the lock: the transcript that last wrote the literal start of `who` (audit M1), then fallbacks."""
    who = who.strip()
    best, best_t = None, 0
    for nid, tr in ([("lead", main)] if main else []) + list(trs.items()):
        for t, prefix in tr.who_writes:
            if who.startswith(prefix) and t > best_t:
                best, best_t = nid, t
    if best:
        return best
    low = who.lower()
    if low.startswith("lead"):
        return "lead"
    first = low.split()[0] if low.split() else ""
    if first == "worker" and worker_id in trs:      # the worker's scripts still write "worker …": the current HP worker
        return worker_id
    if by_name.get(first) in trs:                 # "worker capture …" → the agent named worker
        return by_name[first]
    m = RE_WHO_ROW.match(who)
    if m:
        n = int(m.group(1))
        for aid, k in task_of.items():
            if k == n:
                return aid
    return None
