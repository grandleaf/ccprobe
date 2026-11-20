"""The agent panel's detail (/api/agent): brief, report, files, trouble, background jobs, the command in flight."""
import os
import unittest

from ccprobe import agents
from ccprobe.agents import HOME, StepLog, clean_cmd, read_brief, tool_arg
from ccprobe.model import Collector
from test_core import Base, iso, result, text, tool_use


def first_prompt(t, text):
    return {"type": "user", "timestamp": iso(t), "cwd": "/repo", "gitBranch": "main", "message": {"role": "user", "content": text}}


class DetailTests(Base):
    def test_brief_is_the_first_prompt(self):
        self.w.add(first_prompt(self.now - 100, "You are hp7. Make the clouds soft. token=abcd1234secret"))
        tr = self.tr()
        b, d = tr.brief(), tr.detail(self.now, rel="/repo")    # the brief is read apart (a file read, outside the lock)
        self.assertTrue(b["text"].startswith("You are hp7. Make the clouds soft."))
        self.assertNotIn("abcd1234secret", b["text"])
        self.assertAlmostEqual(b["t"], self.now - 100, delta=1)
        self.assertEqual(d["branch"], "main")

    def test_report_and_rounds(self):
        self.w.add(tool_use(self.now - 50, "h1", "SubagentHandback", {"message": "Round one.\nDetails"}),
                   tool_use(self.now - 10, "h2", "SubagentHandback", {"message": "Round two: done."}))
        d = self.tr().detail(self.now)
        self.assertEqual(d["rounds"], 2)
        self.assertEqual(d["report"]["text"], "Round two: done.")

    def test_now_reads_as_its_description(self):
        cmd = "cd ~/proj; until mkdir .lock 2>/dev/null; do sleep 15; done"
        self.w.add(tool_use(self.now - 30, "b1", "Bash", {"command": cmd, "description": "Wait for the window"}))
        d = self.tr().detail(self.now)
        self.assertEqual(d["now"]["desc"], "Wait for the window")
        self.assertEqual(d["now"]["cmd"], "until mkdir .lock 2>/dev/null; do sleep 15; done")
        self.assertEqual(tool_arg("Bash", {"command": "cd /x && ls -la"}), "ls -la")

    def test_clean_cmd(self):
        tmp = "/private/tmp/claude-501/-Users-me-proj/12345678-1234-4123-8123-123456789abc/scratchpad/x.py"
        self.assertEqual(clean_cmd(f"cd \"{HOME}/p\" && python3 {tmp}"), "python3 …/scratchpad/x.py")

    def test_files_own_and_seen_in_a_shared_tree(self):
        patch = [{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 2, "lines": [" a", "-b", "+c", "+d"]}]
        self.w.add(tool_use(self.now - 40, "e1", "Edit", {"file_path": "/repo/src/a.py"}),
                   result(self.now - 39, "e1", extra={"filePath": "/repo/src/a.py", "structuredPatch": patch}),
                   tool_use(self.now - 30, "b1", "Bash", {"command": "python3 fix.py src/b.py", "description": "Fix b"}),
                   result(self.now - 29, "b1", extra={"stdout": "", "bashEditDiff": {"shared": True, "moreFiles": 3, "files": [
                       {"filePath": "/repo/src/b.py", "hunks": patch}, {"filePath": "/repo/other/c.py", "hunks": patch}]}}))
        d = self.tr().detail(self.now, rel="/repo")
        self.assertEqual([(f["path"], f["add"], f["del"]) for f in d["files"]], [("src/b.py", 2, 1), ("src/a.py", 2, 1)])
        self.assertEqual([f["path"] for f in d["seen"]], ["other/c.py"])
        self.assertEqual(d["seen_n"], 4)              # one listed, three only counted

    def test_trouble_counts(self):
        deny = result(self.now - 20, "b2", err=True)
        deny["permissionDecision"] = {"decision": "reject", "source": "config"}
        fail = result(self.now - 10, "b3", err=True)
        fail["message"]["content"][0]["content"] = "Error: Exit code 1\nTraceback: boom"
        entries = [tool_use(self.now - 60 + i, f"r{i}", "Bash", {"command": "ls /x", "description": "List x"}) for i in range(3)]
        self.w.add(*entries, tool_use(self.now - 21, "b2", "Bash", {"command": "pkill x"}), deny,
                   tool_use(self.now - 11, "b3", "Bash", {"command": "python3 t.py"}), fail)
        tr = self.tr()
        d = tr.detail(self.now)["trouble"]
        self.assertEqual((d["errors"], d["denials"]), (1, 1))
        self.assertEqual(d["last_error"]["text"], "Exit code 1 · Traceback: boom")
        self.assertEqual(d["repeat"], {"n": 3, "what": "List x"})
        self.assertTrue(next(h for h in tr.history if h["id"] == "b3").get("err"))

    def test_background_job_ends_when_it_stops_it(self):
        self.w.add(tool_use(self.now - 30, "bg1", "Bash", {"command": "tools/x_blender.sh", "run_in_background": True, "description": "Build"}),
                   result(self.now - 29, "bg1", extra={"stdout": "", "backgroundTaskId": "bgx1"}))
        tr = self.tr()
        self.assertEqual([j["desc"] for j in tr.detail(self.now)["bg"]], ["Build"])
        self.w.add(tool_use(self.now - 10, "s1", "TaskStop", {"task_id": "bgx1"}), result(self.now - 9, "s1"))
        tr.update()
        self.assertEqual(tr.detail(self.now)["bg"], [])            # no notice follows a stop: the stop ends it

    def test_background_job_listed_until_its_notice(self):
        self.w.add(tool_use(self.now - 30, "bg1", "Bash", {"command": "sleep 99", "run_in_background": True, "description": "Render"}),
                   result(self.now - 29, "bg1", extra={"stdout": "", "backgroundTaskId": "bgx1"}))
        tr = self.tr()
        self.assertEqual([j["desc"] for j in tr.detail(self.now)["bg"]], ["Render"])
        self.w.add({"type": "attachment", "timestamp": iso(self.now - 5), "attachment": {"type": "queued_command",
                    "origin": {"kind": "task-notification"}, "prompt": "<task-notification><task-id>bgx1</task-id><status>completed</status></task-notification>"}})
        tr.update()
        self.assertEqual(tr.detail(self.now)["bg"], [])


    def test_the_brief_whole_for_the_documents_it_names(self):
        long = "You are lp42c. " + "word " * 1000 + "Then read .autopilot/future/status.md."
        self.w.add(first_prompt(self.now - 100, long))
        tr = self.tr()
        self.assertTrue(tr.brief()["text"].endswith("…"))                  # shown cut at 4000
        self.assertTrue(tr.brief_full.endswith(".autopilot/future/status.md."))
        self.assertEqual(read_brief(self.path)[1], tr.brief_full)
        self.assertIs(read_brief(self.path + ".none"), False)

    def test_messages_keep_their_whole_text(self):
        msg = "lp42c plan: (1) read the sources\n(2) archive\n(3) edits " + "x" * 9000
        self.w.add(tool_use(self.now - 20, "m1", "SendMessage", {"to": "main", "summary": "lp42c plan", "message": msg}),
                   tool_use(self.now - 10, "h1", "SubagentHandback", {"message": "Done.\nAll of it. token=abcd1234secret"}))
        tr = self.tr()
        send, back = list(tr.messages)
        self.assertEqual((send["summary"], send["text"].split("\n")[0]), ("lp42c plan", "lp42c plan: (1) read the sources"))
        self.assertLessEqual(len(send["text"]), agents.MSG_MAX)
        self.assertEqual(back["summary"], "Done.")
        self.assertNotIn("abcd1234secret", back["text"])

    def test_message_by_its_id(self):
        self.w.add(first_prompt(self.now - 100, "You are crit7."),
                   tool_use(self.now - 20.5, "m1", "SendMessage", {"to": "main", "summary": "plan", "message": "the whole plan"}))
        c, tr = Collector(), self.tr()
        c.trs[self.path] = tr
        c.where[("s1", "a1")] = (self.path, "/repo")
        t = tr.messages[0]["t"]
        self.assertEqual(c.message("s1", f"a1>lead@{t:.3f}")["text"], "the whole plan")
        self.assertEqual(c.message("s1", "lead>a1@spawn")["text"], "You are crit7.")      # a spawn's: the brief it got
        for bad in (f"a1>lead@{t + 1:.3f}", "a1>lead", "../x>lead@1.000", f"a2>lead@{t:.3f}"):
            self.assertIsNone(c.message("s1", bad), bad)
        steps = c.steps("s1", "a1")
        self.assertEqual([x["tool"] for x in steps["steps"]], ["SendMessage"])
        self.assertIsNone(c.steps("s1", "nobody"))

    def test_task_docs_kept_in_order(self):
        c = Collector()
        c._add_docs("/r", 7, [("a/journal.md", "journal"), ("b-brief.md", "brief")])
        c._add_docs("/r", 7, [("a/status.md", "status"), ("a/journal.md", "journal")])
        self.assertEqual(c.task_docs[("/r", 7)], [("a/status.md", "status"), ("a/journal.md", "journal"), ("b-brief.md", "brief")])


