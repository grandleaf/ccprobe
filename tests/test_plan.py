"""The plan's limits, as a status line saved them, and the usage rows it fetched (ccprobe/plan.py)."""
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
        self.upath = os.path.join(self.tmp.name, "plan-usage.json")    # none unless a test saves one

    def tearDown(self):
        self.tmp.cleanup()

    def save(self, obj, path=None):
        path = path or self.path
        with open(path, "w") as f:
            f.write(obj if isinstance(obj, str) else json.dumps(obj))
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1000))   # a new key for the cache, even within one tick

    def read(self, path=None):
        return plan.read(path or self.path, self.upath)

    def test_windows_in_order_with_their_lengths(self):
        self.save({"rate_limits": {"seven_day_opus": {"used_percentage": 91, "resets_at": 1794495600},
                                   "seven_day": {"used_percentage": 70.4, "resets_at": 1794495600},
                                   "five_hour": {"used_percentage": 12, "resets_at": "2026-11-08T21:00:00Z"},
                                   "spend_limit": {"used_usd": 3}}})
        got = self.read()
        self.assertEqual([w["key"] for w in got["windows"]], ["five_hour", "seven_day", "seven_day_opus"])   # no figure, no row
        five, week, opus = got["windows"]
        self.assertEqual((five["label"], five["span"]), ("5-hour", 5 * 3600))
        self.assertEqual(five["resets_at"], 1794171600.0)                      # an ISO time is read too
        self.assertEqual((week["label"], week["span"], week["used"]), ("week", 7 * 86400, 70.4))
        self.assertEqual(opus["label"], "week · Opus")
        self.assertAlmostEqual(got["seen"], os.path.getmtime(self.path))

    def test_bad_input_gives_nothing(self):
        self.assertIsNone(self.read(os.path.join(self.tmp.name, "none.json")))
        for bad in ("not json", "[]", '{"rate_limits": []}', '{"rate_limits": {"seven_day": {"used_percentage": "70"}}}',
                    '{"rate_limits": {"odd_window": {"used_percentage": 5}}}'):
            self.save(bad)
            self.assertIsNone(self.read(), bad)
        self.save({"rate_limits": {"seven_day": {"used_percentage": 140, "resets_at": 1794495600123}}})
        w = self.read()["windows"][0]
        self.assertEqual((w["used"], w["resets_at"]), (100.0, 1794495600.123))   # capped; milliseconds read as such

    def test_too_big_or_not_a_file(self):
        self.save("{" + " " * (plan.MAX_BYTES + 1) + "}")
        self.assertIsNone(self.read())
        self.assertIsNone(self.read(self.tmp.name))


    def test_a_models_own_week_from_the_usage_rows(self):
        # the rows as plan_usage.py saves them (the user, 2026-11-13: "another one for the fable weekly")
        self.save({"fetched_at": 1794615441, "week_seen": 23, "limits": [
            {"kind": "weekly_all", "group": "weekly", "percent": 24, "resets_at": "2026-11-19T14:59:59.607053+00:00",
             "scope": None, "severity": "normal", "is_active": False},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 40, "resets_at": "2026-11-19T14:59:59.607228+00:00",
             "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None}, "severity": "normal", "is_active": True},
            {"kind": "weekly_scoped", "percent": 5, "scope": {"model": None, "surface": {"display_name": "Claude  Code"}}},
            {"kind": "weekly_scoped", "percent": 9, "scope": None},              # scoped to nothing named: no row
            {"kind": "monthly_spend", "percent": 3}, {"kind": "weekly_all", "percent": "24"}, "odd", None]}, self.upath)
        got = self.read()                                                     # no status line file: the rows alone
        self.assertEqual([(w["key"], w["label"], w["used"], w["src"]) for w in got["windows"]],
                         [("seven_day", "week", 24.0, "usage"), ("seven_day_claude_code", "week · Claude Code", 5.0, "usage"),
                          ("seven_day_fable", "week · Fable", 40.0, "usage")])
        fable = got["windows"][2]
        self.assertEqual((fable["span"], fable["seen"], fable["resets_at"]), (7 * 86400, 1794615441, 1795100400.0))   # to the minute
        self.assertEqual(got["seen"], 1794615441)

    def test_both_files_one_reading_per_window(self):
        self.save({"rate_limits": {"seven_day": {"used_percentage": 23, "resets_at": 1795100400},
                                   "five_hour": {"used_percentage": 12, "resets_at": 1794630000}}})
        os.utime(self.path, (1794615600, 1794615600))
        rows = [{"kind": "weekly_all", "percent": 24, "resets_at": "2026-11-19T14:59:59.6+00:00"},
                {"kind": "weekly_scoped", "percent": 40, "resets_at": "2026-11-19T14:59:59.6+00:00",
                 "scope": {"model": {"display_name": "Fable"}}}]
        self.save({"fetched_at": 1794615400, "limits": rows}, self.upath)
        got = self.read()
        week = next(w for w in got["windows"] if w["key"] == "seven_day")
        # the same window: the higher figure (the rows' 24 over the status line's 23), as of the newer reading
        self.assertEqual((week["used"], week["src"], week["seen"]), (24.0, "usage", 1794615600))
        self.assertEqual([w["key"] for w in got["windows"]], ["five_hour", "seven_day", "seven_day_fable"])
        self.assertEqual(got["seen"], 1794615600)
        # a later window wins whatever its figure: the week reset, the status line has the new one
        self.save({"rate_limits": {"seven_day": {"used_percentage": 1, "resets_at": 1795705200}}})
        week = next(w for w in self.read()["windows"] if w["key"] == "seven_day")
        self.assertEqual((week["used"], week["src"]), (1.0, "status line"))

    def test_bad_usage_rows_give_nothing(self):
        for bad in ("not json", "[]", '{"limits": []}', '{"limits": {}, "fetched_at": 1}',
                    '{"limits": [{"kind": "weekly_all", "percent": 20}]}'):           # no fetched_at: no time to show
            self.save(bad, self.upath)
            self.assertIsNone(self.read(), bad)


if __name__ == "__main__":
    unittest.main()
