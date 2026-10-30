"""The Events tab (DESIGN.md §7b): what happened, in order. Each tick is compared with the last; what changed becomes an
event. Kept in memory only (ccprobe writes nothing), so a restart starts over: on first sight of a session or a queue,
what the model already dates (agents' births and ends, rows' start and done times, windows held) is put back as history.

An event: {id, t, cat, sev, icon, title, detail, …} with
  cat   task · agent · window · alert · session (the page filters by it)
  sev   ok · info · warn · bad · you (its colour; "you": it needs you)
and, when they apply: agent (an agent id to select), n (task number), group (HP/MP/LP), notes (the task has notes),
dur (seconds it took), end (when a span ended: a window held, an alert gone).
"""
import collections
import itertools
import re
import threading
import time

from .redact import clip

KEEP_S = 24 * 3600          # how long an event is kept
KEEP_N = 600                # at most this many per session and per queue
RE_HHMM = re.compile(r"\b(\d{1,2}):(\d{2})\b")
# the alerts that are events of their own; the rest are already told by a task or agent event (needs you, usage
# limit, stuck, done)
ALERT_KINDS = ("orphan-row", "stale-row", "stale-lock", "hp-state-worker", "mode-breach", "waiting-free", "caffeinate")
PRIVATE = ("who", "by", "scope")    # kept on an open event to close it later; not for the page
MODE_WORDS = {"running": "running", "desk": "desk-only", "paused": "paused"}


def at_hhmm(text, now):
    """The time an "HH:MM" in a State means: today, or yesterday when that is still ahead of now."""
    m = RE_HHMM.search(text or "")
    if not m:
        return None
    lt = time.localtime(now)
    t = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, int(m.group(1)), int(m.group(2)), 0, 0, 0, -1))
    return t - 86400 if t > now + 120 else t


def _body(state):
    """A State without its head word and time: "done 21:40: the fix …" -> "the fix …"."""
    s = state or ""
    head, sep, rest = s.partition(": ")
    return (rest if sep and len(head) < 40 else s).strip()


def _row_kind(r):
    k = r["kind"]
    if k == "parked" and re.match(r"(?i)\s*(waiting|wait)\b.*window", r.get("state") or ""):
        return "window_wait"
    return k


