"""The Events tab's feed: what one tick to the next turns into events."""
import time
import unittest

from ccprobe.feed import Feed, at_hhmm


def row(n, kind, state="", status="", agent=None, title="A task", notes=None):
    return {"n": n, "kind": kind, "state": state, "status": status, "agent": agent, "title": title, "notes": notes}


def session(rows=(), agents=(), slots=(), sid="s1", root="/r", **w):
    wts = {"root": root, "error": None, "groups": {"HP": list(rows)}, "state_file": w.get("state_file", "running"),
           "modes": w.get("modes", {"MP": "running", "LP": "running"}), "caffeinate": w.get("caffeinate", True),
           "app": None, "app_running": None, "window": {"slots": list(slots)}}
    return {"id": sid, "project": "p", "alive": True, "started": 0, "title": "", "lead": {"state": {"key": "idle"}},
            "agents": list(agents), "wts": wts}


def agent(aid, label, born, key="running", finished=False, said="", since=None, **kw):
    return dict({"id": aid, "label": label, "role": "worker", "task": None, "group": "HP", "parent": "lead", "born": born,
                 "finished": finished, "said": said, "model": "claude-opus-5-5",
                 "state": {"key": key, "label": key, "since": since or born}}, **kw)


class FeedTest(unittest.TestCase):
    def setUp(self):
        self.f, self.now = Feed(), time.time()

    def tick(self, *sessions, alerts=(), dt=1):
        self.now += dt
        self.f.observe(list(sessions), list(alerts), self.now)
        return self.f.for_session(sessions[0])

    def titles(self, items):
        return [e["title"] for e in items]

    def test_a_task_from_queued_to_accepted(self):
        a = agent("a1", "HP 7", self.now - 5)
        self.tick(session([], [a]))
        out = self.tick(session([row(7, "queued")], [a]))
        self.assertIn("Task 7 queued", self.titles(out))
        self.tick(session([row(7, "active", "in progress 10:00: building", agent="a1")], [a]), dt=60)
        out = self.tick(session([row(7, "done", "done 10:05: it works", agent="a1", notes=1.0)], [a]), dt=300)
        done = next(e for e in out if e["title"] == "Task 7 done")
        self.assertEqual((done["sev"], done["detail"], done["notes"]), ("ok", "it works", True))
        self.assertAlmostEqual(done["dur"], 300, delta=2)
        out = self.tick(session([], [a]))
        self.assertIn("Task 7 accepted", self.titles(out))

    def test_a_window_hold_is_one_event_closed_in_place(self):
        a = agent("a1", "HP 7", self.now - 5)
        free = {"name": "a.lock", "held": False, "who": None, "since": None, "holder": None, "reserved": False}
        held = dict(free, held=True, who="hp7 capture", since=self.now, holder="a1")
        two = [dict(free, name="b.lock")]
        self.tick(session([], [a], [free] + two))
        out = self.tick(session([], [a], [held] + two))
        self.assertEqual([e["title"] for e in out if e["cat"] == "window"], ["HP 7 holds win0"])
        out = self.tick(session([], [a], [free] + two), dt=240)
        hold = [e for e in out if e["cat"] == "window"]
        self.assertEqual(len(hold), 1)
        self.assertEqual(hold[0]["title"], "HP 7 held win0")
        self.assertIn("end", hold[0])
        self.assertNotIn("who", hold[0])              # kept only to close it

    def test_an_agent_finishing_says_its_last_words(self):
        self.tick(session([], [agent("a1", "adv7", self.now - 600, parent="b")]))
        out = self.tick(session([], [agent("a1", "adv7", self.now - 600, key="ended", finished=True, said="Round 2 passes.", since=self.now)]))
        fin = next(e for e in out if e["title"] == "adv7 finished")
        self.assertEqual(fin["detail"], "Round 2 passes.")
        self.assertGreater(fin["dur"], 590)
        started = next(e for e in out if e["title"].startswith("adv7 spawned"))
        self.assertEqual(started.get("model"), "claude-opus-5-5")   # the page names it

    def test_first_sight_puts_back_what_the_queue_dates(self):
        a = agent("a1", "HP 7", self.now - 3600)
        hm = time.strftime("%H:%M", time.localtime(self.now - 60))
        out = self.tick(session([row(7, "done", f"done {hm}: fixed", status=f"✅ done {hm}", agent="a1"),
                                 row(8, "queued")], [a]))
        self.assertIn("Task 7 done", self.titles(out))
        self.assertNotIn("Task 8 queued", self.titles(out))     # a row merely there is not news

    def test_an_alert_is_raised_then_resolved(self):
        s = session()
        al = {"key": "stale-lock:/r:a.lock", "sev": "red", "title": "Stale window lock?", "detail": "…", "session": "s1", "agent": None}
        out = self.tick(s, alerts=[al])
        self.assertIn("Stale window lock?", self.titles(out))
        out = self.tick(s, dt=120)
        ev = next(e for e in out if e["title"] == "Stale window lock?")
        self.assertAlmostEqual(ev["dur"], 120, delta=2)

    def test_reserving_a_window_is_not_a_hold(self):
        free = {"name": "a.lock", "held": False, "who": None, "since": None, "holder": None, "reserved": False}
        two = [dict(free, name="b.lock")]
        self.tick(session([], [], [free] + two))
        out = self.tick(session([], [], [dict(free, reserved=True)] + two))
        ev = next(e for e in out if e["title"] == "win0 reserved for your shows")
        self.assertNotIn("hold", ev)

    def test_trimming_the_told_once_keys_tells_nothing_again(self):
        a = agent("a1", "HP 7", self.now - 5)
        self.tick(session([], [a]))
        for i in range(6000):
            self.f.once[("x", i)] = self.now - 2 * 86400     # long past keeping
        n = len(self.tick(session([], [a])))
        self.assertLess(len(self.f.once), 100)
        self.assertEqual(len(self.tick(session([], [a]))), n)

    def test_a_session_gone_a_day_is_dropped(self):
        self.tick(session([row(7, "queued")], [agent("a1", "HP 7", self.now - 5)]))
        self.tick(session(sid="s2", root="/q"), dt=86400 + 60)
        self.assertNotIn("s1", self.f.items)
        self.assertNotIn("wts:/r", self.f.prev)

    def test_helpers(self):
        now = time.mktime(time.strptime("2026-10-30 00:10", "%Y-%m-%d %H:%M"))
        self.assertEqual(time.strftime("%d %H:%M", time.localtime(at_hhmm("done 23:50: x", now))), "29 23:50")


if __name__ == "__main__":
    unittest.main()
