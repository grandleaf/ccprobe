"""Alert rules (DESIGN.md §7, with the audit's M2 fixes): pure checks over the model; first-seen times kept across ticks.

Every rule is tuned so the user's normal workflow raises nothing: a worker waiting on its advisor, rows parked in
desk-only mode, caffeinate turned off on purpose, the lead holding the window while the user looks at the app.
"""
import re
import time

OPEN = ("asks", "active", "paused", "parked", "queued", "other")
BUSY = ("running", "thinking", "polling")


class Memory:
    def __init__(self):
        self.first_seen = {}       # alert key -> first tick it was present
        self.cond_since = {}       # condition key -> first tick it held (for grace periods)
        self.row_kind = {}         # (root, n) -> last kind seen
        self.done_at = {}          # (root, n) -> time it turned done

    def held_for(self, key, cond, now):
        """How long `cond` has held without a break (0 when it does not hold)."""
        if not cond:
            self.cond_since.pop(key, None)
            return 0
        return now - self.cond_since.setdefault(key, now)


# a running time in a title ("stuck? silent 12m", "Bash past its timeout · 1h 5m"): left out of the alert's signature
RE_DUR = re.compile(r"(?:\s*·)?\s*\b\d+(?:h \d+m|[hms])\b")



def _cut(t, n):
    t = " ".join(t.split())
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"