class StepLogTests(Base):
    def test_every_step_and_what_it_said(self):
        self.w.add({"type": "api-request-blob", "body": {"messages": [{"type": "tool_use", "name": "Bash"}]}},
                   tool_use(self.now - 50, "b1", "Bash", {"command": "cd /x && make", "description": "Build it"}),
                   result(self.now - 49, "b1", err=True),
                   text(self.now - 40, "Building failed; trying again.\nMore."),
                   tool_use(self.now - 30, "r1", "Read", {"file_path": HOME + "/p/a.md"}),
                   tool_use(self.now - 20, "m1", "SendMessage", {"to": "main", "summary": "done", "message": "all"}))
        log = StepLog(self.path)
        log.read()
        got = log.since()
        self.assertEqual([(x["tool"], x["arg"]) for x in got["steps"]],
                         [("Bash", "Build it"), ("said", "Building failed; trying again."), ("Read", "~/p/a.md"), ("SendMessage", "done")])
        self.assertEqual((got["n"], got["cut"], got["steps"][0]["cmd"], got["steps"][0].get("err")), (4, False, "make", True))
        self.assertEqual(got["steps"][3]["to"], "main")
        self.w.add(tool_use(self.now - 10, "g1", "Grep", {"pattern": "boss"}))
        log.read()                                   # only what the file gained
        self.assertEqual([x["tool"] for x in log.since(after=got["steps"][3]["t"])["steps"]], ["SendMessage", "Grep"])

    def test_a_long_file_from_its_last_part(self):
        old = agents.STEPS_BACK
        agents.STEPS_BACK = 2000
        try:
            self.w.add(*[tool_use(self.now - 100 + i, f"b{i}", "Bash", {"command": "ls", "description": f"step {i}"}) for i in range(40)])
            log = StepLog(self.path)
            log.read()
            got = log.since()
            self.assertTrue(got["cut"])
            self.assertEqual(got["steps"][-1]["arg"], "step 39")
            self.assertLess(got["n"], 40)
        finally:
            agents.STEPS_BACK = old


