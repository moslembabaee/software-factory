"""Bounded command transport for trusted repository automation."""

import os
from pathlib import Path
import signal
import subprocess
import tempfile
from typing import Sequence

PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_LIMIT = 16_000


def run_cmd(
    command: str | Sequence[str], timeout: float = 720,
    cwd: Path = PROJECT_ROOT,
) -> tuple[int, str]:
    """Shell only for trusted verification commands; argv for agent/Git transport.

    File-backed capture bounds memory. A timeout kills the entire process group,
    including shell children, before another agent can edit the same checkout.
    """
    with tempfile.TemporaryFile() as output:
        try:
            process = subprocess.Popen(
                command, shell=isinstance(command, str), cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=output,
                stderr=subprocess.STDOUT, start_new_session=True,
            )
        except OSError as error:
            return -2, str(error)
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            if isinstance(error, KeyboardInterrupt):
                raise
            timed_out = True
        output.seek(max(0, output.tell() - OUTPUT_LIMIT))
        tail = output.read().decode("utf-8", errors="replace")
        if timed_out:
            return -1, f"Command timed out after {timeout}s\n{tail}"
        return process.returncode, tail

