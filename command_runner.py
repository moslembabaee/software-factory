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
    capture_stderr: bool = False,
) -> tuple[int, str] | tuple[int, str, str]:
    """Shell only for trusted verification commands; argv for agent/Git transport.

    File-backed capture bounds memory. A timeout kills the entire process group,
    including shell children, before another agent can edit the same checkout.
    If capture_stderr is True, returns (code, stdout_tail, stderr_tail).
    """
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as stderr_output:
        try:
            process = subprocess.Popen(
                command, shell=isinstance(command, str), cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=output,
                stderr=stderr_output if capture_stderr else subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as error:
            if capture_stderr:
                return -2, "", str(error)
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
        if capture_stderr:
            stderr_output.seek(max(0, stderr_output.tell() - OUTPUT_LIMIT))
            stderr_tail = stderr_output.read().decode("utf-8", errors="replace")
            if timed_out:
                return -1, f"Command timed out after {timeout}s\n{tail}", stderr_tail
            return process.returncode, tail, stderr_tail
        if timed_out:
            return -1, f"Command timed out after {timeout}s\n{tail}"
        return process.returncode, tail


def run_cmd_with_stderr(
    command: str | Sequence[str], timeout: float = 720,
    cwd: Path = PROJECT_ROOT,
) -> tuple[int, str, str]:
    """Execute command and capture stdout and stderr separately."""
    result = run_cmd(command, timeout=timeout, cwd=cwd, capture_stderr=True)
    if isinstance(result, tuple) and len(result) == 3:
        return result
    return result[0], result[1], ""