def compute(sessions, now, mem):
    out, keys = [], set()

    def add(key, sev, title, detail, s, agent=None):
        if key in keys:              # two sessions in one project report its WTS once
            return
        keys.add(key)
        # sig: the title without its running time, so hiding an alert lasts until it really changes
        out.append({"key": key, "sev": sev, "title": title, "sig": RE_DUR.sub("", title).strip(), "detail": detail,
                    "session": s["id"], "agent": agent, "project": s.get("project")})

    for s in sessions:
        lead = s.get("lead") or {}
        limited = bool(lead.get("limit"))
        if limited:
            add(f"usage-limit:{s['id']}", "red", f"{s['project']}: usage limit reached", lead["limit"]["text"], s, "lead")
        agents = {a["id"]: a for a in s.get("agents") or []}
        name = lambda aid: "lead" if aid == "lead" else (agents[aid]["label"] if aid in agents else aid)

        for a in agents.values():
            if a["state"]["key"] == "stuck" and not limited:
                add(f"stuck:{a['id']}", "amber", f"{a['label']}: {a['state']['label']}",
                    "No conversational entries and no model call for 10 min while not waiting on a tool or a message.", s, a["id"])
        if (lead.get("state") or {}).get("key") == "stuck" and not limited:
            add(f"stuck:{s['id']}:lead", "amber", f"{s['project']} lead: {lead['state']['label']}", "", s, "lead")

        w = s.get("wts")
        if not w or w.get("error"):
            continue
        root = w["root"]
        rows = {r["n"]: dict(r, group=g) for g, rs in w["groups"].items() for r in rs}

        for r in rows.values():
            if r["kind"] == "asks":
                add(f"asks:{root}:{r['n']}", "red", f"{r['n']} needs you", r["title"], s, r.get("agent"))
            k = (root, r["n"])
            if mem.row_kind.get(k) not in (None, "done") and r["kind"] == "done":
                mem.done_at[k] = now
            mem.row_kind[k] = r["kind"]
            if k in mem.done_at and now - mem.done_at[k] <= 1800 and r["kind"] == "done":
                add(f"done:{root}:{r['n']}", "info", f"{r['n']} done", f"{r['title']} · {r['status']}", s, r.get("agent"))

            a = agents.get(r.get("agent"))
            if r["kind"] == "active" and a:
                st = a["state"]
                # only a dead agent: one waiting for a message (its turn ended, the lead or its advisor wakes it) is the
                # normal way a task waits, not an alert (the user's call)
                if st["key"] == "dead":
                    add(f"orphan-row:{root}:{r['n']}", "red", f"Row {r['n']} says in progress, but {a['label']} is {st['label']}",
                        f"{a['label']} last wrote {_ago(now - st['since'])} ago; its process is gone."
                        + (f" Its row says: \"{_cut(r.get('state') or '', 140)}\"" if r.get("state") else ""), s, a["id"])

        # a State write that failed (the auto-mode refusal case); heads with $(…) cannot be compared, so only errors
        for a in agents.values():
            for q in a.get("qstate") or []:
                if q["error"] and q["n"] in rows and rows[q["n"]]["kind"] not in ("paused", "parked") \
                        and not _landed(q, rows[q["n"]]["status"]) \
                        and not any(x["n"] == q["n"] and x["t"] > q["t"] and not x["error"] for x in a["qstate"]):
                    add(f"stale-row:{root}:{q['n']}", "red", f"Row {q['n']} may be stale",
                        f"{a['label']} tried to set it to \"{q['head'][:40]}…\" but the write failed; the queue shows \"{rows[q['n']]['status']}\".",
                        s, a["id"])

        # the HP state file against the worker (a deliberate stop is not an alert: wts shows ■ stopped)
        worker = next((a for a in agents.values() if a["role"] == "worker"), None)
        sf = (w.get("state_file") or "").strip()
        m = re.match(r"running((?:\s+\d+)+)", sf)    # "running 128 171": more than one HP task may run
        if m:
            off = [(n, rows.get(n)) for n in map(int, m.group(1).split())]
            off = [(n, r) for n, r in off if not r or r["kind"] not in ("active", "done", "closed")]
            if mem.held_for(f"hp-run:{root}", bool(off), now) >= 120:
                n, r = off[0]
                add(f"hp-state:{root}", "amber", "HP state file disagrees with the queue",
                    f"state says \"{sf}\", but row {n} is {r['status'] if r else 'not in the queue'}.", s, worker and worker["id"])
        else:
            mem.held_for(f"hp-run:{root}", False, now)
        working = bool(sf.startswith(("stopped", "paused")) and worker and worker["state"]["key"] in BUSY)
        if mem.held_for(f"hp-stop:{s['id']}:{root}", working, now) >= 300:
            add(f"hp-state-worker:{root}", "amber", "HP state file disagrees with the worker",
                f"state says \"{sf}\", but the worker has been working for 5 min: {worker['state']['label']}.", s, worker["id"])

        win = w.get("window") or {}
        holder = win.get("holder")
        if win.get("held"):
            held_for = now - (win.get("since") or now)
            h = agents.get(holder)
            holder_bad = holder != "lead" and (h is None or h["state"]["key"] in ("ended", "parked", "dead", "stuck"))
            if held_for >= 900 and holder_bad and not w.get("app_running"):
                add(f"stale-lock:{root}", "red", "Stale window lock?",
                    f"Held by \"{win.get('who')}\" for {_ago(held_for)}; " +
                    (f"{h['label']} is {h['state']['label']}" if h else "no live agent matches it") +
                    (f", and {w.get('app')} is not running." if w.get("app") else "."), s, holder if h else None)
            if h and h.get("group") in ("MP", "LP") and (w.get("modes") or {}).get(h["group"]) in ("desk", "paused"):
                add(f"mode-breach:{root}:{h['group']}", "amber",
                    f"{h['label']} holds the window in {h['group']} {w['modes'][h['group']]} mode", f"Lock: {win.get('who')}", s, h["id"])
        # waiters that really poll for the lock, in a group allowed to use it, while it sits free
        polling = [x for x in win.get("waiters") or [] if x in agents and agents[x]["state"].get("via") == "loop"
                   and (agents[x].get("group") in (None, "HP") or (w.get("modes") or {}).get(agents[x].get("group")) == "running")]
        if mem.held_for(f"free:{s['id']}:{root}", bool(polling) and not win.get("held"), now) >= 120:
            add(f"waiting-free:{root}", "amber", f"Window free, {', '.join(name(x) for x in polling)} still waiting",
                "The lock has been free for 2 min, but their lock loops have not taken it.", s, polling[0])

        busy = sf.startswith("running") or any(a["state"]["key"] in BUSY for a in agents.values())
        if not w.get("caffeinate") and busy:
            add(f"caffeinate:{root}", "amber", "caffeinate is off while work is running",
                "The Mac may sleep and stop the agents.", s)

    for a in out:
        a["since"] = mem.first_seen.setdefault(a["key"], now)
    for k in [k for k in mem.first_seen if k not in keys]:
        del mem.first_seen[k]
    rank = {"red": 0, "amber": 1, "info": 2}
    out.sort(key=lambda a: (rank[a["sev"]], -a["since"]))
    return out


def _landed(q, status):
    """The queue already shows what the write said: the call failed after it (a later step in the same command)."""
    for dt in (0, 60):                     # $(date +%H:%M) as it ran, or a minute on
        head = q["head"].replace("$(date +%H:%M)", time.strftime("%H:%M", time.localtime(q["t"] + dt)))
        if "$(" in head or "`" in head:
            return False                   # another substitution: cannot tell
        if head.split(": ")[0].strip() in status:
            return True
    return False


def _ago(s):
    s = int(max(0, s))
    return f"{s // 60}m" if s < 3600 else f"{s // 3600}h {s % 3600 // 60}m"
