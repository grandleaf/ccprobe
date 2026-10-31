# ccprobe: design (v1)

A local, read-only web dashboard for every Claude Code session on this Mac (in tmux or not), the agents those sessions
spawn, and the background-worker queue ("WTS"). The graph is drawn in the style of agent-flow, and it moves with the
live activity.

Inputs: the user's four goals, a feature advisor's and a UI advisor's notes (not published).
Status: revision 2, 2026-10-22. It applies a design audit (see §15), and v1 is implemented.

## 1. Goals and non-goals

| # | Goal (the user's) | Met by |
|---|---|---|
| G1 | A local web server showing the status of everything running in tmux / Claude Code | §4 discovery, §8 server |
| G2 | A diagram of each block's relationships, with dashed lines that show live activity | §5 agents, §9.3 graph, §9.6 motion |
| G3 | The worker's state shown correctly (WTS) | §6 WTS, the row ↔ agent binding, the mismatch alerts |
| G4 | The essential extra information | §7 alerts, the context gauge, the window lock card, notifications |

**Non-goals for v1:** dollar cost panels, a transcript viewer or search, LLM summaries, editing the queue, any action that
writes to a project or to Claude Code (ccprobe is **read-only**), auto-installing hooks, push to a phone, a database,
npm or any build step, Docker, multi-user auth, force-directed layout, and avatars. (These come from features.md §6;
some are P1 later, §13.)

## 2. Facts the design rests on (verified on this machine)

- `~/.claude/sessions/<pid>.json` holds one file per Claude process: `sessionId, cwd, name, version, status`
  (`busy|idle|shell`), `statusUpdatedAt` (ms), `startedAt`. `status` is only a **hint**: it stays `busy` after the lead's
  turn ends while background agents run (audit B3). The same dir holds `<pid>.<hash>.key` files, which ccprobe must
  **never** read.
- tmux: `list-panes -a` gives `pane_pid`. The Claude process's **ppid is `pane_pid`** (verified for all 3 panes).
  `pane_title` is `✳ <title>` whether busy or idle, so it is not a state signal.
- Transcripts live at `~/.claude/projects/<cwd with / and . → ->/<sessionId>.jsonl`, and the agents at
  `…/<sessionId>/subagents/agent-<id>.jsonl` plus `.meta.json`. The directory name replaces every non-alphanumeric
  character of cwd with `-`, with a fallback of globbing for `<sessionId>.jsonl`. **Sizes:** the myproject main
  transcript is 1.07 GB, and its subagents total 3.3 GB across 76 agents (the largest is 1.03 GB). A whole-file read is
  never allowed.
- `agent-<id>.meta.json` = `{agentType, description, name?, toolUseId, spawnDepth, parentAgentId?, requestShape, model,
  finished?, isFork?, effort?}`. **`parentAgentId`** gives the parent of a nested agent directly. Spawn order comes from
  `st_birthtime`, because on APFS ctime equals mtime.
  `name` is the SendMessage address (`worker`, `mp111`, `part5`); it is absent for unnamed agents, and names get reused.
  `finished: true` appears even on a working agent, so it is **not** used for state.
- Entry types seen in the main transcript: `assistant`, `user`, `attachment`, `system`
  (`turn_duration | compact_boundary | informational | local_command`), `queue-operation`, `ai-title`,
  `permission-mode`, `api-request*` (very large blobs), `cost-state`, `file-history-*`, plus others. Unknown types
  are counted and ignored.
- `assistant` entries carry `message.content[]` with `tool_use {id, name, input}` and `message.usage` (context =
  `input + cache_read + cache_creation`), plus `model` and `timestamp`. `user` entries carry `tool_result {tool_use_id,
  is_error}`.
