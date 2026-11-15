"""The page-files fingerprint an open page reloads on: python3 -m unittest discover -s tests"""
import os
import shutil
import tempfile
import unittest

from ccprobe import server


class CodeSigTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.was = server.STATIC
        server.STATIC = self.dir
        for name in server.FILES:
            with open(os.path.join(self.dir, name), "w") as f:
                f.write("x")

    def tearDown(self):
        server.STATIC = self.was
        server._code.update(t=0.0, v="")
        shutil.rmtree(self.dir)

    def sig(self):
        server._code["t"] = 0.0          # past the once-a-second cache
        return server.code_sig()

    def test_changes_with_the_files_only(self):
        a = self.sig()
        self.assertEqual(self.sig(), a)                       # nothing changed: the same, so no reload
        with open(os.path.join(self.dir, "app.js"), "w") as f:
            f.write("a new layout rule")
        b = self.sig()
        self.assertNotEqual(b, a)                             # an edit: a new one, so open pages reload
        os.unlink(os.path.join(self.dir, "app.css"))
        self.assertNotEqual(self.sig(), b)                    # a missing file is a change too, not an error

    def test_cached_for_a_second(self):
        a = self.sig()
        with open(os.path.join(self.dir, "app.js"), "w") as f:
            f.write("changed")
        self.assertEqual(server.code_sig(), a)                # read at most once a second per server
