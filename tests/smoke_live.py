"""Read-only smoke test against this Mac's real ~/.claude: python3 tests/smoke_live.py

Checks that every live session appears, and that each project's WTS rows equal `queue.py wts` row for row.
"""
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ccprobe import sessions, wts  # noqa: E402
from ccprobe.model import Collector  # noqa: E402

t0 = time.time()
m = Collector().tick()
print(f"tick {time.time() - t0:.2f}s · {len(m['sessions'])} sessions · {len(m['alerts'])} alerts")
fails = 0
live = {s["sessionId"] for s in sessions.read_registry() if sessions.alive(s["pid"])}
seen = {s["id"] for s in m["sessions"]}
if not live <= seen:
    print("MISSING sessions:", live - seen); fails += 1
for s in m["sessions"]:
    print(f"  {s['project']:14} lead={s['lead']['state']['label'] if s.get('lead') else '?':28} agents={len(s['agents'])}")
    w = s.get("wts")
    if not w:
        continue
    if w.get("error"):
        print("   WTS error:", w["error"]); fails += 1; continue
    out = subprocess.run(["python3", wts.QUEUE_PY, "--root", w["root"], "wts"], capture_output=True, text=True).stdout
    want, grp = {}, None
    for line in out.splitlines():
        g = re.match(r"^\*\*(HP|MP|LP)\*\*", line)
        if g:
            grp = g.group(1)
        r = re.match(r"^\| (\d+) \|.*\| ([^|]+) \| ([^|]+) \|$", line)
        if r and grp:
            want.setdefault(grp, []).append((int(r.group(1)), r.group(2).strip()))
    got = {g: [(r["n"], r["status"]) for r in rows] for g, rows in w["groups"].items() if rows}
    # the row list can move between the two reads; compare numbers strictly, status text loosely (times tick)
    for g in set(want) | set(got):
        wn, gn = [n for n, _ in want.get(g, [])], [n for n, _ in got.get(g, [])]
        ok = wn == gn
        print(f"   WTS {g}: {len(gn)} rows {'match' if ok else 'DIFFER'} queue.py wts")
        if not ok:
            print("    want", wn, "\n    got ", gn); fails += 1
sys.exit(1 if fails else 0)
