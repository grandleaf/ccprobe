"""The plan's limits, as a status line saved them (ccprobe/plan.py)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ccprobe import plan   # noqa: E402


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "rate-limits.json")

    def tearDown(self):
        self.tmp.cleanup()

    def save(self, obj):
        with open(self.path, "w") as f:
            f.write(obj if isinstance(obj, str) else json.dumps(obj))
        st = os.stat(self.path)
        os.utime(self.path, ns=(st.st_atime_ns, st.st_mtime_ns + 1000))   # a new key for the cache, even within one tick

    def test_windows_in_order_with_their_lengths(self):
        self.save({"rate_limits": {"seven_day_opus": {"used_percentage": 91, "resets_at": 1794495600},
                                   "seven_day": {"used_percentage": 70.4, "resets_at": 1794495600},
                                   "five_hour": {"used_percentage": 12, "resets_at": "2026-11-08T21:00:00Z"},
                                   "spend_limit": {"used_usd": 3}}})
        got = plan.read(self.path)
        self.assertEqual([w["key"] for w in got["windows"]], ["five_hour", "seven_day", "seven_day_opus"])   # no figure, no row
        five, week, opus = got["windows"]
        self.assertEqual((five["label"], five["span"]), ("5-hour", 5 * 3600))
        self.assertEqual(five["resets_at"], 1794171600.0)                      # an ISO time is read too
        self.assertEqual((week["label"], week["span"], week["used"]), ("week", 7 * 86400, 70.4))
        self.assertEqual(opus["label"], "week · Opus")
        self.assertAlmostEqual(got["seen"], os.path.getmtime(self.path))

    def test_bad_input_gives_nothing(self):
        self.assertIsNone(plan.read(os.path.join(self.tmp.name, "none.json")))
        for bad in ("not json", "[]", '{"rate_limits": []}', '{"rate_limits": {"seven_day": {"used_percentage": "70"}}}',
                    '{"rate_limits": {"odd_window": {"used_percentage": 5}}}'):
            self.save(bad)
            self.assertIsNone(plan.read(self.path), bad)
        self.save({"rate_limits": {"seven_day": {"used_percentage": 140, "resets_at": 1794495600123}}})
        w = plan.read(self.path)["windows"][0]
        self.assertEqual((w["used"], w["resets_at"]), (100.0, 1794495600.123))   # capped; milliseconds read as such

    def test_too_big_or_not_a_file(self):
        self.save("{" + " " * (plan.MAX_BYTES + 1) + "}")
        self.assertIsNone(plan.read(self.path))
        self.assertIsNone(plan.read(self.tmp.name))


if __name__ == "__main__":
    unittest.main()