- An agent ends a run with a `SubagentHandback {message}` tool_use, which **gets its own tool_result** ("Report
  delivered…"). That result is not activity (B1). An assistant text block ends a turn only when it has
  `stop_reason: "end_turn"`; the writer emits one entry per block.
- A received message or notice is mostly a **`user` entry with a top-level `origin`**, and sometimes an
  `attachment.type == "queued_command"` with `attachment.origin` (B2). The kinds are:
  - `peer` (`from`, `senderTaskId`, `handback`);
  - `coordinator`;
  - `task-notification` (its text carries `<tool-use-id>`);
  - `human`;
  - `auto-continuation`.

  A hand-back goes to whoever last revived the agent, not necessarily its parent.
- A SendMessage tool_result's `toolUseResult` carries `resumedAgentId`/`revivedAgentId`/`pin.id` (M5).
- An `api-request` line (with `"type"` at byte 1) means a model call is in flight. It is the best thinking signal.
- `system/informational` includes notices such as "Usage limit reached · continuing automatically at 2:30am".
  `compact_boundary` carries `preTokens/postTokens`.
- Worker queue: `<root>/.autopilot/worker/{queue.md, state, mp_mode, lp_mode, titles.json, config.json}`. The lock is the
  dir `<root>/<config.lock>` with a `who` file; a project with several window slots lists them in `config.locks`
  (queue.py's `lock_paths` and `one_lock_text`), each read as its own slot with its own holder. `~/.claude/skills/worker/scripts/queue.py` exposes `Queue(root)` (`rows`,
  `kind`, `read_state`, `group_mode`, `lock_text`, `pinned`) and the helpers `hp_line`, `short_status`, `title_of`,
  `runs_on` and `table_rows`. `wts` = `window()` + `caffeinate` + per-group `table_rows(q, rows_of_group, False)`.

## 3. Architecture

```
ccprobe.py                 entry point: CLI, starts the collector thread and the HTTP server
ccprobe/
  tail.py                  incremental JSONL tailer (offset/inode/partial line, cheap skip of huge lines)
  sessions.py              discovery: registry + liveness + tmux join
  agents.py                transcript reducer: per-transcript state, agent registry, messages, events
  wts.py                   read-only bridge to queue.py, row↔agent binding, lock card
  alerts.py                rule engine, with stable keys and first-seen times
  model.py                 one tick: build the whole JSON model from the above
  server.py                HTTP: static files, /api/state, /api/events (SSE), auth, headers
static/
  index.html  app.css  app.js  theme.js     (no framework, no build step)
tests/                      unittest with synthetic fixtures; a read-only smoke test against the live data
docs/                       DESIGN.md
```

Python ≥ 3.10, standard library only (3.14 is installed). One **collector thread** ticks every 1.5 s and builds an
immutable model dict. The HTTP handlers only read the latest model under a lock. SSE clients get the full model whenever
its hash changes, plus a `: ping` every 15 s. At this size a full model (~50–150 KB) beats diffs: it is simpler and
cannot drift.

## 4. Session discovery (`sessions.py`)

Each tick:
1. Read `~/.claude/sessions/*.json` (exactly that glob, never `*.key`), keeping only these fields: `pid, sessionId, cwd,
   name, version, status, statusUpdatedAt, startedAt, kind`.
2. Alive check: `os.kill(pid, 0)` (a PermissionError counts as alive). Dead entries are shown greyed out for 10 min,
   then dropped.
3. tmux: `tmux list-panes -a -F '#{pane_pid}\t#{session_name}\t#{window_index}.#{pane_index}\t#{pane_title}'` (cached
   for 5 s, and a failure → no tmux info). Join on `ppid(session.pid) == pane_pid`, where ppid comes from one
   `ps -A -o pid=,ppid=` per tick. Sessions outside tmux are shown with the tag `no tmux`.
4. The transcript path is derived from cwd + sessionId. If it is missing, the session still shows, with "no transcript".
5. **Project root** for WTS = cwd if `<cwd>/.autopilot/worker/queue.md` exists.

## 5. Transcripts and agents (`tail.py`, `agents.py`)

### 5.1 Tailer
State per file: `(dev, inode, offset, partial)`. On first sight, seek to `max(0, size − BACKFILL)` (main 16 MB, agent
4 MB) and drop the first partial line. Each tick, read `size − offset` bytes (capped at 32 MB per tick per file; the rest
waits for the next tick). Reset when the inode changes or the size shrinks. **Cheap skip:** a line longer than 2 MB, or
whose first 120 bytes contain `"type":"api-request` / `"type":"file-history`, is skipped without `json.loads`. Every
decode error is counted, never raised.

### 5.2 Which agents are watched
Each tick, `os.scandir(subagents/)` (stat only) for every live session. An agent is **in view** when its jsonl mtime is
inside the activity window (default 6 h, `--window`), when it is bound to an open WTS row, or when it holds the lock.
Agents outside the view are not tailed. Their meta is still read once (name, description) so that names resolve.

### 5.3 Per-transcript reducer
Kept per transcript (main or agent), updated from new entries only:
- `last_ts`, `last_kind` (assistant-tool / assistant-text / handback / user / tool_result / queued_command / system)
- `pending`: a dict `tool_use_id → {name, arg, t}`. An entry is added on tool_use (except SubagentHandback) and removed on
  a matching tool_result.
- `bg_pending`: tool_use ids of `Bash` with `run_in_background: true`, removed when a queued_command's text carries the
  id
- `ctx`, `model` from the last `usage`; `compactions[]` from compact_boundary
- `said`: the first line of the last assistant text (≤ 200 chars)
- `recent[]`: the last 8 tool calls `{t, tool, arg}`, with arg = command | file_path | description | pattern | summary,
  redacted and cut to 110 chars
- `events[]`: a ring of `{t, tool}` inside the timeline window (≤ 2000 per transcript)
- `messages[]`: SendMessage `{t, to, summary}` and SubagentHandback `{t, summary}`
- `spawns[]`: Agent tool_uses `{t, tool_use_id, name, description}`
- `qstate[]`: `queue.py state N --text "<head>` calls seen in Bash commands, plus whether their tool_result was an error
- `notices[]`: system/informational texts with `t` (for the usage-limit alert)

### 5.4 Registry and edges
- **Identity** = agent id (from the file name). **Name** = `meta.name`, else none. **Label** = name, else a short
  description, else the id prefix. A SendMessage `to` resolves as `main` → the lead, else the **latest** in-view agent
  with that `meta.name` (by spawn time = jsonl ctime), else a raw id, else "unknown <to>" (counted).
- **Parent** = the transcript whose `spawns[]` holds `meta.toolUseId`. When it is not found (the spawn was older than
  the backfill), fall back to the lead when `spawnDepth == 1`.
- **Edges:** parent→child (spawn), and message edges between any two nodes that exchanged a SendMessage in the window.
  An edge is "hot" while a message crossed it in the last 60 s, or while the child is busy on a task its parent gave it.
- **Message events** (for pulses): `{id, t, from, to, kind: send|handback|spawn, summary}`, the last 200 per session.

### 5.5 Agent state (first rule that matches wins)
| key | label example | rule |
|---|---|---|
| `dead` | dead | the owning session pid is not alive |
| `waiting_window` | waiting for the window | a pending Bash whose command contains the lock path and `until`/`while`; or the bound row's State says "waiting for the window" with no pending tool |
| `running` | Bash 6m · `cd ~sf…` | a pending tool_use (the oldest pending one is shown, with how long it has run). A pending `until`/`sleep` poll loop is labelled **polling** |
| `ended_bg` | waiting on Blender / licence / build / capture / tests / its job · how long (whole hours past the first, so it fits) | the last kind is handback/text and `bg_pending` is not empty; the newest job's command and description say what it is (`what_of`). A running or polling Bash is named the same way (`Blender · 5m`, `waiting on a build · 3m`) |
| `ended` | waiting for a message (its turn ended; a message wakes it) / done | the last kind is handback, or a final assistant text with no pending tool. The subtype is *waiting* if the bound row is open, else *done* |
| `thinking` | thinking | the last kind is user/tool_result/queued_command and the file grew in the last 120 s |
| `stuck` | stuck? silent 12m | none of the above, and no growth for ≥ 10 min (shown as a question) |
| `unknown` | unknown | the parser could not tell |

**The lead** (the main transcript): `dead` if the pid is dead; registry `idle` → `waiting_user` ("waiting for you");
`shell` → `shell`; `busy` → `running` (pending tool) or `thinking`.

### 5.6 Context gauge
`ctx_max` = 1 000 000 by default (the Opus 5.5 / Fable sessions here run 1M windows; one compaction shows `preTokens`
967 765), and `--ctx-max` overrides it. Shown as a bar (amber at ≥ 80 %, red at ≥ 90 %). No pill and no alert: removed at the user's request (2026-10-22).

## 6. WTS bridge (`wts.py`), for goal G3

- Load `queue.py` with `importlib.util.spec_from_file_location`. Reload when its mtime changes. **Only** call `Queue(root)`,
  `.rows()`, `.kind()`, `.read_state()`, `.group_mode()`, `.lock_text()`, `.pinned()`, `.cfg`, `hp_line`, `table_rows`. Never
  call a writer (`save`, `set_row`, `mark_reviewed`, `set_title`, `write_state`). A wrapper exposes only those reads. Any
  exception becomes the model entry `wts.error` and does not stop the tick. When `queue.py` is missing, the fallback is
  to run `queue.py wts` and show the raw text.
- The model per project root: `{hp_line, modes:{MP,LP}, state_file, groups:{HP:[…],MP:[…],LP:[…]}, window:{held, who,
  since, holder, waiters[]}, caffeinate}`. Each row is `{n, title, runs_on, status (= short_status text), kind, acc,
  agent?}`, in the same order as `wts` (via `table_rows` per group). This means ccprobe and `wts` can never disagree on
  a row.
- **Row ↔ agent binding:**
  1. The HP row named by `state` = `running N` → the latest agent named `worker`.
  2. An agent whose description matches `(?:Task|MP|LP|HP)\s*(\d+)` → that row.
  3. The last `queue.py state N` call made by an agent → row N.
  4. Otherwise, no binding. Satellite agents (auditors) get an **anchor**: the node they messaged most, else their parent.
- **Role** = `worker` (the agent named `worker`), `mp`/`lp` (bound to a row in that group), else `helper`.
- **Window card:**
  - `held/who` = `lock_text()`; `since` = the lock dir's mtime.
  - `holder` = the node whose label or name matches the first word of `who` (`lead…` → the lead, `worker…` → the worker,
    `style-auditor…` → the agent whose description contains "auditor"); otherwise none.
  - `waiters` = nodes in the `waiting_window` state.

## 7. Alerts (`alerts.py`), for goal G4

Pure functions over (the model, the previous model). Each alert is `{key, sev: red|amber|info, title, detail, since,
session, agent?}`. `since` = the first tick its key was seen; it is kept in memory while the key stays present.

| sev | key | rule |
|---|---|---|
| red | `asks:<n>` | a row's kind is `asks` ("needs the user") |
| red | `usage-limit:<sid>` | a usage-limit notice in the last 60 min |
| red | `stale-lock:<root>` | the lock has been held ≥ 15 min and the holder is `ended`/`dead`/`stuck`/unknown |
| red | `orphan-row:<n>` | the row is `active` and its bound agent is `dead` (one waiting for a message is how a task normally waits: no alert, and no "does not match" mark in the WTS tab) |
| red | `stale-row:<n>` | an agent's `queue.py state N --text "<head>"` was an error, or ≥ 2 min later the row's state does not start with that head |
| amber | `mode-breach:<root>:<grp>` | MP or LP is `desk`/`paused`, but an agent of that group holds the lock |
| amber | `waiting-free:<agent>` | a waiter exists and the lock has been free ≥ 2 min |
| amber | `stuck:<agent>` | state `stuck` |
| amber | `caffeinate:<root>` | caffeinate is off while any row is open or any agent is `running`/`thinking` |

Dismiss and snooze happen in the page (localStorage, keyed by `key + title`, so a changed condition shows again).
Browser notifications fire once per new red key (§9.8).

## 7b. Events (`feed.py`)

Alerts say what is wrong now and go when it is fixed; the Events tab says what happened, so you can catch up after
being away. Each tick is compared with the last, and each change becomes an event: `{id, t, cat, sev, icon, title,
detail}` plus, when they apply, `agent` (selectable), `n` (task), `group`, `notes`, `dur`, `end`, `model`.

| cat | Events | Extra |
|---|---|---|
| task | queued (its title, runs on); started / resumed; paused; on hold; needs you; done; reviewed by the lead; accepted (gone from the table after done) or left the queue; moved HP → LP; queued again; HP worker paused / stopped / running again; MP/LP set to running / desk-only / paused | the row's title; the State without its head; how long it took (from its start, or its agent's); notes link |
| agent | started (by the lead) or spawned by another agent; finished; stopped by you; died; looks stuck; the lead waiting for you; usage limit reached / lifted; the lead's context compacted | what it was started for; its model; its last words when it finishes; how long it ran |
| window | a hold, one event per hold (`HP 213 holds win1`, then `held win1 08:30–08:34 · 4m`, updated in place); a row waiting for a window and getting one; a window reserved for / freed from your shows; the app opened / closed | holder, its lock text, how long |
| alert | raised, then marked resolved in place: the alerts no other event tells (stale lock, orphaned or stale row, mode breach, window free while agents wait, caffeinate off) | the alert's detail; how long it was open |
| session | the session started / ended; caffeinate on / off | |

