"""How long a WTS row took when no agent of its own did it: its State writes, read from the transcripts."""
import json
import os
import tempfile
import threading
import unittest

from ccprobe.model import state_run
from ccprobe.tokens import Ledger


def bash(ts, mid, cmd):
    return json.dumps({"type": "assistant", "timestamp": ts, "message": {"id": mid, "usage": {"output_tokens": 5},
                       "content": [{"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}}, separators=(",", ":"))   # compact, as Claude Code writes it


class RowTimeTests(unittest.TestCase):
    def test_ledger_finds_state_writes(self):
        q = "python3 ~/.claude/skills/worker/scripts/queue.py --root /r"
        lines = [bash("2026-10-25T03:54:03Z", "m1", f'{q} state 119 --text "in progress $(date +%H:%M): in hand"'),
                 bash("2026-10-25T04:12:59Z", "m2", f'{q} state 125 --text "in progress $(date +%H:%M)" && {q} state 119 --text "⏩ in progress 21:12: round 2"'),
                 bash("2026-10-25T04:55:00Z", "m3", f'Q state 119 --text "done $(date +%H:%M): adv141 r2 passed"'),
                 bash("2026-10-25T05:00:00Z", "m4", f'echo "state 7 is fine"')]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write("\n".join(lines) + "\n")
        try:
            L = Ledger(f.name)
            L.read(threading.Lock())
            got = sorted((n, what) for _, n, what in L.qwrites)
            self.assertEqual(got, [(119, "done"), (119, "in progress"), (119, "in progress"), (125, "in progress")])
        finally:
            os.unlink(f.name)

    def test_state_run(self):
        self.assertEqual(state_run({(10, "in progress"), (20, "in progress"), (30, "done"), (40, "done")}),
                         {"start": 10, "done": 30, "open": None, "last": [40, "done"]})   # a later "done" rewrite changes nothing
        self.assertEqual(state_run({(10, "in progress"), (30, "done"), (50, "in progress")}),
                         {"start": 10, "done": 30, "open": 50, "last": [50, "in progress"]})   # a redo in progress
        self.assertEqual(state_run({(10, "in progress"), (30, "done"), (50, "in progress"), (70, "done")}),
                         {"start": 50, "done": 70, "open": None, "last": [70, "done"]})   # the last round counts
        self.assertEqual(state_run({(30, "done")}), {"start": None, "done": 30, "open": None, "last": [30, "done"]})   # only its day
        self.assertEqual(state_run({(10, "in progress"), (20, "queued"), (60, "in progress"), (70, "done")})["start"], 60)   # requeued

    def test_primary_agents(self):
        from ccprobe.model import _task_of_meta
        rows = {129}
        self.assertEqual(_task_of_meta({"name": "hp129"}, rows, primary=True), 129)
        self.assertEqual(_task_of_meta({"description": "Task 129: build"}, rows, primary=True), 129)
        self.assertIsNone(_task_of_meta({"name": "adv129", "description": "Task 129: review"}, rows, primary=True))
        self.assertEqual(_task_of_meta({"name": "adv129"}, rows), 129)        # still the task's, for its tokens


if __name__ == "__main__":
    unittest.main()
