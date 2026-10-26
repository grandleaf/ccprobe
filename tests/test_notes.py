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


if __name__ == "__main__":
    unittest.main()