Kept in memory only (ccprobe writes nothing): 24 h, at most 600 per session and per project queue. After a restart,
first sight puts back what the model dates: agents' starts and ends, rows done (their `done HH:MM`), windows held
since their lock's time. A row merely present is not news. Per session, the model carries `feed: {rev, recent}` (the
last 60 ids with kind and severity) for the tab's unread count; the list itself comes from `/api/feed?s=` while the
tab is open, fetched again when `rev` changes. The tab: filter chips per kind (Windows off at first: it is the
busiest), days as headers, newest first, a cyan edge on what came since you last had it open, the agent's name a link
to it on the graph, a notes link for a task with notes. Task done is no longer an info alert, and the HP state file
is no longer checked against the queue or the worker: the Events tab and the queue tell those.

## 8. Server (`server.py`) and security

- `ThreadingHTTPServer` on **127.0.0.1** (default port 8787). `--host` other than loopback is refused unless
  `--i-know-this-exposes-transcripts` is given.
- **Token:** 32 random bytes in `~/.config/ccprobe/token` (mode 600, created on first run). `GET /?t=<token>` sets an
  `HttpOnly; SameSite=Strict` cookie and redirects to `/`. Every `/api/*` route and `/` require the cookie (or an
  `X-Ccprobe-Token` header). The CLI prints the URL with the token, and `--open` opens it.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (this guards against DNS rebinding). There are no CORS headers.
  Responses set `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and the CSP `default-src 'self'; img-src 'self'
  data:; style-src 'self'; script-src 'self'; connect-src 'self'`.
- Routes: `/` (index.html), `/static/<allow-listed name>`, `/api/state` (JSON), `/api/events` (SSE), `/api/health`.
  **There is no file-path endpoint.**
- **Redaction:** before anything enters the model, `sk-ant-…`, `sk-…`, `ghp_…`, `Bearer …`, `token=…`,
  `password=…` and `Authorization:` values become `‹redacted›`. Arguments are cut to 110 chars.
- ccprobe writes nothing except its own token file.
- The model never includes `messagingSocketPath`, `bridgeSessionId` or any `.key` file.

## 9. The page (`static/`)

### 9.1 Theme and tokens
- Every colour is a CSS token on `:root`. These come from ui.md §1: the dark "observatory" set, and the light "daylight
  blueprint" set with darker accents, a dot grid instead of stars, and halos instead of blur.
- JS uses only `var(--x)` strings, never hex values.
- `theme.js` is loaded synchronously in `<head>` and sets `data-theme` from settings or `prefers-color-scheme` before the
  first paint. `System` follows OS changes live.
- Contrast: `--muted ≥ 4.5:1` (`#7d8ab0` dark), and `--dim` is used for decoration only.