class Feed:
    def __init__(self):
        self.lock = threading.Lock()
        self.seq = 0
        self.items = {}      # scope (a session id, or "wts:" + project root) -> deque of events, oldest first
        self.rev = {}        # scope -> bumped on every change (a new event, or one updated in place)
        self.prev = {}       # scope -> what the last tick showed
        self.once = {}       # keys of events told once (an agent's start, its end …) -> the event's time
        self.seen = {}       # scope -> the last tick it was in the model (one gone a day is dropped)
        self.open = {}       # span key -> the event still open (a window held, an alert raised)
        self.row_start = {}  # (root, n) -> when its task started

    # --- writing ---------------------------------------------------------------------------------------------
    def _add(self, scope, t, cat, sev, icon, title, detail="", key=None, **kw):
        if key is not None:
            if key in self.once:
                return None
            self.once[key] = t if t is not None else time.time()
        if t is None or time.time() - t > KEEP_S:
            return None
        self.seq += 1
        ev = {"id": self.seq, "t": t, "cat": cat, "sev": sev, "icon": icon, "title": title,
              "detail": clip(detail or "", 280), **{k: v for k, v in kw.items() if v is not None}}
        self.items.setdefault(scope, collections.deque(maxlen=KEEP_N)).append(ev)
        self.rev[scope] = self.rev.get(scope, 0) + 1
        return ev

    def _touch(self, scope):
        self.rev[scope] = self.rev.get(scope, 0) + 1

    # --- one tick ----------------------------------------------------------------------------------------------
    def observe(self, sessions, alerts, now):
        """Compare this tick with the last; give each session its feed summary (`feed`: rev and recent ids)."""
        with self.lock:
            roots = {}
            for s in sessions:
                for sc in self._scopes(s):
                    self.seen[sc] = now
                if s.get("error"):
                    continue
                self._session(s, now)
                w = s.get("wts")
                if w and not w.get("error") and w["root"] not in roots:
                    roots[w["root"]] = s
            for root, s in roots.items():
                self._queue(root, s, now)
            self._alerts(sessions, alerts, now)
            for s in sessions:
                scopes = self._scopes(s)
                recent = sorted((e for sc in scopes for e in itertools.islice(reversed(self.items.get(sc, ())), 60)), key=lambda e: e["id"])[-60:]
                # rev: changes whenever an event is added or updated (the page then fetches the list again)
                s["feed"] = {"rev": ":".join(str(self.rev.get(sc, 0)) for sc in scopes),
                             "recent": [[e["id"], e["cat"], e["sev"]] for e in recent]}
            self._gc(now)

    def _scopes(self, s):
        w = s.get("wts")
        return [s["id"]] + (["wts:" + w["root"]] if w and w.get("root") else [])

    def for_session(self, s):
        """The session's events, newest first (its own and its project queue's)."""
        with self.lock:
            out = [{k: v for k, v in e.items() if k not in PRIVATE} for sc in self._scopes(s) for e in self.items.get(sc, ())]
        out.sort(key=lambda e: (e["t"], e["id"]), reverse=True)
        return out

    def _gc(self, now):
        for q in self.items.values():
            while q and now - q[0]["t"] > KEEP_S:
                q.popleft()
        # a key whose event is past keeping would be refused anyway: dropping it changes nothing
        if len(self.once) > 5000:
            self.once = {k: t for k, t in self.once.items() if now - t <= KEEP_S}
        # a session or queue gone for a day: everything about it goes (its open spans too)
        for sc in [sc for sc, t in self.seen.items() if now - t > KEEP_S]:
            for d in (self.seen, self.items, self.rev, self.prev):
                d.pop(sc, None)
            root = sc[4:] if sc.startswith("wts:") else None
            for k in [k for k, ev in self.open.items() if ev.get("scope") == sc or (root and k[0] == "hold" and k[1] == root)]:
                del self.open[k]
            for k in [k for k in self.row_start if k[0] == root]:
                del self.row_start[k]

    # --- a session: its agents and its lead ----------------------------------------------------------------------
    def _session(self, s, now):
        sid = s["id"]
        agents = {a["id"]: a for a in s.get("agents") or []}
        label = lambda aid: "Lead" if aid == "lead" else (agents[aid]["label"] if aid in agents else "an agent")
        lead = s.get("lead") or {}
        lst = lead.get("state") or {}
        prev = self.prev.get(sid)
        first = prev is None
        add = lambda *a, **k: self._add(sid, *a, **k)

        if s.get("started"):
            add(s["started"], "session", "info", "i-lead", f"{s.get('project') or 'Session'} session started",
                s.get("title") or "", key=("start", sid))
        if prev and prev["alive"] and not s.get("alive"):
            add(now, "session", "warn", "i-dead", "Session ended", "Its Claude Code process is gone.", key=("end", sid))

        for aid, a in agents.items():
            st = a.get("state") or {}
            born = a.get("born") or now
            group = a.get("group")
            task = a.get("task")
            # started / spawned: what for, by whom, on which model
            by = a.get("parent")
            what = a.get("task_title") or a.get("desc") or ""
            # the lead starts agents; one agent spawning another says who
            on = f" on task {task}" if task is not None and str(task) not in a["label"] else ""
            add(born, "agent", "info", "i-run", f"{a['label']} " + (f"spawned by {label(by)}" if by and by != "lead" else f"started{on}"),
                what, key=("spawn", aid), agent=aid, n=task, group=group, model=a.get("model") or None)
            was = prev["agents"].get(aid) if prev else None
            key = st.get("key")
            if not s.get("alive"):
                continue                       # a session that ended: its agents' ends are not news of their own
            # finished (its work handed back) or stopped by you; an earlier agent of a reused name is not news
            if a.get("finished") and "(earlier)" not in a["label"] and (first or not (was and was[1])):
                stopped = (st.get("label") or "").startswith("stopped by")
                t = st.get("since") or now
                add(t, "agent", "warn" if stopped else "ok", "i-stall" if stopped else "i-done",
                    f"{a['label']} {st['label'] if stopped else 'finished'}", a.get("said") or "",
                    key=("end", aid, round(born)), agent=aid, n=task, group=group, dur=max(0, t - born))
            if key == "dead" and (first or (was and was[0] != "dead")):
                add(st.get("since") or now, "agent", "bad", "i-dead", f"{a['label']} died",
                    "Its process is gone." + (f" Last said: {a['said']}" if a.get("said") else ""),
                    key=("dead", aid, round(st.get("since") or 0)), agent=aid, n=task, group=group)
            if key == "stuck" and not first and was and was[0] != "stuck":
                add(now, "agent", "warn", "i-stuck", f"{a['label']} looks stuck", st.get("label") or "",
                    key=("stuck", aid, round(st.get("since") or now)), agent=aid, n=task, group=group)

        # the lead: waiting for you, a usage limit, its context compacted
        if lst.get("key") == "waiting_user" and (first or prev["lead"] != "waiting_user"):
            add(lst.get("since") or now, "agent", "you", "i-ask", "Lead is waiting for you",
                lst.get("detail") or lead.get("said") or "", key=("ask", sid, round(lst.get("since") or now)), agent="lead")
        lim = lead.get("limit")
        if lim and (first or not prev["limit"]):
            add(lim.get("since") or now, "agent", "bad", "i-stall", "Usage limit reached", lim.get("text") or "",
                key=("limit", sid, round(lim.get("since") or now)), agent="lead")
        if not lim and prev and prev["limit"]:
            add(now, "agent", "ok", "i-run", "Usage limit lifted", "", agent="lead")
        for t in lead.get("compactions") or []:
            add(t, "agent", "info", "i-doc", "Lead's context compacted",
                "Older turns were summarised; it may have lost detail from them.", key=("cx", sid, round(t)), agent="lead")

        self.prev[sid] = {"agents": {aid: (a["state"]["key"], bool(a.get("finished"))) for aid, a in agents.items()},
                          "alive": bool(s.get("alive")), "lead": lst.get("key"), "limit": bool(lim)}

    # --- a project's queue: rows, modes, windows ----------------------------------------------------------------
    def _queue(self, root, s, now):
        w = s["wts"]
        scope = "wts:" + root
        agents = {a["id"]: a for a in s.get("agents") or []}
        label = lambda aid: "Lead" if aid == "lead" else (agents[aid]["label"] if aid in agents else None)
        born = lambda aid: agents[aid].get("born") if aid in agents else None
        rows = {r["n"]: dict(r, group=g) for g, rs in (w.get("groups") or {}).items() for r in rs}
        prev = self.prev.get(scope)
        first = prev is None
        add = lambda *a, **k: self._add(scope, *a, **k)

        def row_ev(r, t, sev, icon, verb, detail, cat=None, **kw):
            cat = cat or ("window" if _row_kind(r) == "window_wait" else "task")
            return add(t, cat, sev, icon, f"Task {r['n']} {verb}", detail, n=r["n"], group=r["group"],
                       notes=bool(r.get("notes")) or None, agent=r.get("agent"), sub=clip(r.get("title") or "", 90), **kw)

        for n, r in rows.items():
            kind, was = _row_kind(r), (prev["rows"].get(n) if prev else None)
            body = _body(r.get("state"))
            if first:
                # history the queue itself dates: a task done, or in progress since
                # (an active row's own time is its latest State write, not its start: its agent's start event tells that)
                if kind == "done":
                    t = at_hhmm(r.get("status"), now) or at_hhmm(r.get("state"), now)
                    if t:
                        t0 = born(r.get("agent"))
                        row_ev(r, t, "ok", "i-done", "done", body, key=("done", root, n, round(t)), dur=(t - t0) if t0 and t0 < t else None)
                elif kind == "active" and born(r.get("agent")):
                    self.row_start[(root, n)] = born(r.get("agent"))
                elif kind == "asks":
                    row_ev(r, at_hhmm(r.get("state"), now) or now, "you", "i-ask", "needs you", body, key=("ask", root, n))
                continue
            if was is None:
                row_ev(r, now, "info", "i-queue", "queued", r.get("title") or "", runs_on=r.get("runs_on"))
            elif was["group"] != r["group"]:
                row_ev(r, now, "info", "i-queue", f"moved {was['group']} → {r['group']}", r.get("title") or "")
            if was is None or was["kind"] != kind:
                back = was is not None and was["kind"] in ("paused", "parked", "window_wait", "asks")
                if kind == "active" and was is not None and was["kind"] == "window_wait":
                    row_ev(r, now, "info", "i-run", "got a window, goes on", body, cat="window")   # a worker's routine wait
                elif kind == "active":
                    self.row_start.setdefault((root, n), now)
                    row_ev(r, now, "info", "i-run", "resumed" if back else "started", body)
                elif kind == "paused":
                    row_ev(r, now, "warn", "i-park", "paused", body)
                elif kind == "parked":
                    row_ev(r, now, "warn", "i-park", "on hold", body)
                elif kind == "window_wait":
                    row_ev(r, now, "info", "i-window", "waits for a window", body)
                elif kind == "asks":
                    row_ev(r, now, "you", "i-ask", "needs you", body)
                elif kind == "done":
                    t0 = self.row_start.pop((root, n), None) or born(r.get("agent"))
                    row_ev(r, now, "ok", "i-done", "done", body, dur=(now - t0) if t0 else None, key=("done", root, n, round(now)))
                elif kind == "queued" and was is not None:
                    self.row_start.pop((root, n), None)
                    row_ev(r, now, "info", "i-queue", "queued again", body)
            if was and kind == "done" and "to review" in (was["status"] or "") and "to review" not in (r.get("status") or ""):
                row_ev(r, now, "ok", "i-eye", "reviewed by the lead", "")
        if prev:
            for n, was in prev["rows"].items():
                if n not in rows:
                    self.row_start.pop((root, n), None)
                    add(now, "task", "ok" if was["kind"] == "done" else "info", "i-done" if was["kind"] == "done" else "i-x",
                        f"Task {n} " + ("accepted" if was["kind"] == "done" else "left the queue"), was["title"] or "",
                        n=n, group=was["group"])

        # the HP worker's state file and the MP/LP modes
        hp = (w.get("state_file") or "").split()[:1]
        hp = hp[0] if hp else ""
        if prev and hp != prev["hp"] and hp in ("running", "paused", "stopped") and prev["hp"]:
            add(now, "task", "warn" if hp != "running" else "info", "i-run" if hp == "running" else "i-park",
                f"HP worker {hp}" if hp != "running" else "HP worker running again", w.get("state_file") or "", group="HP")
        modes = w.get("modes") or {}
        for g in ("MP", "LP"):
            m = modes.get(g)
            if prev and m and prev["modes"].get(g) and m != prev["modes"].get(g):
                add(now, "task", "info", "i-run" if m == "running" else "i-park", f"{g} set to {MODE_WORDS.get(m, m)}", "", group=g)
        if prev and w.get("caffeinate") is not None and prev["caf"] is not None and bool(w.get("caffeinate")) != prev["caf"]:
            on = bool(w.get("caffeinate"))
            add(now, "session", "info" if on else "warn", "i-cup", "caffeinate " + ("started" if on else "stopped"),
                "" if on else "The Mac may sleep when idle.")
        app = w.get("app")
        if prev and app and w.get("app_running") is not None and prev["app"] is not None and bool(w["app_running"]) != prev["app"]:
            add(now, "window", "info", "i-window", f"{app} " + ("opened" if w["app_running"] else "closed"), "")

        # the window slots: one event per hold, closed in place when it is let go
        slots = (w.get("window") or {}).get("slots") or []
        many = len(slots) > 1
        for i, x in enumerate(slots):
            nm = f"win{i}" if many else "the window"
            k = ("hold", root, x["name"])
            ev = self.open.get(k)
            pw = prev["slots"].get(x["name"]) if prev else None
            if ev and (not x["held"] or x.get("who") != ev["who"]):
                ev["end"] = now
                ev["dur"] = now - ev["t"]
                ev["title"] = f"{ev['by']} held {nm}"
                self._touch(scope)
                del self.open[k]
                ev = None
            if x["held"] and not ev:
                by = label(x.get("holder")) or clip(x.get("who") or "someone", 40)
                t = x.get("since") or now
                ev = add(t, "window", "info", "i-lock", f"{by} holds {nm}", x.get("who") or "",
                         agent=x.get("holder") if x.get("holder") in agents or x.get("holder") == "lead" else None,
                         slot=i if many else None, n=_task_of(x.get("holder"), agents))
                if ev:
                    ev["who"], ev["by"], ev["hold"] = x.get("who"), by, True
                    self.open[k] = ev
            if pw is not None and bool(x.get("reserved")) != pw:
                add(now, "window", "info", "i-lock" if x.get("reserved") else "i-unlock",
                    f"{nm} " + ("reserved for your shows" if x.get("reserved") else "free for workers again"), x["name"],
                    slot=i if many else None)

        self.prev[scope] = {
            "rows": {n: {"kind": _row_kind(r), "group": r["group"], "status": r.get("status"), "title": r.get("title")} for n, r in rows.items()},
            "hp": hp, "modes": dict(modes), "caf": None if w.get("caffeinate") is None else bool(w.get("caffeinate")),
            "app": None if w.get("app_running") is None else bool(w.get("app_running")),
            "slots": {x["name"]: bool(x.get("reserved")) for x in slots},
        }

    # --- alerts that are not told by another event ---------------------------------------------------------------
    def _alerts(self, sessions, alerts, now):
        live = set()
        for a in alerts or []:
            if not a["key"].startswith(ALERT_KINDS):
                continue
            k = ("alert", a["key"])
            live.add(k)
            if k in self.open:
                continue
            ev = self._add(a["session"], now, "alert", "bad" if a["sev"] == "red" else "warn", "i-bell", a["title"],
                           a.get("detail") or "", agent=a.get("agent"))
            if ev:
                ev["scope"] = a["session"]
                self.open[k] = ev
        for k in [k for k in self.open if k[0] == "alert" and k not in live]:
            ev = self.open.pop(k)
            ev["end"] = now
            ev["dur"] = now - ev["t"]
            self._touch(ev.get("scope"))


def _task_of(aid, agents):
    a = agents.get(aid) if aid else None
    return a.get("task") if a else None
