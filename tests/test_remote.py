"""Other machines over SSH: the far side's start from source sent down the pipe, its stream and answers, and the merge."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ccprobe import remote   # noqa: E402


class FarSideTests(unittest.TestCase):
    def test_starts_from_the_pipe_streams_answers_and_exits(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".claude", "sessions"))
            os.makedirs(os.path.join(home, ".claude", "projects"))
            # run where no copy of the package is importable: everything must come from the pipe
            p = subprocess.Popen(remote.boot_args({"window": 3600, "interval": 0.5}), cwd=home,
                                 env={"HOME": home, "PATH": os.environ.get("PATH", "")},
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                p.stdin.write(remote.bundle())
                p.stdin.flush()
                lines = []
                reader = threading.Thread(target=lambda: lines.extend(json.loads(x) for x in iter(p.stdout.readline, b"")),
                                          daemon=True)
                reader.start()
                for _ in range(100):
                    if any(x.get("t") == "model" for x in lines):
                        break
                    threading.Event().wait(0.1)
                model = next((x for x in lines if x.get("t") == "model"), None)
                self.assertIsNotNone(model, p.stderr.read1(2000) if p.poll() is not None else "no model in 10 s")
                self.assertEqual(model["model"]["sessions"], [])
                p.stdin.write(json.dumps({"id": 7, "op": "feed", "args": ["no-such-session"]}).encode() + b"\n")
                p.stdin.flush()
                for _ in range(50):
                    if any(x.get("t") == "reply" for x in lines):
                        break
                    threading.Event().wait(0.1)
                self.assertIn({"t": "reply", "id": 7, "body": None}, lines)
                p.stdin.close()                       # the other machine hangs up: the far side must go too
                self.assertEqual(p.wait(timeout=5), 0)
                # it wrote nothing: no bytecode, no token, no files in its home
                written = [os.path.join(d, f) for d, _, fs in os.walk(home) for f in fs]
                self.assertEqual(written, [])
            finally:
                if p.poll() is None:
                    p.kill()
                p.wait()
                for f in (p.stdin, p.stdout, p.stderr):
                    try:
                        f.close()
                    except OSError:
                        pass


class FakeRemote:
    def __init__(self, name, m):
        self.name, self.dest, self.m = name, name, m

    def status(self):
        return {"name": self.name, "state": "live", "error": None, "since": 0, "sessions": len(self.m["sessions"])}


class MergeTests(unittest.TestCase):
    def test_remote_sessions_alerts_and_tokens_join_the_local_model(self):
        local = {"v": 1, "now": 100, "server": {"version": "x"}, "sessions": [{"id": "L1", "project": "here"}],
                 "alerts": [{"key": "stuck:L1", "session": "L1", "project": "here"}],
                 "tokens_today": {"day": "d", "v": [1, 2, 3, 4], "n": 5, "ready": True}}
        far = {"sessions": [{"id": "R1", "project": "there"}], "alerts": [{"key": "stuck:R1", "session": "R1", "project": "there"}],
               "tokens_today": {"v": [10, 20, 30, 40], "n": 50, "ready": False}}
        r = FakeRemote("ubuntu", far)
        m, owner = remote.merge(local, [(r, far)])
        self.assertEqual([(s["id"], s.get("host")) for s in m["sessions"]], [("L1", None), ("ubuntu:R1", "ubuntu")])
        self.assertEqual(owner["ubuntu:R1"], (r, "R1"))          # the page's id, and the far side's own
        self.assertNotIn("L1", owner)
        self.assertEqual([a["key"] for a in m["alerts"]], ["stuck:L1", "ubuntu:stuck:R1"])
        self.assertEqual(m["alerts"][1]["session"], "ubuntu:R1")
        self.assertEqual(m["alerts"][1]["project"], "there @ubuntu")
        self.assertEqual(m["tokens_today"], {"day": "d", "v": [11, 22, 33, 44], "n": 55, "ready": False})
        self.assertEqual(m["server"]["remotes"][0]["name"], "ubuntu")
        self.assertEqual(local["tokens_today"]["v"], [1, 2, 3, 4])      # the local model itself is untouched

    def test_a_shared_id_stays_two_sessions(self):   # no sessionId: both known by pid 4123
        local = {"sessions": [{"id": "4123"}], "alerts": [], "tokens_today": {"v": [0, 0, 0, 0], "n": 0, "ready": True}}
        r = FakeRemote("ubuntu", {"sessions": [{"id": "4123"}]})
        m, owner = remote.merge(local, [(r, r.m)])
        self.assertEqual([s["id"] for s in m["sessions"]], ["4123", "ubuntu:4123"])
        hub = remote.Hub(None, [])
        hub.owner = owner
        self.assertEqual(hub._route("ubuntu:4123"), (r, "4123"))
        self.assertEqual(hub._route("4123"), (None, "4123"))

    def test_another_day_is_not_added_to_today(self):
        local = {"sessions": [], "alerts": [], "tokens_today": {"day": "2026-11-05", "v": [1, 1, 1, 1], "n": 1, "ready": True}}
        far = {"sessions": [], "tokens_today": {"day": "2026-11-06", "v": [9, 9, 9, 9], "n": 9, "ready": True}}
        m, _ = remote.merge(local, [(FakeRemote("ubuntu", far), far)])
        self.assertEqual((m["tokens_today"]["v"], m["tokens_today"]["n"]), ([1, 1, 1, 1], 1))

    def test_a_lost_link_adds_nothing(self):
        local = {"sessions": [], "alerts": [], "tokens_today": {"v": [0, 0, 0, 0], "n": 0, "ready": True}}
        m, owner = remote.merge(local, [(FakeRemote("ubuntu", {"sessions": []}), None)])
        self.assertEqual(m["sessions"], [])
        self.assertEqual(owner, {})

    def test_a_named_destination(self):
        r = remote.Remote("box=me@192.0.2.9", {}, lambda: None)
        self.assertEqual((r.name, r.dest), ("box", "me@192.0.2.9"))
        self.assertEqual(r.command()[-2], "me@192.0.2.9")
        self.assertEqual(remote.Remote("ubuntu", {}, lambda: None).name, "ubuntu")

    def test_two_specs_with_one_name_are_refused(self):
        rs = remote.remotes_for(["ubuntu", "ubuntu", "box=me@192.0.2.9"], {}, lambda: None)
        self.assertEqual([r.name for r in rs], ["ubuntu", "box"])          # a repeated spec counts once
        with self.assertRaisesRegex(ValueError, 'both named "ubuntu"'):
            remote.remotes_for(["ubuntu", "me@ubuntu"], {}, lambda: None)
        with self.assertRaisesRegex(ValueError, 'both named "box"'):
            remote.remotes_for(["box=me@192.0.2.9", "box=me@192.0.2.10"], {}, lambda: None)


if __name__ == "__main__":
    unittest.main()