### 9.2 Layout
- The header is one line, with no wrap:
  - left: brand, connection pill;
  - middle: window chip, HP chip, MP and LP chips;
  - right: alerts badge, ⚙.
- Rail (230 px): the session list with a status dot, project name, tmux tag, agent-count badge, status and since. The
  starting selection is the busiest session with a WTS, else the first busy one, else the first.
- Stage: the graph SVG, with a ticker at the top left and a collapsible legend at the bottom left.
- Side panel (380 px), with three tabs:
  - **Agent:** the selected node.
  - **WTS:** the project's tables.
  - **Alerts.**
- Timeline (bottom).
- Below 1100 px the panes stack: rail on top as horizontal cards, graph at 65 vh, then panel, then timeline.

### 9.3 Graph: role-band layout (ui.md §3)
- **Virtual space:** 1100 wide; the height grows with content.
- **Row 0:** the lead, top centre.
- **Row 1:**
  - the HP worker in the centre-left;
  - running MP/LP agents to its right, ordered by task number;
  - other running agents, the helpers with no anchor, after them.
- **Satellites:** helpers with an anchor sit on fixed angular slots around it, assigned in spawn order: below the
  anchor ±35°, then ±70°, at radius 150.
- **Parked column (right):** agents whose state is `waiting_window` or whose row is paused/parked, sorted by task
  number. With more than 4, it becomes 2 columns.
- **Resource row (bottom):** the HP queue card (left) and a card per window slot, spread evenly about the lead; each
  holder has a red line to the card of the slot it holds.
- **Finished** agents (`ended` + done for over 2 min, or `dead`): they dim to 35 % and shrink to 0.7×. After 2 min more
  they collapse into a "✓ N finished" chip under their anchor or the lead; clicking it expands them. The "Show finished"
  setting hides them entirely.
- **Stability:** `slotOf: Map(id → slot)` is reassigned only when the set of nodes or a node's band changes, and
  nodes move with a 400 ms transform tween.
- **Keyed DOM:** `nodes: Map(id → parts)` and `edges: Map(key → parts)`. Each tick only calls `setAttribute` and
  `textContent` on what changed. There is no `innerHTML` wipe.
- **Cards:** at most 3 speech bubbles and 3 tool cards. The selected node goes first, then the most recently active.
  - Candidate positions E, SE, NE, W, SW, NW.
  - Take the first rect that hits no node box and no placed card. Text is measured with a canvas `measureText`.
  - Each card is opaque, tethered by a 1 px line in the node colour, and drawn above the edges. When nothing fits, it
    is shown only on hover or selection.
  - The bubble header is "<name> says".
- **Edge labels** get a `paint-order: stroke` halo. The spawn-edge label is dropped.
- **Viewport:**
  - Fit-to-content on layout change (unless the user has panned).
  - Wheel zoom (0.4–3×) and drag to pan.
  - `F` fits; when the user has panned and the layout then changes, a "⤢ Fit" button appears.

### 9.4 Status vocabulary and icons
- There is one mapping: model state key / row kind → `{icon, colour, word}`:
  - `running` ⏵ green
  - `thinking` ⋯ cyan
  - `waiting`/`polling` ⏳ slate
  - `waiting_window` and `parked` ✋ amber
  - `asks`/`waiting_user` ? rose
  - `ended`/`done` ✓ green, dimmed
  - `stuck` ! amber
  - `dead` ✕ red
  - `queued` ⏳ slate
- The icons are an inline SVG `<symbol>` sprite drawn with `currentColor`. There is **no emoji** in the SVG, the chips or
  the status cells. Quoted text (said / WTS task text) is shown as written.

### 9.5 Node anatomy
Each node shows:
- a halo;
- a hex in `--c`;
- in the hex, who it is, in the hex's colour: a small line over a big one, the group over the task and its round
  (`HP` / `184e`, `MP` / `111`), a helper's name split at its number (`adv` / `184d`), or `Lead`; one line when the
  hex is small or the name has no number;
- a status badge at its top-left corner, only when it is not at work (the spinning arc says when it is): the state's
  **mark** (`markOf`, `MARK`), an outlined disc whose ring and icon take the mark's colour. Each kind of waiting has
  its own icon and a colour far from the others: `msg` ✈ cyan (a message: a worker between turns or waiting for its
  advisor), `blender` the Blender logo in its orange with its own white and blue eye (`state.what` from the job's
  command), `job` ⚙ magenta (any other job), `poll` ↻ lime, `paused` ⏸ yellow, `window` four squares violet, `hold` ⧗
  violet, `stuck` a clock red, `dead` ✕ red, `done` ✓ blue, the lead's `ask` ? rose. The status line and the WTS agent
  line show the same mark. The other corners: "!" alerts (red), notes (a green page), the window's lock (red);
- under the hex, the task's title (a helper: its job, without its name; the lead and a finished agent: their name),
  and for the lead its session title below it;
- a status line with its icon;
- a context bar;
- a meta line: `810k / 1M · Bash 6m`;
- an alert `!` badge.

The selected node gets a dashed outer hex. Nodes are focusable (`tabindex=0`, with an aria-label).

### 9.6 Motion (ui.md §5)
- **Events animate:**
  - a message pulse (a glowing spot, 2.4 s: it swells in, travels, then flares at the receiver; at most 3 at a time, with a burst collapsed into `×N`);
  - a tool-card pop (150 ms) that fades out 8 s after the last call;
  - a state-change ring flash (600 ms);
  - node enter (300 ms).
- **Steady state:**
  - one spinning arc per `running`/`thinking` node;
  - a dash flow only on hot edges;
  - no blinking, and no breathing dots.
  - The arcs and the dash flow step together on one clock, 30 times a second (`FLOW_FPS`), not on every refresh. Each
    step makes Firefox redraw the graph on the CPU (in its GPU process); on a 6K screen at 120 Hz or more that took 1-2.4
    cores; at 30 steps a second the motion looks the same.
