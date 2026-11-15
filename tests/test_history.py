"""The WTS tab's History (2026-11-14): closed rows, newest first, as the worker skill's queue.py orders them.
python3 -m unittest discover -s tests (skipped when the installed queue.py has no History)."""
import os
import shutil
import subprocess
import tempfile
import unittest

from ccprobe import wts

QUEUE = """# queue

| # | Pri | Task | State | Accepted |
|---|---|---|---|---|
| 1 | HP | Queued by the user (2026-11-12 08:00): a | done | ✔ 2026-11-12 (the user: "ok") |
| 2 | HP | Queued by the user (2026-11-12 08:01): b | done | n/a (folded into 3) |
| 3 | HP | Queued by the user (2026-11-13 08:02): c | done 09:00 | ✔ 2026-11-14 09:05 (the user: "3 accepted") |
| 4 | AG | Queued by the user (2026-11-14 08:03): d | in progress | — |
| 5 | MP | Queued by the user (2026-11-14 08:04): e | queued | n/a (cancelled by the user, 2026-11-14 10:00) |
| 999 | — | **END** | standing | n/a |
"""

m = wts.queue_module()


@unittest.skipUnless(m is not None and hasattr(m, "history_rows"), "the installed worker skill has no History")
class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, ".autopilot", "worker"))
        with open(os.path.join(self.root, ".autopilot", "worker", "queue.md"), "w") as f:
            f.write(QUEUE)
        wts._proc_cache.clear()

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_newest_first_and_undated_last(self):
        h = wts.history(self.root)
        self.assertEqual([x["n"] for x in h], [5, 3, 1, 2])            # by date and time; an old n/a has none: last
        self.assertEqual((h[0]["ok"], h[0]["why"], h[0]["time"]), (False, "cancelled by the user", "10:00"))
        self.assertEqual((h[1]["ok"], h[1]["why"]), (True, "3 accepted"))
        self.assertEqual((h[3]["why"], h[3]["date"]), ("folded into 3", None))
        self.assertNotIn(999, [x["n"] for x in h])                    # END is pinned, never history

    def test_the_tab_gets_the_newest_and_the_count(self):
        w = wts.read(self.root)
        self.assertEqual((w["history_n"], [x["n"] for x in w["history"]]), (4, [5, 3, 1, 2]))
        self.assertEqual([r["n"] for r in w["groups"]["AG"]], [4])       # an open row stays in its table

    def test_reopen_puts_a_row_back(self):
        run = lambda *a: subprocess.run(["python3", wts.QUEUE_PY, "--root", self.root, *a], capture_output=True, text=True).stdout
        self.assertIn("reopened", run("reopen", "3"))
        wts._proc_cache.clear()
        self.assertEqual([x["n"] for x in wts.history(self.root)], [5, 1, 2])
        self.assertIn("accepted: 3", run("accept", "3", "--words", "again"))
        wts._proc_cache.clear()
        self.assertEqual(wts.history(self.root)[0]["n"], 3)            # accepted now, with a time: the newest


if __name__ == "__main__":
    unittest.main()