class WhatTests(unittest.TestCase):
    def test_what_a_job_runs_or_waits_on(self):
        from ccprobe.agents import what_of
        cases = [("cd /p; S=/tmp/s; SWART_SCRATCH=$S/swart Blender -b --factory-startup -P tools/art/x.py", "Fast build", "Blender"),
                 ("L=/tmp/blend6; until grep -q check_nodes $L.out; do sleep 15; done", "Wait for the rib build", "Blender"),
                 (".autopilot/worker/bin/model_blender.sh /tmp/full1 > /tmp/o", "Build the live model", "Blender"),
                 ("L=~/Library/App/licenses/x.xml; m0=$(stat -f %m $L); for i in $(seq 1 720); do sleep 10; done",
                  "Wait for the license file to be renewed", "licence"),
                 ("WHO=lead tools/build.sh /tmp/b.log", "Rebuild", "build"),
                 ("WHO=hp1 .autopilot/worker/bin/shots.sh /tmp/a 'after x 0 1 2'", "Capture frames", "capture"),
                 ("tools/t1.sh /tmp/t1.log", "Run related tests and the cover rows", "tests"),
                 ("until grep -q done /tmp/x.output; do sleep 5; done", "Wait for the round 3 package", None)]
        for cmd, desc, want in cases:
            got = what_of(cmd, desc)
            self.assertEqual(got and got[0], want, desc)


