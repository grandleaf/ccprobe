"""A task's notes for the panel and the reader: the worker's <N>.md, the lead's briefs, the pictures the notes name."""
import os
import tempfile
import unittest

from ccprobe import wts

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


class NotesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "proj")
        self.wd = os.path.join(self.root, ".autopilot", "worker")
        os.makedirs(os.path.join(self.wd, "181"))
        os.makedirs(os.path.join(self.root, ".autopilot", "trail-ref"))
        self.put(os.path.join(self.wd, "181", "sheet.png"), PNG)
        self.put(os.path.join(self.root, ".autopilot", "trail-ref", "cmp_r1.png"), PNG)
        self.put(os.path.join(self.tmp.name, "outside.png"), PNG)
        os.symlink(os.path.join(self.tmp.name, "outside.png"), os.path.join(self.wd, "181", "link.png"))
        self.put(os.path.join(self.wd, "181.md"), (
            "# Task 181 (HP): menus close. Notes by hp181\n\n## The fix\n- token=abcd1234secret\n"
            "- sheet: `.autopilot/worker/181/sheet.png`, again `sheet.png`\n- refs in `.autopilot/trail-ref/`: cmp_r1.png\n"
            f"- outside: `{self.tmp.name}/outside.png`, `../../../outside.png`, `181/link.png`, `<out>/x.png`, missing.png\n").encode())
        self.put(os.path.join(self.wd, "181-brief.md"), b"# brief")
        self.put(os.path.join(self.wd, "181-redo2-brief.md"), b"# redo 2 brief")
        self.put(os.path.join(self.wd, "1810-brief.md"), b"# another task")

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def put(path, data):
        with open(path, "wb") as f:
            f.write(data)

    def test_notes_briefs_and_pictures(self):
        d = wts.notes(self.root, 181)
        self.assertEqual([(x["kind"], x["name"]) for x in d["docs"]][0], ("notes", "181.md"))
        self.assertEqual(sorted(x["name"] for x in d["docs"][1:]), ["181-brief.md", "181-redo2-brief.md"])
        self.assertNotIn("abcd1234secret", d["docs"][0]["text"])
        self.assertEqual([(p["name"], p["refs"]) for p in d["pics"]],
                         [("sheet.png", [".autopilot/worker/181/sheet.png", "sheet.png"]), ("cmp_r1.png", ["cmp_r1.png"])])
        self.assertEqual(wts.notes_pic(self.root, 181, 0), ("image/png", PNG))
        self.assertIsNone(wts.notes_pic(self.root, 181, 2))      # nothing outside the project, even by a link
        self.assertIsNone(wts.notes(self.root, 7))
        self.assertEqual(wts.notes_index(self.root), {181: os.path.getmtime(os.path.join(self.wd, "181.md"))})

    def test_no_document_from_outside(self):
        secret = os.path.join(self.tmp.name, "secret.md")
        self.put(secret, b"# not the project's")
        os.symlink(secret, os.path.join(self.wd, "7.md"))
        os.symlink(secret, os.path.join(self.wd, "181-leak-brief.md"))
        self.assertIsNone(wts.notes(self.root, 7))
        self.assertNotIn("181-leak-brief.md", [x["name"] for x in wts.notes(self.root, 181)["docs"]])
        os.mkfifo(os.path.join(self.wd, "8.md"))      # never blocks on a pipe
        self.assertIsNone(wts.notes(self.root, 8))


class TaskDocsTests(unittest.TestCase):
    """A long task's own documents, found from the paths its agents' briefs name (wts.task_docs) and read with the notes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "proj")
        self.wd = os.path.join(self.root, ".autopilot", "worker")
        self.fs = os.path.join(self.root, ".autopilot", "future")
        os.makedirs(self.wd)
        os.makedirs(os.path.join(self.fs, "critic"))
        for path, text in ((os.path.join(self.fs, "status.md"), "# status\n## Update 2026-11-19 21:00\nwhere it stands"),
                           (os.path.join(self.fs, "journal.md"), "# journal"), (os.path.join(self.fs, "critic", "status.md"), "# critic"),
                           (os.path.join(self.wd, "future-brief.md"), "# the lead's brief"), (os.path.join(self.root, "status.md"), "# root"),
                           (os.path.join(self.root, "docs-brief.md"), "# not in the worker folder"),
                           (os.path.join(self.tmp.name, "status.md"), "# outside")):
            NotesTests.put(path, text.encode())
        os.makedirs(os.path.join(self.root, "linked"))
        os.symlink(os.path.join(self.tmp.name, "status.md"), os.path.join(self.root, "linked", "status.md"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_found_from_a_brief(self):
        home = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp.name               # "~/proj/…" as a brief names it
        try:
            text = ("Read `~/proj/.autopilot/worker/future-brief.md`, then `.autopilot/future/critic/status.md` and "
                    ".autopilot/future/status.md (your status.md; critic/status.md is the critic's). Not: linked/status.md, "
                    f"{self.tmp.name}/status.md, docs-brief.md, .autopilot/none/status.md, notes.md, status.mdx")
            got = wts.task_docs(self.root, text)
        finally:
            os.environ["HOME"] = home
        self.assertEqual(got, [(".autopilot/future/critic/status.md", "status"), (".autopilot/future/status.md", "status"),
                               (".autopilot/future/journal.md", "journal"),           # a bare "status.md": not the root's
                               (".autopilot/worker/future-brief.md", "brief")])
        self.assertEqual(wts.task_docs(self.root, ""), [])

    def test_read_with_the_notes(self):
        extra = [(".autopilot/future/status.md", "status"), (".autopilot/future/journal.md", "journal"),
                 (".autopilot/worker/future-brief.md", "brief"), ("linked/status.md", "status"), ("../status.md", "status")]
        d = wts.notes(self.root, 42, extra)
        self.assertEqual([(x["kind"], x["path"]) for x in d["docs"]],
                         [("status", ".autopilot/future/status.md"), ("journal", ".autopilot/future/journal.md"),
                          ("brief", ".autopilot/worker/future-brief.md")])      # nothing from outside, even by a link
        self.assertEqual(d["pics"], [])
        NotesTests.put(os.path.join(self.wd, "42.md"), b"# notes")
        NotesTests.put(os.path.join(self.wd, "42-brief.md"), b"# brief")
        d = wts.notes(self.root, 42, extra + [(".autopilot/future/status.md", "status")])
        self.assertEqual([x["kind"] for x in d["docs"]], ["notes", "status", "journal", "brief", "brief"])   # once each
        self.assertIsNone(wts.notes(self.root, 43))
        self.assertEqual(wts.docs_mtime(self.root, extra[:2]), max(os.path.getmtime(os.path.join(self.fs, x)) for x in ("status.md", "journal.md")))


if __name__ == "__main__":
    unittest.main()