- There are no blur filters on animated elements. All pulses share one rAF loop.
- **Hidden tab:** `body.paused` stops CSS animation and the rAF loop, while SSE keeps updating the state. On return the
  ticker shows "+N events while away" and the missed pulses are not replayed.
- **Motion setting:**
  - **Full**.
  - **Reduced** (the default when `prefers-reduced-motion` is set): no spin or dash flow, and a pulse becomes a 400 ms
    edge highlight.
  - **Off**.

### 9.7 Side panel, WTS, timeline
- **Agent tab** (revised 2026-10-24, §19): title and status; description · model; from <parent> · started · active;
  Now; task cell with the Brief fold; context; Report; files changed; recent tools; messages.
- **WTS tab:**
  - the window line as a neutral row (holder · since hh:mm:ss · waiters);
  - group headers `HP · ⏵ running 152 · Worker (Opus 5.5)`, `MP · desk-only`, `LP · desk-only`;
    a group none of whose rows can run (only done rows, or paused ones under a running mode, or none) reads `idle`
    (moon), here and in the header chips; the tip keeps the mode its file says;
  - a sticky jump bar `HP 17 · MP 6 · LP 3`;
  - icon rows. The current row is expanded, and queued rows are one line that expands on click.
  - Clicking a row with an agent selects it in the graph and flashes the node.
  - Next to a bound row's State it shows that agent's **observed** state, e.g. `in progress 17:04 · agent: running
    Bash 2m`. A mismatch shows in amber.
- **Alerts tab:**
  - sorted by severity, then by since;
  - each alert shows its time, the agent as a link, the detail, and Dismiss / Snooze 1 h.
  - The badge counts undismissed alerts: red if any is red, amber otherwise, hidden at 0.
  - The title shows `(N) ccprobe`.
- **Timeline:**
  - one lane per node in graph order; finished nodes are dimmed and folded under "finished (n)";
  - dots coloured by tool, with dense bursts binned into bars;
  - message arcs at 0.25 opacity, or 0.9 when they touch the selected node;
  - compaction markers;
  - a fixed "now" line at the right;
  - the span comes from settings (15m / 45m / 2h / 6h);
  - clicking a lane label selects its node.
  - Tooltips are a single shared HTML tooltip div (150 ms delay), not SVG `<title>`.

### 9.8 Settings gear (ui.md §2)
- A popover with these settings:
  - Theme (System / Light / Dark)
  - Motion (Full / Reduced / Off)
  - Timeline (15m / 45m / 2h / 6h)
  - Show finished agents
  - Compact nodes
  - Desktop notifications, which requests permission when switched on and fires on a new red alert or a new `asks`
    while the tab is hidden
  - Reset layout and dismissed alerts
- It also shows the version and server line ("ccprobe 1.0 · :8787 · live 1 s ago").
- Settings are stored in `localStorage['ccprobe.settings']` = `{v:1,…}`, wrapped in try/catch.

### 9.9 Connection states
- The connection pill shows one of:
  - `● Live · 1s` (green);
  - `● Stale · 12s` (amber, after 5 s without a message or ping);
  - `● Server unreachable · retrying` (red), where the graph dims to 50 % and keeps the last data.
- The other states are:
  - Loading: a skeleton hex and "Connecting…".
  - No sessions: "No Claude Code sessions running", with a hint.
  - When EventSource fails 3 times, it falls back to polling `/api/state` every 2 s.

## 10. Model JSON (served by `/api/state` and the SSE `data:`)
```json
{ "v": 1, "now": 1792713000.1, "server": {"version": "1.0.0", "started": 0, "tick_ms": 12, "window_s": 21600,
   "parser": {"unknown_types": {"x": 3}, "decode_errors": 0, "skipped_big": 41}},
  "sessions": [{
    "id": "5e3f…", "pid": 83149, "alive": true, "name": "myproject-4a", "project": "myproject", "cwd": "…",
    "title": "Handoff 20261006", "version": "2.1.301", "status": "busy", "status_since": 0,
    "tmux": {"session": "myproject", "pane": "0.0", "title": "✳ …"} ,
    "lead": { "state": {"key": "running", "label": "Bash 12s", "since": 0}, "ctx": 179143, "ctx_max": 1000000,
              "model": "claude-opus-5-5", "said": "…", "recent": [], "last_ts": 0 },
    "agents": [{ "id": "a1c2d…", "name": "worker", "label": "worker", "desc": "Worker: HP queue", "role": "worker",
                 "task": 152, "anchor": null, "parent": "lead", "depth": 1, "model": "claude-opus-5-5",
                 "state": {"key": "running", "label": "Bash 2m", "detail": "cd ~sf/…", "since": 0},
                 "ctx": 810168, "ctx_max": 1000000, "said": "…", "recent": [], "last_ts": 0, "finished": false }],
    "edges": [{"from": "lead", "to": "a1c2d…", "kind": "spawn|msg", "hot": true}],
    "messages": [{"id": "…", "t": 0, "from": "a2e4…", "to": "a1c2d…", "kind": "send", "summary": "…"}],
    "events": {"a1c2d…": [[1792712000.2, "Bash"]]},
    "compactions": {"a1c2d…": [1792700000]},
    "wts": { "root": "…", "error": null, "hp_line": "⏩ running 152", "state_file": "running 152",
             "modes": {"MP": "desk", "LP": "desk"}, "caffeinate": true,
             "window": {"held": true, "who": "worker capture", "since": 0, "holder": "a1c2d…", "waiters": ["a3b6…"]},
             "groups": {"HP": [{"n": 152, "title": "…", "runs_on": "Worker (Opus 5.5)", "status": "⏩ in progress 17:04",
                               "kind": "active", "acc": "—", "agent": "a1c2d…"}], "MP": [], "LP": []} } }],
  "alerts": [{"key": "ctx:a4d8…", "sev": "red", "title": "LP 77: context 89% full", "detail": "…", "since": 0,
              "session": "5e3f…", "agent": "a4d8…"}] }
```
Times are epoch seconds. The page does all formatting.

## 11. Performance budget
- The collector tick runs in under 50 ms in steady state, which needs about 6 tailed agents plus 4 sessions (stat calls
  plus the new bytes). The first tick reads up to 16 MB + 4 MB × agents in view, in under 2 s. It runs in the background,
  and the page shows "Connecting…" until it finishes.
