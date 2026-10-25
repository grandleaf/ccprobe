"""The agent panel's detail (/api/agent): brief, report, files, trouble, background jobs, the command in flight."""
import os
import unittest

from ccprobe.agents import HOME, clean_cmd, tool_arg
from test_core import Base, iso, result, tool_use


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

    def test_background_job_listed_until_its_notice(self):
        self.w.add(tool_use(self.now - 30, "bg1", "Bash", {"command": "sleep 99", "run_in_background": True, "description": "Render"}),
                   result(self.now - 29, "bg1", extra={"stdout": "", "backgroundTaskId": "bgx1"}))
        tr = self.tr()
        self.assertEqual([j["desc"] for j in tr.detail(self.now)["bg"]], ["Render"])
        self.w.add({"type": "attachment", "timestamp": iso(self.now - 5), "attachment": {"type": "queued_command",
                    "origin": {"kind": "task-notification"}, "prompt": "<task-notification><task-id>bgx1</task-id><status>completed</status></task-notification>"}})
        tr.update()
        self.assertEqual(tr.detail(self.now)["bg"], [])


if __name__ == "__main__":
    unittest.main()
