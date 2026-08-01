"""Run the dependency-free browser puzzle tests through pytest."""
from pathlib import Path
import shutil
import subprocess

import pytest


NODE = shutil.which("node")
ROOT = Path(__file__).resolve().parents[1]
SUITES = sorted((ROOT / "tests").glob("*.test.js"))


@pytest.mark.skipif(NODE is None, reason="Node.js is not available")
def test_browser_puzzle_modules():
    completed = subprocess.run(
        [NODE, "--test", *(str(suite) for suite in SUITES)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    assert completed.returncode == 0, output