class TaskPatternTests(unittest.TestCase):
    def test_names_with_a_round(self):
        from ccprobe.model import RE_HP_NAME, RE_NAME_TASK
        cases = {"hp128": (128, 128), "hp128r3": (128, 128), "hp141b": (141, 141), "mp141b": (None, 141),
                 "hp128review": (None, None), "hp12x3": (None, None)}
        for name, want in cases.items():
            m1, m2 = RE_HP_NAME.match(name), RE_NAME_TASK.match(name)
            self.assertEqual((m1 and int(m1.group(1)), m2 and int(m2.group(1))), want, name)

    def test_what_binds_an_agent_to_a_row(self):
        from ccprobe.model import RE_HP_DESC, RE_TASK
        cases = {"Task 74: Part 5": (74, None), "MP 141b: widgets": (141, None), "HP 135 redo: realistic": (135, 135),
                 "HP 135 round 2: again": (135, 135), "HP 135 review: check": (None, None), "MP 141 advisor: plan": (None, None),
                 "Task 2026-10-24 notes: x": (None, None), "HP 12 vs HP 13: compare": (None, None), "Advisor 141: x": (None, None),
                 "HP 135 redo 2: again": (135, 135), "HP 135 (Redo): again": (135, 135), "HP 135 fix: x": (135, 135),
                 "hp2: printer driver": (None, None), "mp4: transcode": (None, None), "MP 141B: x": (141, None)}
        for text, (task, hp) in cases.items():
            m1, m2 = RE_TASK.match(text), RE_HP_DESC.match(text)
            self.assertEqual((m1 and int(m1.group(1)), m2 and int(m2.group(1))), (task, hp), text)

    def test_an_unnamed_worker_described_by_its_name(self):
        from ccprobe.model import _hp_of_desc
        rows = {178: {"group": "HP"}, 2: {"group": "LP"}}
        cases = {"hp178b: widget redo": 178, "hp178r2: again": 178, "HP 178 redo: x": 178, "hp2: printer driver": None,
                 "hp179b: no such row": None}
        for d, want in cases.items():
            self.assertEqual(_hp_of_desc({"description": d}, rows), want, d)
        self.assertIsNone(_hp_of_desc({"description": "hp178b: x", "name": "adv178"}, rows))   # a name says who it is
        self.assertIsNone(_hp_of_desc({"description": "hp178b: x", "spawnDepth": 2}, rows))   # a helper's helper

    def test_notes_only_once_written(self):   # an unnamed "HP 282: …" worker before its first note crashed the session
        from ccprobe.model import _notes_of
        meta = {"description": "HP 282: fix the thing"}
        self.assertIsNone(_notes_of(None, meta, {}))
        self.assertIsNone(_notes_of(282, meta, {281: 5.0}))
        self.assertEqual(_notes_of(None, meta, {282: 5.0}), {"n": 282, "t": 5.0})
        self.assertEqual(_notes_of(281, meta, {281: 4.0, 282: 5.0}), {"n": 281, "t": 4.0})   # its row's task first

    def test_a_helper_described_by_its_name(self):
        from ccprobe.model import _task_of_meta
        rows = {191: {"group": "HP"}}
        self.assertEqual(_task_of_meta({"description": "adv191c: review advisor"}, rows), 191)
        self.assertEqual(_task_of_meta({"name": "adv191c", "description": "x"}, rows), 191)
        self.assertIsNone(_task_of_meta({"description": "adv191c: x"}, rows, primary=True))   # a helper is not the task's own
        self.assertIsNone(_task_of_meta({"description": "adv192: x"}, rows))


if __name__ == "__main__":
    unittest.main()