- Memory: rings are capped (events 2000 per transcript, messages 200 per session).
- Page: at most one rAF loop, and it stops when hidden. The DOM is updated in place.

## 12. Testing
- **Unit tests** (`python3 -m unittest`):
  - tailer: partial lines, truncation/inode change, huge-line skip;
  - reducer state rules on synthetic jsonl;
  - name resolution;
  - redaction;
  - alerts on synthetic models;
  - the WTS wrapper against a temp copy of a queue dir.
- **Smoke test:** run the server against the real `~/.claude`, `GET /api/state`, and check that the myproject session
  and its worker appear and that the WTS rows equal `queue.py wts` row for row (the numbers and the status text).
- **Visual check:** headless Chrome screenshots in dark and light at 1600×1000 and 900×1000.

## 13. Later (P1/P2, not in v1)
- macOS/phone push (opt-in, with no content);
- a "lead needs you" check from `tmux capture-pane`;
- per-task history and an "awaiting acceptance" list;
- a full message text view;
- an opt-in hooks receiver (`POST /hook`, with `--print-hooks` to print the snippet);
- a multi-project overview;
- a replay scrubber;
- a file heatmap;
- token burn sparklines;
- opt-in actions (copy to the clipboard first);
- a phone "glance list" under 760 px.

## 14. Risks
| Risk | Mitigation |
|---|---|
| The transcript format changes between Claude Code versions | `.get()` everywhere, unknown types counted and shown in the footer, and state falls back to `unknown` |
| Backfill misses an old spawn, so the parent is unknown | Fall back to the lead when `spawnDepth == 1`. The edge still exists |
| `queue.py` changes its API | The wrapper catches the error, falls back to the raw `wts` text, and sets `wts.error` |
| Very large ticks right after a 1 GB file catches up | A 32 MB per-tick cap per file |
| Exposure of transcript content | Loopback only, a token, a Host check, CSP, redaction, no file endpoint |

## 15. Revision 2: what the audit changed (implemented)

| Audit item | Resolution in the code |
|---|---|
| B1: a hand-back's result and mid-turn text | `agents.py`: only conversational entries move `last_kind`. A result for a call never seen pending is ignored. Text is an end only with `end_turn`. One time ladder, built from entry timestamps plus `api-request` lines, replaces file growth: thinking under 3 min, then "thinking · quiet Nm", then stuck? from 10 min. |
| B2: `origin` entries | `_user` treats any `user` entry with `origin.kind` as a receipt, the same as `queued_command`. `bg_pending` is cleared from `<tool-use-id>` in either form. |
| B3: the lead's state | `lead_state` comes from the transcript. `turn_duration`, `end_turn` or a hand-back means `waiting_user`; a pending tool means running ("…or waiting for your approval?" after 60 s); otherwise the ladder. The registry is used only for `shell`, dead and the no-entries fallback. |
| M1: lock holder and waiters | The holder is the transcript whose Bash last wrote a literal `echo "…" > …/who` prefix that the current `who` starts with. Fallbacks: `lead…`, then a `meta.name` match on the first word, then `MP/LP/HP/task N` → the bound agent. A holder in its lock loop shows as "holds the window · Nm" and is never a waiter. Each window slot gets its own holder this way; with two slots the state says "holds win1" (0-based, as the worker skill names them) or "holds both windows"; a slot with a `<lock>.reserved` file is kept for the user's shows, and the stale-lock alert is per slot. |
| M2: false alerts | Each rule is rewritten as the audit says (`alerts.py`). `orphan-row` checks related live agents and the lead. `stale-row` fires only on failed writes. `usage-limit` is a state, which also suppresses `stuck`. `waiting-free` counts only polling waiters in a running group. `caffeinate` fires only when work is running. `hp-state` drops the deliberate-stop clause and gets grace periods. `stale-lock` is not raised while the app runs. |
| M3: `__pycache__` | `sys.dont_write_bytecode` during the import, `BaseException` caught, and the previous module kept on a failed reload. |
| M4: CSP vs inline styles | No `style=` in markup. Colours come from `c-<colour>` classes setting `--c`, and sizes from SVG attributes or CSSOM. |
| M5: exact ids | Parent = `meta.parentAgentId`, else the lead. A send's target is the result's `resumedAgentId`, else a name or raw id. A hand-back's recipient is the transcript holding the matching `origin.handback` receipt, else the parent. |
| M6: torn reads | `stat` before and after; a changed or empty file, or more than 20 % fewer rows, keeps the last good WTS. |
| M7: scope | Built anyway: the collision-placed cards, wheel and drag zoom with Fit, timeline binning and arcs, the finished chip, compact nodes. **Not built:** the stacked layout under 760 px, arrow-key navigation, the `×N` burst label. |
| Minor | Time-based backfill (2 h, capped at 64 MB for main and 32 MB for agents). The change hash ignores clocks. One cookie per port (`ccprobe_<port>`, 30 d). Token created with `O_EXCL`. The `--host` value is allowed in the Host check. More redaction patterns, applied to said, summaries, desc, `who` and WTS text. A Bash past its timeout + 2 min is stuck?. Known-ignored entry types. WTS deduplicated by root. |

Testing as built: 21 unit tests (`python3 -m unittest discover -s tests`). `python3 tests/smoke_live.py` checks the live
sessions, and that the WTS rows match `queue.py wts`. Headless Chrome screenshots in dark and light use `#poll`, because
headless virtual time never settles with an open EventSource.


## 16. Layout, revision 3 (2026-10-23)

Measured on live data before the change, the "spawned by" lines from the lead caused every crossing (10 of 10 with the
finished agents expanded), and adding or removing one agent re-centred its whole row. The rework follows the standard
methods, kept small:

- **Fewer lines (clutter):** the lead's spawn lines are drawn only for a new agent's first 2 minutes or for the
  selected agent. Messages fade after the first minute and go after 10. Selection dims every other line
  (focus + context).
- **Layered drawing (Sugiyama-style):** the lead, then a grid of rows at fixed heights, then finished, then the
  shelf. Order within a row is chosen to cut crossings. The grid has 5, 7 or 9 columns per session: the count that
  lets Fit draw the graph biggest in the graph area (Fit never zooms past 1:1; within 4%, the more columns), so a wide window
  takes many agents side by side instead of stacking rows that shrink everything.
