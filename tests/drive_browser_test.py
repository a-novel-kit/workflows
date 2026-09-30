"""Run the shipped reporter and comparison policy against real Playwright screenshots."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "node-actions/test-playwright/drive/runner.py"


class BrowserTest(unittest.TestCase):
    def test_comparison_approval_and_failure_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            script = f"node {ROOT}/node_modules/playwright/cli.js test -c {ROOT}/tests/visual-fixture/playwright.config.mjs"
            (work / "package.json").write_text(
                json.dumps({"private": True, "scripts": {"e2e": script}})
            )

            def run(expected, **values):
                env = dict(
                    os.environ,
                    PLAYWRIGHT_VISUAL_REPORT=".visual/results.json",
                    GITHUB_SHA="a" * 40,
                    **values,
                )
                result = subprocess.run(
                    [sys.executable, str(RUNNER), "e2e"],
                    cwd=work,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                self.assertEqual(result.returncode == 0, expected, result.stdout)
                return result.stdout

            run(True, VISUAL_SEED="true")
            original = (work / ".visual/snapshots/desktop/one.png").read_bytes()
            run(True)
            run(False, PROBE_CHANGED="true")
            self.assertEqual(
                (work / ".visual/snapshots/desktop/one.png").read_bytes(), original
            )
            run(True, PROBE_CHANGED="true", VISUAL_APPROVED="true")
            changed = (work / ".visual/snapshots/desktop/one.png").read_bytes()
            self.assertNotEqual(original, changed)
            run(
                False,
                PROBE_CHANGED="true",
                PROBE_FUNCTIONAL_FAILURE="true",
                VISUAL_APPROVED="true",
            )
            self.assertEqual(
                (work / ".visual/snapshots/desktop/one.png").read_bytes(), changed
            )
            run(False, PROBE_CAPTURE_FAILURE="true", VISUAL_APPROVED="true")
            # Recreate clean completed evidence after the capture-failure probe.
            import shutil

            shutil.rmtree(work / ".visual")
            run(True, VISUAL_SEED="true")
            run(False, PROBE_REMOVE="true")
            run(True, PROBE_REMOVE="true", VISUAL_APPROVED="true")
            self.assertFalse((work / ".visual/snapshots/desktop/two.png").exists())


if __name__ == "__main__":
    unittest.main()
