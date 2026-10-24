"""Token statistics on synthetic transcripts: python3 -m unittest discover -s tests"""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest

from ccprobe import tokens
from ccprobe.model import _label_of_meta, _role_of_meta, _task_of_meta


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


def reply(mid, t, inp=0, cw=0, cr=0, out=0, block="text"):
    return {"type": "assistant", "timestamp": iso(t), "uuid": f"u{mid}{block}",
            "message": {"id": mid, "model": "claude-opus-5-5", "content": [{"type": block, "text": "x"}],
                        "usage": {"input_tokens": inp, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr,
                                  "output_tokens": out, "server_tool_use": {"web_search_requests": 0}}}}


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.jsonl")
        open(self.path, "w").close()
        self.lock = threading.Lock()
        self.L = tokens.Ledger(self.path)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def add(self, *entries, raw=b""):
        with open(self.path, "ab") as f:
            for e in entries:
                f.write(json.dumps(e, separators=(",", ":")).encode() + b"\n")
            f.write(raw)

    def test_a_reply_written_as_several_entries_counts_once(self):
        t = time.time()
        self.add(reply("msg_1", t, 2, 100, 1000, 50, "thinking"), reply("msg_1", t, 2, 100, 1000, 50, "text"),
                 reply("msg_1", t, 2, 100, 1000, 50, "tool_use"), reply("msg_2", t + 5, 1, 10, 1100, 7))
        self.L.read(self.lock)
        self.assertEqual(self.L.total, [3, 110, 2100, 57])
        self.assertEqual(self.L.replies, 2)
        self.assertEqual(self.L.days[tokens.day_of(t)], [3, 110, 2100, 57])
        self.assertTrue(self.L.done)

    def test_quoted_usage_in_a_tool_result_is_not_counted(self):
        t = time.time()
        # an Agent tool's result carries the subagent's usage as an object: that is the subagent's, counted in its file
        self.add({"type": "user", "timestamp": iso(t), "toolUseResult": {"usage": {"input_tokens": 9, "output_tokens": 999}}},
                 {"type": "user", "timestamp": iso(t), "message": {"content": "a pasted \"usage\":{\"output_tokens\":5}"}},
                 reply("msg_1", t, 1, 1, 1, 1))
        self.L.read(self.lock)
        self.assertEqual(self.L.total, [1, 1, 1, 1])

    def test_reads_only_what_was_appended_and_waits_for_a_line_end(self):
        t = time.time()
        self.add(reply("msg_1", t, out=10))
        self.L.read(self.lock)
        line = json.dumps(reply("msg_2", t, out=5), separators=(",", ":")).encode()
        self.add(raw=line[:40])
        self.L.read(self.lock)
        self.assertEqual(self.L.total[3], 10)
        self.add(raw=line[40:] + b"\n")
        self.L.read(self.lock)
        self.assertEqual((self.L.total[3], self.L.replies), (15, 2))

    def test_compactions_and_truncation(self):
        t = time.time()
        self.add(reply("msg_1", t, out=10), {"type": "system", "subtype": "compact_boundary", "timestamp": iso(t)})
        self.L.read(self.lock)
        self.assertEqual(self.L.compactions, 1)
        open(self.path, "w").close()
        self.add(reply("msg_9", t, out=3))
        self.L.read(self.lock)
        self.assertEqual((self.L.total[3], self.L.replies, self.L.compactions), (3, 1, 0))

    def test_a_huge_reply_line_is_cut_not_decoded(self):
        t = time.time()
        e = reply("msg_big", t, 1, 2, 3, 4)
        e["message"]["content"][0]["text"] = "y" * (tokens.MAX_DECODE + 10)
        self.add(e)
        self.L.read(self.lock)
        self.assertEqual((self.L.total, self.L.replies), ([1, 2, 3, 4], 1))

    def test_minutes_keep_the_last_six_hours(self):
        now = time.time()
        self.add(reply("msg_old", now - 8 * 3600, out=1), reply("msg_new", now - 60, out=2))
        self.L.read(self.lock)
        self.assertEqual(sum(v[3] for v in self.L.minutes.values()), 2)
        self.assertEqual(self.L.total[3], 3)


class AttributionTests(unittest.TestCase):
    rows = {129: {"group": "HP"}, 112: {"group": "MP"}, 74: {"group": "LP"}}

    def test_task_role_and_label_of_agents_out_of_view(self):
        self.assertEqual(_task_of_meta({"name": "hp129"}, self.rows), 129)
        self.assertEqual(_task_of_meta({"name": "adv129"}, self.rows), 129)
        self.assertEqual(_task_of_meta({"description": "Task 74: Part 5 rebuild"}, self.rows), 74)
        self.assertIsNone(_task_of_meta({"name": "adv555"}, self.rows))
        self.assertEqual(_role_of_meta({"name": "mp112"}, self.rows), "mp")
        self.assertEqual(_role_of_meta({"name": "hp129"}, self.rows), "worker")
        self.assertEqual(_role_of_meta({"name": "reviewer"}, self.rows), "helper")
        self.assertEqual(_label_of_meta({"name": "hp129"}, self.rows, "a1"), "HP 129")
        self.assertEqual(_label_of_meta({"name": "mp112"}, self.rows, "a1"), "MP 112")


if __name__ == "__main__":
    unittest.main()
