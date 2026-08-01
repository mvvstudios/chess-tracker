"""Run the dependency-free browser puzzle-domain tests through pytest."""
from pathlib import Path
import shutil
import subprocess

import pytest


NODE = shutil.which("node")
ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "puzzle-domain.test.js"


@pytest.mark.skipif(NODE is None, reason="Node.js is not available")
def test_browser_puzzle_domain():
    completed = subprocess.run(
        [NODE, "--test", str(SUITE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    assert completed.returncode == 0, output
