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
- **Graph.** The lead sits on top, the HP worker and running agents below it, helpers next to the agent they serve,
  and parked agents in the right-hand column. The HP queue and the shared window are their own cards, and a red line
  runs to whoever holds the lock. Dashed lines flow while work is in flight, and amber task lines end in an arrow at the agent
  doing the work. A chevron travels along an edge for every message, hand-back or spawn, pointing from the sender to
  the receiver. Timeline arcs end in an arrowhead on the receiver's lane. The HP worker is the agent named for the
  running HP task (`hp128`, shown as "HP 128"). With a fresh agent per task, earlier HP agents and an older agent whose
  name a newer one now holds ("lp74 (earlier)") fold into the finished chip once their turn ends.
- **Motion:** when the layout changes, agents glide to their new places instead of jumping. New agents grow out of
  their parent, and finished ones fly into the "✓ finished" chip (and back out when you open it). Hidden ones fade
  out, and the edges, cards and view follow along. A second change mid-move bends the motion smoothly. A session
  switch cuts straight to the new graph. ⚙ Motion: Reduced only fades, Off snaps.
- **Blocked agents** (paused, parked, or waiting for the window) get a dashed hexagon outline, at full strength. Finished
  ones have a dashed outline too, but are faded. The selected agent has a solid, softly glowing ring.
- **Hiding agents.** Hover or select an agent that is not at work and click the × at its top-left (or press `H`), or use
  "Hide from the diagram" in its panel. "Clear N done" (top right) hides the finished and dead agents drawn on the
  graph (not the ones already folded into the finished chip); idle and parked agents are not done, so it leaves them.
  "N hidden · show" brings them all back. A hidden agent comes back by itself as soon as
  it writes anything new, and opening it from an alert or a message link shows it again. Hiding happens only in this
  browser and only on the page; it never stops an agent.
- **Sessions list order:** four icon buttons at its top. ⚠ needs you first (red alerts or a question for you, then busy,
  idle, dead) · 🕘 recently active first · A–Z · ⠿ custom. Custom starts as A–Z. Drag a card to move it
  (the others slide aside), or focus it and press Alt+↑/↓ (Alt+Shift+↑/↓ to the top or bottom). New sessions slot in
  by A–Z. The order is saved per project directory in this browser. Live reorders in the other modes wait while
  the pointer is over the list, and happen at most every 4 s.
- **States** come from the transcripts (DESIGN.md §5.5): running a tool (for how long), thinking, quiet, stuck?, polling,
  waiting for the window, holds the window, turn ended (waiting / done), idle or waiting for you (the lead: waiting for you only
  when it asked you a question or left a plan for you to approve), dead.
- **WTS tab.** This is the same table as `queue.py wts`; the server imports it read-only. Next to each bound row is what
  its agent is actually doing, and amber marks a mismatch.
- **Alerts tab.** Needs-you rows, usage limits, orphaned or stale rows, a stale lock, an HP state that disagrees,
  stuck agents, caffeinate off while work runs. Each alert can be dismissed or snoozed. Desktop
  notifications are opt-in (⚙).
- **⚙ settings:** theme (System / Light / Dark), motion (Full / Reduced / Off), timeline span, show finished agents,
  compact nodes, notifications.
- **Keys:** `1` `2` `3` switch tabs · `[` `]` switch sessions · `F` fits the graph · `H` hides the selected agent · `Esc` deselects · wheel zooms and
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

Design: `docs/DESIGN.md`. Advice it is based on: `docs/advice/{features,ui,design-audit}.md`. The static mockup it grew
from: `mockup/`.
