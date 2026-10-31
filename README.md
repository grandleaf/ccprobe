# ccprobe

A live, read-only dashboard of every Claude Code session on this Mac (in tmux or not), the agents they spawn, and the
background-worker queue (WTS). It needs only Python 3.10+, with no installs.

```
python3 ccprobe.py --open        # serve on http://127.0.0.1:8787 and open it (the URL carries the access token)
python3 ccprobe.py --url         # print the URL with its token again
python3 ccprobe.py --once        # one collection as JSON (debugging)
python3 ccprobe.py --help        # --port, --window 6h, --ctx-max, --interval, --no-token
```

What you see:
- **Graph.** Each hexagon says who it is, in its own colour: `HP` over `184e` (task 184, its round e), `adv` over
  `184d` for a helper, `Lead` for the lead; under it, the task's title. A badge at its top-left corner says why it is
  not at work, each kind of waiting with its own icon and colour: ✈ cyan waiting for a message, the Blender logo
  waiting on Blender, ⚙ magenta on another job (a build, tests), ↻ lime polling, ⏸ yellow paused by hand, four
  violet squares waiting for the window, ⧗ violet on hold, a red clock stuck, ✕ red dead, ✓ blue finished, and the
  lead's rose ? waiting for you. A busy agent has none, only its spinning arc. The status line under the hex uses the
  same icon and colour. Bottom left, a green page: the task has notes; bottom right, a red lock: it holds the window. The lead sits on top. Below it is a grid of rows at fixed heights, 5, 7 or 9 places per row (whichever draws the graph biggest in its
  area: a wide window puts more agents side by side); every agent keeps its place. A new agent goes to the free place nearest the agents it works with (a helper under the agent it serves;
  the lead counts as the middle of the top row), chosen so it adds the fewest crossing lines and keeps its row even about
  the lead. A blocked agent stays where it is with a dashed outline. A fresh HP
  worker takes the previous worker's place, and a reused name takes its predecessor's. When an agent leaves, its place
  stays free for 2 minutes (5 for the HP worker's or a reused name's place, so the successor lands there). Once no
  agent has come or gone for 2 minutes, the rows close up around places still held and slide back under the lead; agents left in lower rows while the rows above have room move up into them, in order (an
  even row splits about it: two agents sit one each side, the lead between them; a helper moves with its agent), a helper left away from the agent
  it serves goes back under it (when a place there is free), and neighbours that would remove 2+ crossings are swapped
  at most every 5 minutes. **Tidy** (top right, shown when there is something to
  tidy) does it all at once. Places survive a reload. The view itself stays put while everything is on screen: a speech
  or tool card that appears (it takes a free spot inside the view when there is one) moves the view only if it would
  stick out, or if the empty space would pile up on one side (the margins differ by more than 40% of the view).
- **Lines** carry information only: tasks (amber, arrow at the agent doing the work), recent messages (violet, fading
  after the first minute, gone after 10; their dashes flow at full speed for a minute after a message, then slow to a
  stop by 5 minutes), and spawns by another agent. A new agent's "spawned by" line shows for 2
  minutes. Selecting an agent shows all of its lines and dims the rest; ⚙ "Show all relationships" draws every line all the
  time (the placement does not change). Lines run in the channels between rows and down
  the gaps between columns, never across an agent. A chevron travels along a line for every message, pointing from
  sender to receiver. Timeline arcs end in an arrowhead on the receiver's lane.
- **The shelf** at the bottom holds the HP queue and a card per window slot, always in the same place. A project
  can share one window (`lock` in its `config.json`) or several side by side (`locks`, a list: two game windows read
  `win0` and `win1`, counted from 0 as the worker skill names them); each card is in its slot's colour while held, with
  its holder and for how long, slate while it is reserved for your shows (a `<lock>.reserved` file; no worker takes
  it), else green and "free".
  The agent holding a window has a red lock mark, and a red line runs from it to that window's card; with several
  windows each has its own colour throughout (its holder's lock, line, card, header segment and WTS lines): win0
  red, win1 orange, win2 gold. With several
  slots the header's window chip has a segment per slot, and an agent waiting reads "waiting for a window" (any
  slot will do). An older agent whose name a newer one now
  holds reads "lp74 (earlier)" and folds into "N finished · show" (top right) once its turn ends; so do earlier HP agents.
