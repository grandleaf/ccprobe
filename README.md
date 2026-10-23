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
  the receiver. Timeline arcs end in an arrowhead on the receiver's lane. An older agent whose name a newer one now
  holds (a fresh agent per task) reads "worker (earlier)" and folds into the finished chip once its turn ends.
- **States** come from the transcripts (DESIGN.md §5.5): running a tool (for how long), thinking, quiet, stuck?, polling,
  waiting for the window, holds the window, turn ended (waiting / done), waiting for you (the lead), dead.
- **WTS tab.** This is the same table as `queue.py wts`; the server imports it read-only. Next to each bound row is what
  its agent is actually doing, and amber marks a mismatch.
- **Alerts tab.** Needs-you rows, usage limits, orphaned or stale rows, a stale lock, an HP state that disagrees,
  context ≥ 80 %, stuck agents, caffeinate off while work runs. Each alert can be dismissed or snoozed. Desktop
  notifications are opt-in (⚙).
- **⚙ settings:** theme (System / Light / Dark), motion (Full / Reduced / Off), timeline span, show finished agents,
  compact nodes, notifications.
- **Keys:** `1` `2` `3` switch tabs · `[` `]` switch sessions · `F` fits the graph · `Esc` deselects · wheel zooms and
  dragging pans.
- **Side panel width:** drag the splitter left of it (or focus it and use ← →), and double-click it to reset. The width is
  remembered in this browser.

Safety:
- The server listens on loopback only.
- Every request needs the token from `~/.config/ccprobe/token` (mode 600), and the Host header is checked.
- The page runs under a strict CSP, and no URL can name a file.
- Secrets are masked before they leave the server.
- ccprobe never writes to `~/.claude` or to any project.

Tests: `python3 -m unittest discover -s tests` (unit) · `python3 tests/smoke_live.py` (read-only check against this Mac).

Design: `docs/DESIGN.md`. Advice it is based on: `docs/advice/{features,ui,design-audit}.md`. The static mockup it grew
from: `mockup/`.