- **Incremental, mental-map preserving (DynaDAG; yFiles incremental hints; ELK semi-interactive):** each agent keeps its
  slot (remembered per session, by line of succession: the HP worker, or the agent name). A newcomer takes the free
  slot with the least cost: distance to its neighbours, plus 5 per row away, plus 2 per crossing it adds. A freed
  slot stays reserved for 2 minutes (5 for a slot with an heir: the HP worker's, a reused name's). Only after 2 quiet
  minutes (no agent came or went), or on Tidy: gaps close (stepping around reserved slots), a helper away from the
  agent it serves goes back under it if a slot there is free (tried at most once a minute), and swaps that remove 2+
  crossings happen (at most every 5 minutes). At those moments too, when the column count no longer suits (the
  window resized, agents came or went) or the agents spread over more rows than they fill, they flow in reading order
  into full rows centred under the lead, and the helpers go back under them.
- **Balance (2026-10-25):** a row used to keep to one side: a newcomer whose only line was to the lead went to the
  row's end (the worker far left, others far right), since the lead was not counted as a neighbour, and closing gaps
  never changed sides. Now the lead counts as the middle of the top row, a slot's cost adds .3 per column the row's
  middle moves off the lead (a tie sends the worker left, others right), and closing up (quiet time or Tidy) slides
  each row back under the lead: an odd row centred, an even row split about the lead when those places are free (−1 1,
  −2 −1 1 2). A helper under an agent that slid moves with it when its row has room. First sight uses the same shape,
  and Tidy lights up for an off-centre row.
- **HP workers (2026-10-25):** the state file may name more than one running HP task (`running 128 171`); each gets
  its worker: the newest agent named for it (`hp128`, or with a round, `hp128r3`, `hp141b`) or, unnamed, described as
  it, an unfinished one first. Before, only the first number counted and only a bare `hp<N>` name, so a redo agent
  `hp128r3` was a plain helper while the finished first round kept the row and was taken for the window's holder.
- **Routing:** lines go from under the upper agent's labels to the top of the lower one (S-curves), dip into the
  channel for agents in the same row, and run down column gaps past rows in between. Parallel runs get lanes.

Verified with scripted checks (scratchpad `layout_test.py`, `stress_test.py`, `cross_test.py`):
- **Stability:** no existing agent moves for a new agent, a hidden agent, a blocked agent, a new helper or an HP
  handover (the new worker takes the old slot), and places survive a reload.
- **Busy synthetic scene (18 agents):** crossings went 32 → 2, and lines through an agent 8 → 0.

## 17. Token statistics (2026-10-23)

