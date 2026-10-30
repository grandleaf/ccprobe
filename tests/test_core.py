"""Unit tests on synthetic transcripts: python3 -m unittest discover -s tests"""
import json
import os
import shutil
import tempfile
import time
import unittest

from ccprobe import alerts
from ccprobe.agents import Transcript, agent_state, lead_state
from ccprobe.model import _holder, _holds
from ccprobe.redact import clip, redact
from ccprobe.tail import Tailer


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


class Writer:
    """Appends JSONL entries to a temp transcript."""

    def __init__(self, path):
        self.path = path
        open(path, "w").close()

    def add(self, *entries):
        with open(self.path, "a") as f:
            for e in entries:
                f.write(json.dumps(e, separators=(",", ":")) + "\n")


def tool_use(t, tid, name, inp, stop=None):
    return {"type": "assistant", "timestamp": iso(t), "message": {"model": "claude-opus-5-5", "stop_reason": stop,
            "usage": {"input_tokens": 10, "cache_read_input_tokens": 1000},
            "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def text(t, s, stop=None):
    return {"type": "assistant", "timestamp": iso(t), "message": {"stop_reason": stop, "content": [{"type": "text", "text": s}]}}


def result(t, tid, err=False, extra=None):
    d = {"type": "user", "timestamp": iso(t), "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "is_error": err, "content": "ok"}]}}
    if extra:
        d["toolUseResult"] = extra
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.jsonl")
        self.w = Writer(self.path)
        self.now = time.time()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def tr(self):
        t = Transcript(self.path, 1 << 20)
        t.update()
        return t


class TailerTests(Base):
    def test_partial_line_waits_for_its_end(self):
        tl = Tailer(self.path, 1 << 20)
        with open(self.path, "a") as f:
            f.write('{"type":"user","a":1}\n{"type":"us')
        self.assertEqual(len(tl.read()), 1)
        with open(self.path, "a") as f:
            f.write('er","a":2}\n')
        got = tl.read()
        self.assertEqual(got[0]["a"], 2)

    def test_truncation_restarts(self):
        tl = Tailer(self.path, 1 << 20)
        self.w.add({"type": "user", "a": 1}, {"type": "user", "a": 2})
        self.assertEqual(len(tl.read()), 2)
        Writer(self.path).add({"type": "user", "a": 3})
        self.assertEqual([d["a"] for d in tl.read()], [3])

    def test_backfill_drops_the_first_partial_line(self):
        self.w.add(*[{"type": "user", "pad": "x" * 100, "i": i} for i in range(50)])
        got = Tailer(self.path, 1000).read()
        self.assertTrue(0 < len(got) < 50)
        self.assertEqual(got[-1]["i"], 49)

    def test_skipped_types_and_api_request(self):
        with open(self.path, "w") as f:
            f.write('{"type":"api-request-blob","x":1}\n{"type":"api-request","timestamp":"2026-10-22T10:00:00.000Z"}\n')
        got = Tailer(self.path, 1 << 20).read()
        self.assertEqual([d["type"] for d in got], ["api-request"])


class StateTests(Base):
    def test_handback_result_is_not_news(self):  # audit B1
        t = self.now - 400
        self.w.add(tool_use(t, "h1", "SubagentHandback", {"message": "done"}), result(t + 1, "h1"))
        st = agent_state(self.tr(), self.now, row_open=True)
        self.assertEqual((st["key"], st["sub"]), ("ended", "waiting"))

    def test_midturn_text_is_not_an_end(self):  # audit B1
        self.w.add(text(self.now - 5, "Let me check."))
        self.assertEqual(agent_state(self.tr(), self.now)["key"], "thinking")
        self.w.add(text(self.now - 1, "All done.", stop="end_turn"))
        tr = self.tr()
        self.assertEqual(agent_state(tr, self.now)["key"], "ended")

    def test_pending_tool_runs_then_clears(self):
        self.w.add(tool_use(self.now - 70, "b1", "Bash", {"command": "make"}))
        tr = self.tr()
        self.assertEqual(agent_state(tr, self.now)["key"], "running")
        self.w.add(result(self.now - 1, "b1"))
        tr.update()
        self.assertEqual(agent_state(tr, self.now)["key"], "thinking")

    def test_quiet_ladder(self):
        self.w.add(result(self.now - 2000, "x"), tool_use(self.now - 900, "b1", "Read", {"file_path": "a"}), result(self.now - 899, "b1"))
        self.assertEqual(agent_state(self.tr(), self.now)["key"], "stuck")

    def test_api_request_counts_as_activity(self):
        self.w.add(tool_use(self.now - 900, "b1", "Read", {"file_path": "a"}), result(self.now - 899, "b1"),
                   {"type": "api-request", "timestamp": iso(self.now - 30)})
        st = agent_state(self.tr(), self.now)
        self.assertEqual((st["key"], st["label"]), ("thinking", "thinking"))

    def test_lock_loop_waits_unless_holder(self):  # audit M1
        cmd = "until mkdir .autopilot/app.lock 2>/dev/null; do sleep 30; done; echo \"art-advisor round0 $(date)\" > .autopilot/app.lock/who; capture"
        self.w.add(tool_use(self.now - 60, "b1", "Bash", {"command": cmd}))
        tr = self.tr()
        self.assertEqual(agent_state(tr, self.now, lock_names=("app.lock",))["key"], "waiting_window")
        self.assertEqual(agent_state(tr, self.now, lock_names=("app.lock",), is_holder=True)["key"], "running")
        self.assertEqual(list(tr.who_writes)[-1][1], "art-advisor round0")

    def test_background_job_cleared_by_origin_entry(self):  # audit B2
        self.w.add(tool_use(self.now - 50, "toolu_bg1", "Bash", {"command": "sleep 99", "run_in_background": True}),
                   result(self.now - 49, "toolu_bg1"), tool_use(self.now - 40, "h", "SubagentHandback", {"message": "x"}))
        tr = self.tr()
        self.assertEqual(agent_state(tr, self.now)["key"], "ended_bg")
        self.w.add({"type": "user", "timestamp": iso(self.now - 5), "origin": {"kind": "task-notification"},
                    "message": {"content": "<task-notification><tool-use-id>toolu_bg1</tool-use-id></task-notification>"}})
        tr.update()
        self.assertFalse(tr.bg_pending)

    def test_peer_message_received(self):
        self.w.add({"type": "user", "timestamp": iso(self.now - 5), "message": {"content": "hi"},
                    "origin": {"kind": "peer", "from": "worker", "senderTaskId": "abc", "handback": True}})
        tr = self.tr()
        self.assertEqual(tr.received[-1]["sender"], "abc")
        self.assertTrue(tr.received[-1]["handback"])

    def test_sendmessage_resolves_revived_id(self):  # audit M5
        self.w.add(tool_use(self.now - 5, "s1", "SendMessage", {"to": "worker", "summary": "go"}),
                   result(self.now - 4, "s1", extra={"resumedAgentId": "a1c2d"}))
        self.assertEqual(self.tr().messages[-1]["to_id"], "a1c2d")

    def test_lead_waits_for_user_after_turn_end(self):  # audit B3
        self.w.add(text(self.now - 300, "Here it is.", stop="end_turn"),
                   {"type": "system", "subtype": "turn_duration", "timestamp": iso(self.now - 299)})
        st = lead_state(self.tr(), {"alive": True, "status": "busy"}, self.now)
        self.assertEqual(st["key"], "idle")

    def test_lead_waits_for_user_only_on_a_question(self):
        self.w.add(tool_use(self.now - 300, "toolu_q1", "AskUserQuestion", {"questions": []}))
        st = lead_state(self.tr(), {"alive": True, "status": "busy"}, self.now)
        self.assertEqual((st["key"], st["detail"]), ("waiting_user", "a question for you"))

    def test_registry_idle_wins_over_an_unanswered_prompt(self):
        self.w.add({"type": "user", "timestamp": iso(self.now - 900), "message": {"content": "exit"}})
        tr = self.tr()
        self.assertEqual(lead_state(tr, {"alive": True, "status": "idle", "statusUpdatedAt": (self.now - 890) * 1000}, self.now)["key"], "idle")
        self.assertEqual(lead_state(tr, {"alive": True, "status": "busy", "statusUpdatedAt": (self.now - 890) * 1000}, self.now)["key"], "stuck")

    def test_idle_compaction_is_not_a_prompt(self):
        self.w.add(text(self.now - 1900, "Done.", stop="end_turn"),
                   {"type": "system", "subtype": "compact_boundary", "timestamp": iso(self.now - 1800), "compactMetadata": {"trigger": "auto"}},
                   {"type": "user", "timestamp": iso(self.now - 1800), "isCompactSummary": True, "isVisibleInTranscriptOnly": True,
                    "message": {"role": "user", "content": "This session is being continued from a previous conversation…"}})
        st = lead_state(self.tr(), {"alive": True, "status": "idle"}, self.now)
        self.assertEqual(st["key"], "idle")

    def test_local_command_output_returns_to_the_user(self):
        self.w.add({"type": "user", "timestamp": iso(self.now - 1200), "message": {"content": "<command-name>/model</command-name>"}},
                   {"type": "user", "timestamp": iso(self.now - 1199), "message": {"content": "<local-command-stdout>Set model to Opus</local-command-stdout>"}})
        st = lead_state(self.tr(), {"alive": True, "status": "idle"}, self.now)
        self.assertEqual(st["key"], "idle")

    def test_taskstop_recorded_unless_it_failed(self):
        self.w.add(tool_use(self.now - 60, "toolu_s1", "TaskStop", {"task_id": "agent123"}), result(self.now - 59, "toolu_s1"),
                   tool_use(self.now - 30, "toolu_s2", "TaskStop", {"task_id": "agent456"}), result(self.now - 29, "toolu_s2", err=True))
        tr = self.tr()
        self.assertIn("agent123", tr.stops)
        self.assertNotIn("agent456", tr.stops)

    def test_usage_limit_state(self):
        self.w.add({"type": "system", "subtype": "informational", "timestamp": iso(self.now - 100),
                    "content": "Usage limit reached · continuing automatically at 8am"})
        tr = self.tr()
        self.assertIsNotNone(tr.limit)
        self.w.add({"type": "system", "subtype": "informational", "timestamp": iso(self.now - 10), "content": "Usage limit reset · continuing"})
        tr.update()
        self.assertIsNone(tr.limit)


class HolderTests(Base):
    def test_holds_names_the_slot(self):
        self.assertEqual(_holds([0], 1), "holds the window")
        self.assertEqual(_holds([1], 2), "holds window 2")
        self.assertEqual(_holds([0, 1], 2), "holds both windows")

    def test_holder_by_who_write_then_name(self):
        cmd = 'until mkdir x/app.lock; do sleep 5; done; echo "art-advisor round1 captures $(date)" > x/app.lock/who'
        self.w.add(tool_use(self.now - 30, "b1", "Bash", {"command": cmd}))
        tr = self.tr()
        self.assertEqual(_holder("art-advisor round1 captures Thu Oct 22", None, {"adv": tr}, {}, {}), "adv")
        self.assertEqual(_holder("worker capture Thu", None, {"w1": Transcript(self.path, 1)}, {}, {"worker": "w1"}), "w1")
        # a fresh worker per task (hp<N>): "worker …" means the current one, not an old agent named worker
        trs = {"old": Transcript(self.path, 1), "hp129": Transcript(self.path, 1)}
        self.assertEqual(_holder("worker capture Thu", None, trs, {}, {"worker": "old"}, "hp129"), "hp129")
        self.assertEqual(_holder("lead build+show 152", None, {}, {}, {}), "lead")
        self.assertEqual(_holder("MP 111 build + captures", None, {"m": tr}, {"m": 111}, {}), "m")
        self.assertEqual(_holder("hp183c capture 22:09 pid=1", None, {"c": tr}, {}, {"hp183c": "c"}), "c")   # unnamed, described "hp183c: …"
        self.assertEqual(_holder("hp183c capture 22:09 pid=1", None, {"c": tr}, {"c": 183}, {}), "c")        # else by its row


class RedactTests(unittest.TestCase):
    def test_secrets(self):
        for s in ["sk-ant-api03-abcdefghijk", "ghp_" + "a" * 30, "GITHUB_TOKEN=abcdef123", "password=hunter22", "Bearer abcdefghijklmnopq"]:
            self.assertNotIn(s.split("=")[-1].split()[-1], redact(s), s)
        self.assertEqual(redact("plain words"), "plain words")

    def test_clip_word_boundary(self):
        self.assertEqual(clip("the quick brown fox jumps", 13), "the quick…")


def agent(aid, key, since=0, **kw):
    d = {"id": aid, "label": aid, "ctx": 0, "ctx_max": 1, "finished": False, "parent": "lead", "group": None, "role": "helper",
         "state": {"key": key, "label": key, "since": since}, "qstate": []}
    d.update(kw)
    return d


def session(agents, rows, msgs=(), window=None, lead_key="waiting_user", state_file="running 153", caf=True, modes=None):
    return {"id": "s", "project": "p", "lead": {"state": {"key": lead_key}}, "agents": agents, "messages": list(msgs),
            "wts": {"root": "/r", "error": None, "state_file": state_file, "caffeinate": caf, "app": "App", "app_running": False,
                    "modes": modes or {"MP": "desk", "LP": "desk"}, "window": window or {"held": False, "waiters": []},
                    "groups": {"HP": rows, "MP": [], "LP": []}}}


class AlertTests(unittest.TestCase):
    def keys(self, s, now=None):
        return {a["key"].split(":")[0] for a in alerts.compute([s], now or time.time(), alerts.Memory())}

    def test_a_waiting_worker_is_not_orphaned(self):  # audit M2; waiting for a message is normal (the user's call)
        now = time.time()
        rows = [{"n": 153, "kind": "active", "status": "in progress", "title": "t", "agent": "w"}]
        s = session([agent("w", "ended", now - 1200, role="worker"), agent("adv", "running", now - 5, role="helper")], rows,
                    msgs=[{"t": now - 900, "from": "w", "to": "adv", "kind": "send"}])
        self.assertNotIn("orphan-row", self.keys(s, now))
        s = session([agent("w", "ended", now - 7200, role="worker")], rows)
        self.assertNotIn("orphan-row", self.keys(s, now))
        s = session([agent("w", "dead", now - 1200, role="worker")], rows)
        self.assertIn("orphan-row", self.keys(s, now))

    def test_caffeinate_only_when_working(self):
        rows = [{"n": 1, "kind": "queued", "status": "queued", "title": "t", "agent": None}]
        self.assertNotIn("caffeinate", self.keys(session([], rows, state_file="stopped", caf=False)))
        self.assertIn("caffeinate", self.keys(session([], rows, state_file="running 1", caf=False)))

    def test_desk_waiters_do_not_alert(self):
        a = agent("m", "waiting_window", group="MP")
        a["state"]["via"] = "row"
        s = session([a], [], window={"held": False, "waiters": ["m"]})
        mem, now = alerts.Memory(), time.time()
        alerts.compute([s], now - 300, mem)
        self.assertNotIn("waiting-free", {x["key"].split(":")[0] for x in alerts.compute([s], now, mem)})

    def test_each_window_slot_is_checked(self):   # two game windows: a stale lock names its slot; a free one is no alert
        now = time.time()
        slots = [{"name": "app.lock", "held": True, "who": "w capture", "since": now - 60, "holder": "w"},
                 {"name": "app2.lock", "held": True, "who": "adv capture", "since": now - 1200, "holder": "adv"}]
        s = session([agent("w", "running", now - 5, role="worker"), agent("adv", "dead", now - 1200)], [],
                    window={"held": True, "full": True, "slots": slots, "waiters": []})
        got = [a for a in alerts.compute([s], now, alerts.Memory()) if a["key"].startswith("stale-lock")]
        self.assertEqual([(a["key"], a["title"]) for a in got], [("stale-lock:/r:app2.lock", "Stale lock on window 2?")])
        slots[1] = {"name": "app2.lock", "held": False, "who": None, "since": None, "holder": None}
        self.assertNotIn("stale-lock", self.keys(s, now))

    def test_stale_row_only_when_the_write_did_not_land(self):
        now = time.time()
        hm = time.strftime("%H:%M", time.localtime(now - 60))
        a = agent("w", "running", now - 5, role="worker")
        a["qstate"] = [{"t": now - 60, "n": 5, "head": "in progress $(date +%H:%M): built", "id": "x", "error": True}]
        landed = [{"n": 5, "kind": "active", "status": f"⏩ in progress {hm}", "title": "t", "agent": "w"}]
        self.assertNotIn("stale-row", self.keys(session([a], landed), now))
        refused = [{"n": 5, "kind": "active", "status": "⏩ in progress 03:00", "title": "t", "agent": "w"}]
        self.assertIn("stale-row", self.keys(session([a], refused), now))

    def test_no_stale_row_while_paused(self):
        now = time.time()
        a = agent("l", "parked", now - 5, role="lp")
        a["qstate"] = [{"t": now - 60, "n": 77, "head": "in progress $(date +%H:%M): at the desk", "id": "x", "error": True}]
        rows = [{"n": 77, "kind": "paused", "status": "✋ paused 14:14", "title": "t", "agent": "l"}]
        self.assertNotIn("stale-row", self.keys(session([a], rows), now))

    def test_no_context_alert(self):
        a = agent("w", "running", role="worker", ctx=950000, ctx_max=1000000)
        self.assertNotIn("ctx", self.keys(session([a], [])))


if __name__ == "__main__":
    unittest.main()
