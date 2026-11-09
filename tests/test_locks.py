"""What else the page reads beside the queue: the build lock, the waiting line for the window, each table's limit, and
the session registry's status time."""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ccprobe import sessions, wts   # noqa: E402


class LockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        os.makedirs(os.path.join(self.root, ".autopilot"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_lock(self):
        self.assertIsNone(wts.build_lock(self.root, None))                      # no build lock in config.json
        self.assertEqual(wts.build_lock(self.root, ".autopilot/build.lock"), {"held": False, "who": None, "since": None})
        d = os.path.join(self.root, ".autopilot", "build.lock")
        os.mkdir(d)
        with open(os.path.join(d, "who"), "w") as f:
            f.write("hp12 build 21:40 pid=1\n")
        b = wts.build_lock(self.root, ".autopilot/build.lock")
        self.assertEqual((b["held"], b["who"]), (True, "hp12 build 21:40 pid=1"))
        self.assertIsNone(wts.build_lock(self.root, "../outside.lock"))         # never outside the project

    def test_waiting_line(self):
        d = os.path.join(self.root, ".autopilot", "winq")
        os.mkdir(d)
        for name, who in ((f"1793945392.211332.{os.getpid()}", "hp294 capture"), ("1793945300.5.999999", "hp1 gone"),
                          ("1793945301.0", "hp2 pid 0"), ("1793945302.99999999999999999999999", "hp3 no such pid"),
                          (f"1793945100.1.{os.getpid()}", "hp290 perf"), ("notes.txt", "not a ticket")):
            with open(os.path.join(d, name), "w") as f:
                f.write(who + "\n")
        line = wts.waiting_line(self.root, ".autopilot/winq")
        # oldest first; a ticket whose process is gone (pid 999999) is not waiting
        self.assertEqual([x["who"] for x in line], ["hp290 perf", "hp294 capture"])
        self.assertEqual(line[0]["since"], 1793945100.1)
        self.assertEqual(wts.waiting_line(self.root, "../.."), [])
        self.assertEqual(wts.waiting_line(self.root, ".autopilot/none"), [])

    def test_limits(self):
        def rows(*kinds):
            return [{"n": i, "kind": k} for i, k in enumerate(kinds)]
        groups = {"HP": rows("active", "active", "queued", "done"), "MP": rows("active", "queued"), "LP": rows("queued")}
        d = wts.limit_defaults({"hp_parallel": 5, "mp_parallel": 0, "lp_parallel": True})
        self.assertEqual(d, {"HP": 5, "MP": 0, "LP": None})                     # true is not a number: no limit
        self.assertEqual(wts.limit_defaults({})["HP"], 1)                       # queue.py's default for a session
        self.assertEqual(wts.limit_defaults({}, per_session=False)["HP"], None)  # an older queue.py: none
        lim = wts.apply_limits(d, groups)
        self.assertEqual(lim, {"HP": {"max": 5, "running": 2, "src": "default"}, "MP": {"max": 0, "running": 1, "src": "default"},
                               "LP": {"max": None, "running": 0, "src": "default"}})
        self.assertEqual(wts.held_rows(lim, groups), {1})                         # MP max 0: the running one goes on, none starts
        self.assertNotIn("held", groups["MP"][1])                                 # the shared rows are not changed

    def test_a_sessions_own_limits(self):
        groups = {"HP": [{"n": 7, "kind": "active"}, {"n": 8, "kind": "active"}, {"n": 9, "kind": "queued"}],
                  "MP": [{"n": 20, "kind": "queued"}], "LP": [{"n": 30, "kind": "queued"}]}
        defaults = {"HP": 0, "MP": 0, "LP": 0}
        folder = os.path.join(self.root, wts.SESSIONS)
        os.makedirs(folder)
        with open(os.path.join(folder, "abc-1.json"), "w") as f:
            json.dump({"limits": {"HP": 2, "MP": None}, "hp": "running 7"}, f)
        own = wts.read_session(self.root, "abc-1")
        lim = wts.apply_limits(defaults, groups, own)
        self.assertEqual(lim["HP"], {"max": 2, "running": 1, "src": "session"})   # its own running list (8 is another's)
        self.assertEqual(lim["MP"], {"max": None, "running": 0, "src": "session"})  # null: no limit for this session
        self.assertEqual(lim["LP"], {"max": 0, "running": 0, "src": "default"})
        self.assertEqual(wts.held_rows(lim, groups), {30})
        self.assertEqual(wts.read_session(self.root, "nobody"), {})
        self.assertEqual(wts.read_session(self.root, ""), {})
        self.assertEqual(wts.session_file(self.root, "../x"), os.path.join(folder, "___x.json"))   # never outside


class AwakeTests(unittest.TestCase):
    def test_each_session_its_own_keep_awake(self):   # the worker skill since 2026-11-08: one hold per Claude session
        holds = {95522: 1, 0: 1}                           # a lead's, and one no session owns (left running)
        self.assertEqual(wts.session_awake(95522, holds), {"mine": True, "others": 1})
        self.assertEqual(wts.session_awake(7, holds), {"mine": False, "others": 2})
        self.assertEqual(wts.session_awake(7, {}), {"mine": False, "others": 0})
        self.assertEqual(wts.session_awake(None, holds), {"mine": False, "others": 2})


class RegistryTests(unittest.TestCase):
    def test_status_time_falls_back_to_the_file(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, "sessions"))
            base = {"pid": 1, "cwd": "/x", "status": "waiting"}
            for pid, extra in ((101, {}), (102, {"updatedAt": 1793943000000}), (103, {"statusUpdatedAt": 1793943087111})):
                with open(os.path.join(home, "sessions", f"{pid}.json"), "w") as f:
                    json.dump(dict(base, pid=pid, **extra), f)
            old = sessions.CLAUDE
            sessions.CLAUDE = home
            try:
                got = {e["pid"]: e["statusUpdatedAt"] for e in sessions.read_registry()}
            finally:
                sessions.CLAUDE = old
            self.assertLess(abs(got[101] / 1000 - time.time()), 60)          # the file's own time, not 1970
            self.assertEqual(got[102], 1793943000000)
            self.assertEqual(got[103], 1793943087111)


if __name__ == "__main__":
    unittest.main()