- **Source.** Each `assistant` entry's `message.usage`: input, cache creation, cache read and output tokens (thinking is
  in output). One reply is written as one entry per content block, all with the same message id and identical usage,
  so the last entry per id wins (a recent-id map undoes the earlier one). Usage quoted inside a `user` entry (an Agent
  tool's result) is not counted: a subagent counts once, in its own file. Checked on live transcripts: 376 of 469
  replies were split, none with differing usage.
- **Reading** (`ccprobe/tokens.py`). A `Ledger` per transcript reads forward from byte 0, once, then only appended
  bytes. Only lines holding `"usage":{` and `"type":"assistant"` are decoded; a reply line over 8 MB has its usage object
  cut out of the raw bytes. 5.3 GB (one session, 116 files) count in about 3 s. A ledger keeps totals, per-day totals and
  reply counts, compactions, and per-minute buckets for the last 6 h 10 m. A replaced or truncated file is counted again.
- **Books.** One background thread (`Books.run`, every 3 s) reads the files the collector asked for (`want`: each
  session's lead transcript and every subagent file, in view or not) first, then every transcript under
  `~/.claude/projects` written today, for the all-sessions total. Ledgers no one asked for in 10 minutes and not written
  today are dropped. `--once` counts synchronously. Nothing is written anywhere.
- **Model.** `session.tokens` = `{v: [in, cw, cr, out], today, n, cx, ready, agents: [{id, label, role, task, shown,
  finished, v, n, cx, model}], tasks: {n: {v, agents}}, series: {t0, roles, rows: [[minute, role, fresh, read, out]]}}`;
  `lead.tokens` and each agent's `tokens` = its own `{v, n, cx, model}`; top level `tokens_today` = `{day, v, n,
  ready}`. An agent's task is its name (`hp129`, `mp112`, `adv129` when 129 is a row) or description (`Task 74: …`),
  else its parent agent's.
- **UI** (advice: a UI advisor's spec, kept here in short). Output is the headline: cache reads are context × replies
  and would flatten everything. Three tiles pick one metric for the whole tab, each on its own linear scale (no log
  scale). Kinds get no hue; hue stays role (lead cyan, HP rose, MP amber, LP green, helpers violet). `tfmt` never
  exceeds 5 characters; exact values in tooltips with thin-space grouping. Agent list: top 12 then "show all"; finished
  agents stay (✓, muted, faded bar). Task list: top 8. Lists keep their order while the pointer is on them. The chart
  bins by 1 minute up to 2 h, 3 minutes at 6 h; the minute still going is drawn faded. The tab shows when the session
  has a counted reply; the chip sits last among the top chips, next to the bell, and opens a per-session popover.

## 18. A still view, smooth flow (2026-10-23)

- **View hysteresis.** `fit(core, cards)` fits the graph's own boxes (agents and their labels, the
  shelf); speech and tool cards are checked against it. The current view is kept while it still *serves*: every box
  is at least 8 px inside what the screen shows, the empty margins left/right (and top/bottom) differ by no more than
  40% of the view, and the zoom a fresh fit would pick is within 6%. Otherwise the view goes to the graph's own
  centred fit, or to the fit around the cards too when they would stick out of that one. A card going away never
  shifts the view back by itself. `placeCards` tries the candidate spots inside the current view first.
- **Line flow.** The CSS loop (28 px per 1.2 s) jumped 4 px each loop on the violet lines (dash period 12) and stopped
  dead 60 s after a message. Now `flowStep` (30 steps a second, only while a line flows or an arc turns) moves `stroke-dashoffset` itself: 23 px/s
  for a busy task line and for a message line in its first minute, easing linearly to 0 at 5 minutes; the speed eases
  toward its target with a 0.7 s time constant, and the offset wraps at 5040 (a multiple of every dash period). Line
  opacity changes (hot → faint, dimming) fade over 0.8 s. Full motion only.

- **Selection.** The selected (or keyboard-focused) hex fills with a tint of its own border colour (18% dark theme, 10%
  light) and its border thickens to 3; the outer selection ring is gone, so the busy arc (r + 10) never meets it.
  Dashed still means blocked, glow active, faded finished.
- **Blocked, and why.** The dashed hex says an agent is blocked; its corner badge (in the hex's colour) and every
  status pill say why: an amber window for waiting for the window (it goes on by itself), an amber
  hourglass for on hold (a "waiting …"/"hold" row that is not about the window; the agent's label is the row's own
  words), a slate ⏸ for paused by hand (until someone resumes it). Paused groups (HP PAUSED, MP/LP paused) are slate
  too, in the WTS headers and the top chips.

## 19. The agent panel's detail (2026-10-24)

A Claude Code expert ranked what helps most when supervising an agent (checked against 40 real agents); a UI advisor laid
it out. What it is doing, what it was asked, what it reported, what it changed, and whether it is in trouble:

- **Served on demand.** `GET /api/agent?s=<session>&a=<agent|lead>` returns one agent's detail, read from its
  `Transcript` under `Collector.tr_lock` (the tick holds it while the reducers change). The page asks only for the agent
  on screen, at most every 2 s, so `/api/state` does not grow by kilobytes per agent.
- **Now:** a Bash call's `input.description` (95% have one) is the headline; the command follows, without a leading
  `cd <dir>;`, with `/private/tmp/claude-N/<project>/<session>/` shortened to `…/` and home as `~`. `tool_arg` reads a
  Bash call as its description everywhere (state detail, ticker, recent tools).
- **Brief:** the file's first `user` entry, read once from its head (64 KB, more only if that line is longer), so it
  works when the 2 MB back-fill missed the start. Clipped to 4 KB, redacted. The "You are …" first paragraph is
  skipped in the preview and shown dim when expanded.
- **Report:** the latest `SubagentHandback` `input.message` (2.4 KB kept), and how many hand-backs are in view.
- **Files changed:** Edit/Write results (`toolUseResult.filePath`, `structuredPatch`) and Bash diffs
  (`toolUseResult.bashEditDiff`). A diff marked `shared` carries other agents' edits in the same tree: a file counts as
  this agent's only when its command names the file; the rest are listed apart as "seen in shared tree", and
  `moreFiles` only adds to that count.
- **Trouble:** failed tool results (`is_error`), permission denials (`permissionDecision.decision == "reject"`, not
  counted as failures), and the most repeated identical command (3× or more). Counts, never alarms: many "exit 1" are
  an empty grep. The last error's line skips a bare "Exit code N" and a Python traceback's header.
- **Background jobs:** `run_in_background` calls until their task notification (matched by tool-use id or task id).
- **Layout** (UI advisor): a live agent shows Now, task + Brief, context, Report, files, recent tools, messages; a
  finished one leads with its Report, then files, trouble, task + Brief, a folded "Last tools", messages; the lead keeps
  its session, pane and permissions lines. Folds keep their state per agent (`S.open`), and the last choice per part
  is the default (`ccprobe.folds`). Rebuilds keep the header at the top of the view in place, and keep focus.

## 20. Clearing alerts (2026-10-24)

Laid out with a UI advisor.
- **Signature.** Each alert carries `sig`: its title without running times (`alerts.RE_DUR`), so "stuck? silent 12m"
  stays hidden as it ticks to 13m. Hidden alerts are stored as `ccprobe.dismissed[key|sig]` (1e12 dismissed, 2e12
  cleared, or a snooze's end).
- **Clear N** (the Alerts tab's header, with counts by severity): this session only, amber and info only; red alerts
  need a decision each, so Clear is disabled when only red ones are left. One click, no confirm: **Undo** takes the
  button's place, with no timer, until you leave the tab or session (the tab stays shown meanwhile).
- **Until it changes.** `pruneDismissed` drops an entry once its alert has been absent for 120 s (and expired
  snoozes), so a new occurrence (stuck again, a second question on the same row) shows again; per-card Dismiss
  follows the same rule.
- "N hidden here · Show" un-hides this session's alerts (the ⚙ reset still resets everything); "N in other sessions →"
  does what the bell does.

## 21. Task notes (2026-10-25)

The worker skill keeps one notes file per task (`<root>/.autopilot/worker/<N>.md`, the handoff an agent knowing nothing
of the task can resume from) and the lead's briefs beside it (`<N>-brief.md`, `<N>-redo2-brief.md` …). For a finished
task they say what was done far better than the transcript, so ccprobe shows them.

- **Where:** a digest in the Agent tab (the side panel is narrow: right for an outline, wrong for tables and long
  reading) and the whole document in a reader that takes the graph's place (the widest area; the panel stays beside it
  for context; Esc gives the graph back). The WTS tab marks rows with notes, so a task whose agent is gone is reachable.
- **Digest:** the notes cut at their `##` headings (their headings vary: "The fix", "What changed", "Changes",
  "Results", "State", "Final state of …"). Sections that say what came out open by default: those headings, from the
  last "Final …" on; the rest one line each with their first line as a preview. Notes in parts (a later `#`, "# Redo 2")
  show the last part, earlier parts folded to a line. Folds follow the panel's rule (per agent; your last choice is the
  default). The whole digest is open for a finished agent, folded for a running one, under the report.
- **From the graph (2026-10-25):** a click only selects (the panel follows: selection is how the graph is read, and a
  pop-up on every click would cover it); a double-click, or Enter on the selected agent, opens the reader. A small
  page mark at the hex's lower left, ringed and tinted in the agent's colour, says there are notes; hovering lights
  and grows it (with its own tip), and clicking it opens them (the only way on a touch screen). Two HP workers at once
  each keep their place (a lineage per task, `worker:<N>`); a new task's worker takes the place of the one that went.
- **Reader:** task, group, status and title; a tab per document (notes, then briefs); contents on the left (hidden when
  narrow; full screen below 1100 px); Markdown rendered by a small escaped-first renderer (headings, nested lists,
  tables, quotes, code; **bold**, `code`); the pictures the notes name in a strip and as links where they are named,
  full size in a lightbox (← →, Esc).
- **Server:** `/api/notes?s=&n=` returns the documents (redacted, up to 400 KB each) and the pictures: paths the notes
  name (`…/181/sheet.png`, or a bare name looked for in the worker folder, its `<N>/` folder and every folder the notes
  mention) that resolve inside the project, up to 40. `/api/notes-pic?s=&n=&i=` serves one by index: no URL names a
  file. The model carries only the notes' time (each WTS row's `notes`, each agent's `notes: {n, t}`), so the page
  fetches a document again only when it changes.

