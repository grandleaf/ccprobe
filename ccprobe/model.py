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
from . import tokens as tokens_mod
from . import wts as wts_mod
from .agents import Transcript, agent_state, lead_state, read_meta
from .redact import clip, redact

VERSION = "1.0.0"
MAIN_BACKFILL, MAIN_MAX = 8 << 20, 64 << 20
AGENT_BACKFILL, AGENT_MAX = 2 << 20, 32 << 20
HISTORY_S = 2 * 3600            # how far back a transcript is read on first sight (time-based, capped in bytes)
# "Task 74: Part 5 rebuild", "MP 141b: widgets", "HP 135 redo: …" (anchored at the start: audit minor 4). Only a
# letter suffix or a redo word may come before the colon: "MP 141 advisor:" is a helper's, "Task 2026-10-24 notes:" none
RE_AGAIN = r"[A-Za-z]?(?i:\s+\(?(?:(?:redo|retry|rerun|again|fix)(?:\s*#?\d+)?|(?:round|take|part)\s*#?\d+|v\d+)\)?)?\s*:"
RE_TASK = re.compile(r"^(?:Task|MP|LP|HP)\s*#?(\d{1,4})" + RE_AGAIN)
# a name may carry a round: a letter ("mp141b") or r<N> ("hp128r3", redo 3)
RE_NAME_TASK = re.compile(r"^(?:mp|lp|hp|task)(\d{1,4})(?:[a-z]|r\d{1,2})?$", re.I)    # meta.name "mp111"
RE_HP_NAME = re.compile(r"^hp(\d{1,4})(?:[a-z]|r\d{1,2})?$", re.I)       # the HP worker, one fresh agent per task: "hp154"
RE_HP_DESC = re.compile(r"^HP\s*#?(\d{1,4})" + RE_AGAIN)        # or, started without a name: "HP 163: …", "HP 135 redo: …"
RE_HP_DESC_NAME = re.compile(r"^hp(\d{1,4})(?:[a-z]|r\d{1,2})?\s*:", re.I)    # or described by the name it lacks: "hp178b: …"
RE_DESC_NAME = re.compile(r"^([a-z]+\d{1,4}(?:[a-z]|r\d{1,2})?)\s*:", re.I)   # a description led by an agent name
RE_WHO_ROW = re.compile(r"^(?:MP|LP|HP|task)\s*(\d{1,4})(?:[a-z]|r\d{1,2})?\b", re.I)   # "HP 183 …", "hp183c capture …"
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
        self.tr_lock = threading.Lock()   # held while a reducer changes; /api/agent reads one between updates
        self.where = {}          # (session id, agent id or "lead") -> (transcript path, project dir)
        self.model = None
        self.digest = None
        self._json, self._json_for = None, None
        self.started = time.time()
        self.stopping = False
        self.changed = threading.Event()
        self.last_error = None
        self.books = tokens_mod.Books(os.path.join(sessions_mod.CLAUDE, "projects"))   # token counts, on their own thread

    # --- the tick -------------------------------------------------------------------------------------------
    def tick(self):
        t0 = time.time()
        now = t0
        out = []
        self._sessions(out, now)
        self._finish(out, t0, now)
        return self.model

    def _sessions(self, out, now):
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

    def _finish(self, out, t0, now):
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
            "sessions": out, "alerts": alerts, "tokens_today": self.books.today(),
        }
        # the change hash leaves out the clock, so an idle system pushes nothing new (audit minor 7)
        body = json.dumps({"s": out, "a": alerts}, sort_keys=True, default=str)
        digest = hashlib.sha1(re.sub(r'"(now|since)": [0-9.]+', "", body).encode()).hexdigest()
        model["server"]["tick_ms"] = round((time.time() - t0) * 1000)
        with self.lock:
            self.model = model
            self.digest = digest
        self._gc()

    def agent_detail(self, sid, aid):
        """The agent panel's detail for one agent (None when it is not in view)."""
        with self.tr_lock:
            hit = self.where.get((sid, aid))
            tr = self.trs.get(hit[0]) if hit else None
            if tr is None:
                return None
            d = tr.detail(time.time(), rel=hit[1])
        if aid == "lead":
            d["report"] = None                    # the lead's first prompt is just where the session began
        else:
            d["brief"] = tr.brief()               # a file read (once): outside the lock
        return d

    def _root(self, sid):
        with self.lock:
            s = next((x for x in (self.model or {}).get("sessions", []) if x["id"] == sid), None)
        return (s.get("wts") or {}).get("root") if s else None

    def notes(self, sid, n):
        """Task n's notes, briefs and the pictures they name (None when the session has no queue or the task none)."""
        root = self._root(sid)
        return wts_mod.notes(root, n) if root else None

    def notes_pic(self, sid, n, i):
        root = self._root(sid)
        return wts_mod.notes_pic(root, n, i) if root else None

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
        with self.tr_lock:        # /api/agent reads a reducer between its updates
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
        with self.tr_lock:
            for p in [p for p, tr in self.trs.items() if getattr(tr, "seen_at", 0) < cutoff]:
                del self.trs[p]
            for k in [k for k, v in self.where.items() if v[0] not in self.trs]:
                del self.where[k]

    # --- one session ----------------------------------------------------------------------------------------
    def session_model(self, s, now):
        sid = s.get("sessionId") or str(s["pid"])
        main = self.transcript(s["transcript"], MAIN_BACKFILL, MAIN_MAX) if os.path.exists(s["transcript"]) else None
        if main:
            self.where[(sid, "lead")] = (s["transcript"], s["cwd"])
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
        latest_by_name, who_names = {}, {}
        for c in cands:
            if c["meta"].get("name"):
                latest_by_name[c["meta"]["name"]] = who_names[c["meta"]["name"].lower()] = c["id"]
            elif mm := RE_DESC_NAME.match(c["meta"].get("description") or ""):   # unnamed, described by a name: "hp183c: …"
                who_names[mm.group(1).lower()] = c["id"]
        # the HP workers: for each running HP task ("running 128 171": more than one may run), the newest agent for it,
        # named for it ("hp135", "hp128r3" for redo 3) or, started without a name, described as it ("HP 135 redo: …", "hp178b: …"),
        # so a redo replaces the first round's agent; else the newest hp<N> (or a "worker" from before the skill named
        # them by task); every other HP agent is retired. worker_id is the first task's.
        hp_running = []
        if wok:
            m = re.match(r"running((?:\s+\d+)+)", w.get("state_file") or "")
            hp_running = [int(x) for x in m.group(1).split()] if m else []
        workers = []
        if wok:
            for hp_n in hp_running:              # cands are oldest first: the last match is the newest
                mine = [c for c in cands if ((mm := RE_HP_NAME.match(c["meta"].get("name") or "")) and int(mm.group(1)) == hp_n)
                        or _hp_of_desc(c["meta"], rows) == hp_n]
                # Claude Code's own word: a finished (or stopped) round gives way
                live = [c for c in mine if not (c["meta"].get("finished") or c["meta"].get("stoppedByUser"))]
                if mine:
                    workers.append((live or mine)[-1]["id"])
            if not workers:
                hp_named = [c for c in cands if _is_worker_name(c["meta"].get("name"))]
                workers = [hp_named[-1]["id"]] if hp_named else []
        worker_id = workers[0] if workers else None
        in_view = [c for c in cands if now - c["mtime"] <= self.window_s or c["id"] in workers]
        trs = {c["id"]: self.transcript(c["path"], AGENT_BACKFILL, AGENT_MAX) for c in in_view}
        for c in in_view:
            self.where[(sid, c["id"])] = (c["path"], s["cwd"])
        ids = set(trs)

        # row binding: the HP worker by the state file; others by name ("mp111"), anchored description, own writes
        task_of = {}
        for c in in_view:
            aid, meta = c["id"], c["meta"]
            n = hp_running[0] if hp_running and aid == worker_id and meta.get("name") == "worker" else None   # an hp<N> says its own task
            for rx, src in ((RE_NAME_TASK, meta.get("name") or ""), (RE_TASK, meta.get("description") or "")):
                if n is None:
                    mm = rx.match(src)
                    n = int(mm.group(1)) if mm else None
            if n is None:
                n = _hp_of_desc(meta, rows)
            if n is None and trs[aid].qstate:
                n = trs[aid].qstate[-1]["n"]
            if n is not None and n in rows:
                task_of[aid] = n
        agent_of_row = {}
        for c in in_view:                     # newest agent wins a row; a worker always keeps its HP row
            n = task_of.get(c["id"])
            if n is not None and agent_of_row.get(n) not in workers:
                agent_of_row[n] = c["id"]
        for aid in list(task_of):
            if agent_of_row.get(task_of[aid]) != aid:
                task_of.pop(aid)

        # the window holder: whoever last wrote the literal start of the current `who` text (audit M1)
        win = w["window"] if wok else {}
        holder = None
        if win.get("held"):
            holder = _holder(win.get("who") or "", main, trs, task_of, who_names, worker_id)

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

        talked = {}                 # agent -> last time it sent or got a message (spawns aside, and its own hand-back:
        for m in msgs:              # handing back is how a turn ends, not a conversation it waits on)
            if m["kind"] != "spawn":
                for x in (m["from"], m["to"]):
                    if not (m["kind"] == "handback" and x == m["from"]):
                        talked[x] = max(talked.get(x, 0), m["t"])

        names = {c["id"]: c["meta"].get("name") for c in in_view}
        stopped = {}                # agent id -> (when, by whom) it was stopped with TaskStop
        for src, tr in ([("lead", main)] if main else []) + list(trs.items()):
            for tid, t in tr.stops.items():
                if tid in ids and t > stopped.get(tid, (0, None))[0]:
                    stopped[tid] = (t, src)

        nidx = wts_mod.notes_index(w["root"]) if wok else {}
        agents = []
        for c in in_view:
            aid, meta, tr = c["id"], c["meta"], trs[c["id"]]
            n = task_of.get(aid)
            nn = n if n in nidx else _task_of_meta(meta, nidx)     # the task whose notes it wrote (its row may be gone)
            row = rows.get(n) if n is not None else None
            row_open = (row["kind"] in wts_mod.OPEN) if row else None
            st = agent_state(tr, now, alive=s["alive"], lock_name=lock_name, is_holder=holder == aid, row_open=row_open,
                             row_waits_window=bool(row and "waiting for the window" in row["status"]),
                             recently_messaged=bool(tr.bg_pending) or now - talked.get(aid, 0) < 1800)
            stop_t, stopper = stopped.get(aid, (0, None))
            if stop_t and tr.last_ts <= stop_t + 5 and st["key"] != "dead":   # nothing since the stop: it was not woken again
                by = "the lead" if stopper == "lead" else (names.get(stopper) or "another agent")
                st = {"key": "ended", "label": f"stopped by {by}", "since": stop_t, "detail": "", "sub": "stopped"}
            # a row paused or parked on purpose: an agent that is not at work there is paused (by hand) or on hold
            # (waiting for something else), whatever its last turn said
            if row and row["kind"] in ("paused", "parked") and st["key"] in ("ended", "stuck", "unknown") and st.get("sub") != "stopped":
                if row["kind"] == "paused":
                    st = {"key": "parked", "label": "paused", "since": st["since"], "detail": "its row says so", "sub": "paused"}
                else:
                    head = re.sub(r"^[^\w]+", "", row["status"]).split(":")[0].strip() or "on hold"
                    st = {"key": "parked", "label": clip(head, 40), "since": st["since"], "detail": "its row says so", "sub": "hold"}
            if holder == aid and st["key"] in ("running", "polling", "waiting_window"):
                st = dict(st, key="running", label="holds the window · " + _dur(now - (win.get("since") or now)))
            role = "worker" if aid in workers else (row["group"].lower() if row and row["group"] in ("MP", "LP") else "helper")
            label = meta.get("name") or _short_desc(meta.get("description")) or aid[:7]
            hp = RE_HP_NAME.match(meta.get("name") or "")
            hp = int(hp.group(1)) if hp else _hp_of_desc(meta, rows)
            if role in ("mp", "lp") and n is not None:
                label = f"{role.upper()} {n}"
            elif hp is not None:
                label = f"HP {hp}"
            # a fresh agent per task: an older holder of a name, or an HP worker that is not the current one, is retired
            # once its turn has ended
            superseded = bool(meta.get("name")) and latest_by_name.get(meta["name"]) != aid
            retired = superseded or ((_is_worker_name(meta.get("name")) or hp is not None) and wok and aid not in workers)
            if superseded:
                label = f"{meta['name']} (earlier)"
            finished = st["key"] == "dead" or (st["key"] == "ended" and (retired or st.get("sub") == "stopped" or (st.get("sub") == "done" and now - st["since"] > 120)))
            # Claude Code's own word, in the agent's meta file: it finished (gone again when the agent is revived), or
            # you stopped it
            if st["key"] in ("ended", "unknown") and (meta.get("finished") or meta.get("stoppedByUser")):
                finished = True
            agents.append({
                "id": aid, "name": meta.get("name"), "label": label, "desc": clip(redact(meta.get("description") or ""), 120),
                "role": role, "task": n, "task_title": row["title"] if row else None, "group": row["group"] if row else None,
                "parent": parent_of[aid], "depth": meta.get("spawnDepth") or 1, "model": tr.model or meta.get("model"),
                "state": st, "ctx": tr.ctx, "ctx_max": self.ctx_max, "said": tr.said, "recent": list(tr.recent),
                "last_ts": tr.last_ts, "born": c["birth"], "finished": finished,
                "qstate": list(tr.qstate)[-3:], "compactions": [x[0] for x in tr.compactions if now - x[0] <= self.window_s],
                "talked": talked.get(aid, 0), "anchor": None, "notes": {"n": nn, "t": nidx[nn]} if nn is not None else None,
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

        tok = self.session_tokens(s, cands, by_id, rows, now)
        lead["tokens"] = tok.pop("lead_own", None)

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
            "tokens": tok,
        }

    # --- token statistics -----------------------------------------------------------------------------------
    def session_tokens(self, s, cands, by_id, rows, now):
        """The session's token counts: the lead and every agent it ever had (not only those in view), by agent, by
        WTS task and per minute by role. Each agent in view also gets its own figures (`tokens`)."""
        main_path = s["transcript"]
        self.books.want([main_path] + [c["path"] for c in cands])
        day = tokens_mod.day_of(now)
        nodes = [("lead", main_path, {}, None)] + [(c["id"], c["path"], c["meta"], c) for c in cands]
        own_task, primary = {}, {}
        for aid, _, meta, c in nodes[1:]:
            n = _task_of_meta(meta, rows)
            if n is not None:
                own_task[aid] = n
            n = _task_of_meta(meta, rows, primary=True)
            if n is not None:
                primary[aid] = n
        task = dict(own_task)
        for aid, _, meta, c in nodes[1:]:   # a helper an agent spawned works on that agent's task
            if aid not in task and meta.get("parentAgentId") in own_task:
                task[aid] = own_task[meta["parentAgentId"]]
        total, today, replies, compactions, ready = [0, 0, 0, 0], [0, 0, 0, 0], 0, 0, True
        per, tasks, minutes, writes = [], {}, {}, {}
        lead_own = None
        with self.books.lock:
            for aid, path, meta, c in nodes:
                L = self.books.get(path)
                if L is None or not L.done:
                    ready = False
                if L is None or not L.replies:
                    continue
                v = list(L.total)
                tokens_mod.add(total, v)
                tokens_mod.add(today, L.days.get(day, [0, 0, 0, 0]))
                replies += L.replies
                compactions += L.compactions
                a = by_id.get(aid)
                role = "lead" if aid == "lead" else a["role"] if a else _role_of_meta(meta, rows)
                own = {"v": v, "n": L.replies, "cx": L.compactions, "model": L.model}
                if aid == "lead":
                    lead_own = own
                elif a:
                    a["tokens"] = own
                n = task.get(aid)
                if n is not None:
                    t = tasks.setdefault(n, {"v": [0, 0, 0, 0], "agents": 0})
                    tokens_mod.add(t["v"], v)
                    t["agents"] += 1
                # the task's latest run: its newest own agent (an hp/mp name or a "Task N:" description, not a helper),
                # from its first reply to its last, so a done row says how long it took after its agent left the view
                pn = primary.get(aid)
                if pn is not None and L.first is not None:
                    t = tasks.setdefault(pn, {"v": [0, 0, 0, 0], "agents": 0})
                    if not t.get("run") or L.first > t["run"][0]:
                        t["run"] = [L.first, L.last]
                per.append({"id": aid, "label": "lead" if aid == "lead" else a["label"] if a else _label_of_meta(meta, rows, aid),
                            "role": role, "task": n, "shown": aid == "lead" or bool(a),
                            "finished": bool(a and a["finished"]) or (aid != "lead" and not a), **own})
                for t, n, what in L.qwrites:
                    if n in rows:
                        writes.setdefault(n, set()).add((t, what))
                ri = ROLES.index(role) if role in ROLES else ROLES.index("helper")
                for m, mv in L.minutes.items():
                    tokens_mod.add(minutes.setdefault((m, ri), [0, 0, 0, 0]), mv)
        # each row's own State writes, by whoever made them (an agent may do a row as part of another task: 119 inside
        # 141): its last "in progress" stretch, from its first such write to the first "done" after it
        row_writes = {str(n): state_run(ws) for n, ws in writes.items()}   # apart from tasks: no empty "By task" rows
        t0 = int((now - tokens_mod.SERIES_S) // 60 * 60)
        # per minute and role: [minute, role, fresh in (input + cache write), cache read, output]
        series = [[(m - t0) // 60, ri, v[0] + v[1], v[2], v[3]] for (m, ri), v in sorted(minutes.items()) if m >= t0 and any(v)]
        return {"v": total, "today": today, "n": replies, "cx": compactions, "ready": ready, "agents": per,
                "tasks": {str(k): v for k, v in tasks.items()}, "rows": row_writes, "series": {"t0": t0, "roles": ROLES, "rows": series},
                "lead_own": lead_own}


ROLES = ["lead", "worker", "mp", "lp", "helper"]


def state_run(ws):
    """A row's last stretch from its State writes [(time, what)]: start (its first "in progress") and done (the first
    "done" after it), or open (in progress since); last: the latest write [time, what], the exact day of the State's
    HH:MM. A "done" written again later changes nothing; a row queued again starts a new stretch."""
    start, done, open_, last = None, None, None, None
    for t, what in sorted(ws):
        last = [t, what]
        if what in ("in progress", "in hand"):
            open_ = t if open_ is None else open_
        elif what == "done" and (open_ is not None or done is None):
            start, done, open_ = open_, t, None
        elif what == "queued":
            open_ = None
    return {"start": start, "done": done, "open": open_, "last": last}
RE_HELPER_TASK = re.compile(r"^[a-z]+-?(\d{2,4})$", re.I)     # a helper named for its task: "adv129"


def _hp_of_desc(meta, rows):
    """The HP task an unnamed top-level agent is the worker for, by its description: "HP 135 redo: …", or the name it
    was not given, "hp178b: …", which counts only for an HP row (so "hp2: printer driver" binds nothing)."""
    if meta.get("name") or (meta.get("spawnDepth") or 1) > 1:
        return None
    d = meta.get("description") or ""
    m = RE_HP_DESC.match(d)
    if m:
        return int(m.group(1))
    m = RE_HP_DESC_NAME.match(d)
    r = rows.get(int(m.group(1))) if m else None
    return int(m.group(1)) if isinstance(r, dict) and r.get("group") == "HP" else None


def _task_of_meta(meta, rows, primary=False):
    """The WTS task an agent worked on, from its name ("hp129", "mp112", "adv129") or description ("Task 74: …").
    primary: only the task's own agents: named for it ("hp129", "mp112r2") or, with no name, described as it; a helper
    named otherwise ("adv129") is not one, whatever its description says."""
    name = meta.get("name") or ""
    if primary:
        m = RE_NAME_TASK.match(name) if name else RE_TASK.match(meta.get("description") or "")
        return int(m.group(1)) if m and int(m.group(1)) in rows else _hp_of_desc(meta, rows)
    for rx, src in ((RE_NAME_TASK, name), (RE_TASK, meta.get("description") or ""), (RE_HELPER_TASK, name))[:2 if primary else 3]:
        m = rx.match(src)
        if m and int(m.group(1)) in rows:
            return int(m.group(1))
    return _hp_of_desc(meta, rows)


def _role_of_meta(meta, rows):
    name = meta.get("name") or ""
    if _is_worker_name(name):
        return "worker"
    m = RE_NAME_TASK.match(name) or RE_TASK.match(meta.get("description") or "")
    row = rows.get(int(m.group(1))) if m else None
    if row and row["group"] in ("MP", "LP"):
        return row["group"].lower()
    return "helper"


def _label_of_meta(meta, rows, aid):
    """The name an agent that is no longer in view goes by, as the graph would have shown it."""
    name = meta.get("name") or ""
    hp = RE_HP_NAME.match(name)
    hp = int(hp.group(1)) if hp else _hp_of_desc(meta, rows)
    if hp is not None:
        return f"HP {hp}"
    role = _role_of_meta(meta, rows)
    m = RE_NAME_TASK.match(name) or RE_TASK.match(meta.get("description") or "")
    if role in ("mp", "lp") and m:
        return f"{role.upper()} {int(m.group(1))}"
    return name or _short_desc(meta.get("description")) or aid[:7]


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
    if by_name.get(first) in trs:                 # "worker capture …" → the agent named (or described as) worker
        return by_name[first]
    m = RE_WHO_ROW.match(who)
    if m:
        n = int(m.group(1))
        for aid, k in task_of.items():
            if k == n:
                return aid
    return None