- **Hiding agents.** "Clear N done" (top right) hides the finished and dead agents drawn on the
  graph (not the ones already folded into "N finished · show"); idle and parked agents are not done, so it leaves them.
  ⚙ "Auto-hide done agents" does it by itself, a minute after each one finishes or dies (never the one you have
  selected; one you bring back stays). "N hidden · show" (top right, next to Fit) brings them all back. A hidden agent comes back by itself as soon as
  it writes anything new, and opening it from an alert or a message link shows it again. Hiding happens only in this
  browser and only on the page; it never stops an agent.
- **Unseen sessions:** a tmux session that no terminal shows (its window was closed) is greyed out in the sessions
  list and reads "no terminal". It still runs; hover over it to see the `tmux attach` command. The monitor-with-a-slash button at the
  top of the list hides them (the session you are looking at stays).
- **Sessions list order:** four icon buttons at its top. ⚠ needs you first (red alerts or a question for you, then busy,
  idle, dead; sessions with no terminal open after the rest) · 🕘 recently active first · A–Z · ⠿ custom. Custom starts as A–Z. Drag a card to move it
  (the others slide aside), or focus it and press Alt+↑/↓ (Alt+Shift+↑/↓ to the top or bottom). New sessions slot in
  by A–Z. The order is saved per project directory in this browser. Live reorders in the other modes wait while
  the pointer is over the list, and happen at most every 4 s.
- **States** come from the transcripts (DESIGN.md §5.5): running a tool (for how long), thinking, quiet, stuck?, polling,
  waiting for the window (amber window icon: it goes on by itself), paused by hand (grey ⏸: until someone
  resumes it), on hold for something else (amber hourglass), holds the window, waiting for a message (its turn ended) or done, waiting on Blender / a build / its job, idle or waiting for you (the lead: waiting for you only
  when it asked you a question or left a plan for you to approve), dead.
