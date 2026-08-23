"""Claim one PCC valuation job and run Ian outside the cron time limit."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid


REPO = pathlib.Path(
    r"C:\Users\Asus\Documents\Codex\2026-07-16\gridgeist\portfolio-command-center-release"
)
PROMPTS = REPO / "hermes-mcp" / "BRIEFING_PROMPTS.md"
SECTION = "## Ian valuation research worker"
PROFILE = pathlib.Path(r"C:\Users\Asus\AppData\Local\hermes\profiles\ian")
CONFIG = PROFILE / "config.yaml"
STATE_DIR = PROFILE / "state" / "pcc-valuation-worker"
LOG_DIR = PROFILE / "logs" / "pcc-valuation-worker"
ACTIVE_LOCK = STATE_DIR / "active.json"


def mcp_setting(name: str) -> str:
    source = CONFIG.read_text(encoding="utf-8")
    block_match = re.search(
        r"(?ms)^\s{2}portfolio-command-center:\s*$\n(?P<block>.*?)(?=^\s{2}\S|\Z)",
        source,
    )
    if not block_match:
        raise RuntimeError("portfolio-command-center MCP config is missing")
    value_match = re.search(
        rf"(?m)^\s+{re.escape(name)}:\s*(?P<value>.+?)\s*$",
        block_match.group("block"),
    )
    if not value_match:
        raise RuntimeError(f"{name} is missing from the MCP config")
    return value_match.group("value").strip("'\"")


def agent_request(body: dict) -> dict:
    request = urllib.request.Request(
        mcp_setting("PCC_AGENT_API_URL"),
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {mcp_setting('PCC_AGENT_TOKEN')}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def claim_one_job() -> dict | None:
    return agent_request({"action": "claim_valuation_research"}).get("data")


def fail_unfinished_job(job: dict, message: str) -> None:
    claimed = job.get("job") or {}
    try:
        agent_request(
            {
                "action": "fail_valuation_research",
                "job_id": claimed["id"],
                "claim_token": claimed["claim_token"],
                "message": message[:1200],
            }
        )
    except (KeyError, OSError, RuntimeError, urllib.error.URLError, json.JSONDecodeError):
        # Completed jobs reject a second state transition; there is nothing to repair.
        pass


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) is unreliable on Windows and can raise SystemError
        # with WinError 87 for a process that has just exited.
        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except (OSError, SystemError):
        return False
    return True


def hidden_creation_flags() -> int:
    if os.name != "nt":
        return 0
    return subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP


def background_python() -> str:
    executable = pathlib.Path(sys.executable)
    if os.name == "nt":
        pythonw = executable.with_name("pythonw.exe")
        if pythonw.exists():
            return str(pythonw)
    return str(executable)


def worker_is_active() -> bool:
    try:
        state = json.loads(ACTIVE_LOCK.read_text(encoding="utf-8"))
        if process_is_alive(int(state.get("pid", 0))):
            return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    ACTIVE_LOCK.unlink(missing_ok=True)
    return False


def worker_prompt(job: dict) -> str:
    source = PROMPTS.read_text(encoding="utf-8")
    if SECTION not in source:
        raise RuntimeError("valuation worker prompt section is missing")
    contract = SECTION + source.split(SECTION, 1)[1]
    return (
        "You are Ian in the Telegram Research room. Follow this worker contract "
        "exactly. The no-agent watchdog already claimed exactly one job, so never "
        "claim another. Use the portfolio-command-center MCP tools from your profile "
        "and submit Ian's completed valuation without PCC calculation.\n\n"
        "CLAIMED JOB JSON:\n"
        + json.dumps(job, ensure_ascii=False, separators=(",", ":"))
        + "\n\n"
        + contract
    )


def clear_active_lock() -> None:
    try:
        state = json.loads(ACTIVE_LOCK.read_text(encoding="utf-8"))
        if int(state.get("pid", 0)) == os.getpid():
            ACTIVE_LOCK.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass


def run_claimed_job(job_path: pathlib.Path) -> int:
    job = json.loads(job_path.read_text(encoding="utf-8"))
    command = [
        "hermes",
        "--profile",
        "ian",
        "--skills",
        "ian-stock-analysis-workflow,notebooklm",
        "--oneshot",
        worker_prompt(job),
    ]
    try:
        result = subprocess.run(
            command,
            cwd=REPO,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=720,
            check=False,
            creationflags=hidden_creation_flags(),
        )
        if result.returncode != 0:
            fail_unfinished_job(
                job,
                f"Ian research process exited with code {result.returncode} before submission.",
            )
        else:
            fail_unfinished_job(
                job,
                "Ian research process ended without submitting a completed revision or an explicit failure.",
            )
        return result.returncode
    except subprocess.TimeoutExpired:
        fail_unfinished_job(job, "Ian research exceeded the 12-minute worker limit.")
        return 124
    except Exception as error:  # Keep a claimed job from becoming a silent lease.
        fail_unfinished_job(job, f"Ian research worker failed: {error}")
        return 1
    finally:
        job_path.unlink(missing_ok=True)
        clear_active_lock()


def launch_one_job() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if worker_is_active():
        return 0
    try:
        job = claim_one_job()
    except (OSError, RuntimeError, urllib.error.URLError, json.JSONDecodeError):
        return 1
    if not job:
        return 0

    claimed = job.get("job") or {}
    token = uuid.uuid4().hex
    job_path = STATE_DIR / f"job-{token}.json"
    log_path = LOG_DIR / f"{claimed.get('job_code', token)}.log"
    job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    command = [background_python(), str(pathlib.Path(__file__).resolve()), "--run-claimed-job", str(job_path)]
    try:
        with log_path.open("a", encoding="utf-8") as log:
            process = subprocess.Popen(
                command,
                cwd=REPO,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                close_fds=True,
                creationflags=hidden_creation_flags(),
            )
        ACTIVE_LOCK.write_text(
            json.dumps(
                {
                    "pid": process.pid,
                    "job_id": claimed.get("id"),
                    "job_code": claimed.get("job_code"),
                    "job_path": str(job_path),
                    "log_path": str(log_path),
                }
            ),
            encoding="utf-8",
        )
        return 0
    except Exception as error:
        job_path.unlink(missing_ok=True)
        fail_unfinished_job(job, f"Ian background worker could not start: {error}")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-claimed-job", type=pathlib.Path)
    args = parser.parse_args()
    if args.run_claimed_job:
        return run_claimed_job(args.run_claimed_job)
    return launch_one_job()


if __name__ == "__main__":
    raise SystemExit(main())