- **Agent tab** (click an agent). **Now:** what it is doing in its own words (a Bash call's description), the command
  under it (without the leading `cd <project>;`, temp paths shortened; "whole command" opens it), its background jobs,
  and quiet trouble chips (N failed · N denied · same command N×, with the last error's line). **Brief:** the prompt it
  was started with, and **Report:** its latest hand-back (round N; first for a finished agent), both folded to a few
  lines with "show all". **Files changed:** the files it edited, with edits and +/− lines; files a shared working tree
  shows changed by others sit apart, folded ("seen in shared tree"). Recent tools show descriptions, with failed calls
  marked. Folds remember your choice per agent, and your last choice becomes the default. The detail comes from
  `/api/agent` for the one agent on screen, so the page's data stays small. **Notes:** an agent that worked on a WTS
  task with a notes file (the worker's `.autopilot/worker/<N>.md`) shows them under its report, cut into their
  sections: the outcome (the fix, what changed, results, the final state, what is left open) open, the rest one line
  each; notes in parts (redo 2, redo 3) show the latest part and fold the earlier ones. Open for a finished agent,
  folded for a running one. **Read the notes** opens the whole document over the graph (the panel stays beside it):
  contents on the left, tables, the pictures the notes name (click one for full size, ← → for the others) and the
  lead's briefs as tabs. Esc closes it. On the graph, a green page badge says its task has notes:
  click the mark, double-click the agent, or press Enter on the selected one to read them; a click elsewhere on the
  agent still just selects.
- **Events tab** (key `3` when there is a queue). What happened, newest first, grouped by day, to catch up after
  being away: tasks queued, started, paused, on hold, needing you, done (how long, a notes link), reviewed, accepted;
  agents started or spawned (what for, the model), finished (their last words, how long they ran), stopped, dead,
  stuck; the lead waiting for you, usage limits, its context compacted; each window hold (who, from when to when);
  alerts raised and resolved; caffeinate on and off. Chips filter by kind (Windows, the busiest, starts off). The tab
  counts what came since you last opened it (red when one needs you); those have a cyan edge. An agent's name selects
  it on the graph. Kept by the server in memory for 24 h; after a restart what the queue and the transcripts date is
  filled back in.
- **WTS tab** (only for a session with a worker queue). This is the same table as `queue.py wts`; the server imports it read-only. A group with nothing that can run (no rows, only done rows, or only paused ones) reads 🌙 idle, not running, in its heading and in the header chips. Next to each bound row is what
  its agent is actually doing, and amber marks a mismatch. A row in progress reads as its ▶, its start and how long
  so far (`▶ 17:24 · 3h 41m`); paused and asking rows read as their icon too, parked keeps its word, and all say for
  how long; a done row is an outlined violet pill with when it was marked done and how long its agent worked on it
  (`✓ 21:40 · 1h 59m`). The start and length come from the task's latest run, the newest of: its agent in view, its own
  agent's first and last reply in the session's whole history (so older MP rows get theirs too), and the row's own
  State writes found in the transcripts (a row done inside another task). The State has HH:MM only: its day is that of
  the row's latest State write, and a day that is not today is shown (`24 Oct 15:06`); a done row nothing dates keeps
  its bare time. The State's own words are in the tooltip.
  A row with notes has a page icon beside its number: click it (or a row with no agent) to read them.
  Its top has a line per window slot (held by whom, since when, which agent), and with several slots a line naming
  the agents waiting for one. The row whose agent holds a window is red, as on the graph: a red edge and number, and
  its agent line red with the lock (`agent HP 175: holds the window · 4m`, or `holds win1 · 4m` with two slots); an
  agent waiting for the window has its line in violet with the window.
- **Alerts tab** (only while the session has alerts; the bell at the top counts every session's and opens the worst). Needs-you rows, usage limits, orphaned or stale rows, a stale lock,
  stuck agents, caffeinate off while work runs. Each alert can be dismissed or snoozed. The header counts them by
  severity, and **Clear N** hides this session's amber and info alerts until they change (red ones, which need you,
  are dismissed one at a time, or all together with **Dismiss all**, which shows when there is a red one); **Undo**
  stays in its place until you leave the tab. "N hidden here · Show" brings
  them back, and "N in other sessions →" goes to the worst one elsewhere. A hidden alert shows again once its problem
  has been gone for 2 minutes and comes back (stuck again, another question); a running time in its title ("silent
  12m") does not count as a change. Desktop notifications are opt-in (⚙).
- **Tokens tab** (key `4`). Every API reply of the session counted once, over its whole life: the lead and every agent it
  ever had, not only those on the graph. Three tiles: **Output** (what the models wrote, thinking included), **Fresh in**
  (input + cache writes) and **Cache read** (the context read again on every reply, usually 95%+ of all tokens). Click
  one to pick the metric the rest of the tab shows: the split by role, a per-minute chart over the timeline's span, each
  agent (click one to select it on the graph) and each WTS task (its agents plus the helpers they spawned). Exact
  values are in the tooltips. The selected agent's own figures sit under its Context bar; click them to open the tab.
  The **chip at the top** shows today's output across all sessions since 00:00 (including transcripts of sessions that
  are no longer running); click it for each session's share. Counting reads each transcript once, on its own thread
  (several GB take a few seconds), then only what it gains.
- **⚙ settings:** theme (System / Light / Dark), motion (Full / Reduced / Off), timeline span, show finished agents,
  auto-hide done agents, show all relationships, compact nodes, notifications. A first visit starts dark, with
  auto-hide and all relationships on, motion Full (Reduced when the OS asks for less motion), timeline 45m.
- **Keys:** `1`…`5` switch tabs (in the order shown: WTS first when the session has a queue) · `[` `]` switch sessions · `F` fits the graph · double-click an agent with a page mark: its notes · `Esc` closes the notes, else deselects · wheel zooms and
  dragging pans.
- **Panel widths:** drag the splitter on either side of the graph (or focus one and use ← →) to resize the sessions list
  or the side panel, and double-click a splitter to reset it. Both widths are remembered in this browser, and the graph
  always keeps at least 360 px.

Safety:
- The server listens on loopback only.
- Every request needs the token from `~/.config/ccprobe/token` (mode 600), and the Host header is checked.
- The page runs under a strict CSP, and no URL can name a file.
- Secrets are masked before they leave the server.
- ccprobe never writes to `~/.claude` or to any project.

Tests: `python3 -m unittest discover -s tests` (unit) · `python3 tests/smoke_live.py` (read-only check against this Mac).

Design: `docs/DESIGN.md`.

Licence: MIT (`LICENSE`). The Blender logo, used only to show that an agent waits on Blender, is a trademark of the
Blender Foundation.
