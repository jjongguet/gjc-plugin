#!/usr/bin/env python3
"""jev-gate: bounded pre-delivery gate for Hermes cron output.

Python 3.9+ standard library only. The gate has three jobs:
1. deterministic detection of empty/abort/truncated cron output;
2. a strict, bounded JEV artifact check for allowlisted cron jobs;
3. metadata-only receipts, replacement notices, and a bounded retry request.

It never prints or stores the artifact text, the check question, the API key or
the provider rationale. It never reads ~/.hermes/.env or inherited API keys.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCHEMA_RECEIPT = "jev-gate.receipt.v1"
SCHEMA_STATE = "jev-gate.state.v1"
DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_MODEL = "typesafe/jev-1.13"
CHECK_CRITERIA = {
    "correct": "The artifact satisfies the stated check question",
    "incorrect": "The artifact does not satisfy the stated check question",
    "unsure": "The available information is insufficient to judge",
}
VERDICTS = {"correct", "incorrect", "unsure"}
NONTERMINAL = {"claimed", "running", "queued", "pending", "started", "in_progress", "dispatched"}
DEFAULT_ABORT_PATTERNS = [
    r"^\s*i stopped retrying\b",
    r"^\s*\[CRON_FAILURE\]",
    r"^\s*error:",
    r"^\s*traceback \(most recent call last\)",
    r"^\s*failed to produce\b",
    r"^\s*gave up\b",
]
DEFAULTS = {
    "mode": "off",
    "allowlist": [],
    "questions": {},
    "channels": {},
    "home_channel": "",
    "max_attempts": 3,
    "wall_clock_ms": 900000,
    "hold_confidence": 0.9,
    "max_artifact_chars": 4000,
    "timeout_ms": 8000,
    "abort_patterns": DEFAULT_ABORT_PATTERNS,
    "allow_force_fixture": False,
    "force_fixture": None,
    "alert_cooldown_ms": 3600000,
}


class GateError(Exception):
    pass


def _now() -> float:
    return time.time()


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canon(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _home() -> Path:
    return Path.home()


def data_root() -> Path:
    return Path(os.environ.get("JEV_GATE_DATA_ROOT") or (_home() / ".hermes" / "plugins" / "jev-gate-data"))


def default_config_path() -> Path:
    return Path(os.environ.get("JEV_GATE_CONFIG") or (data_root() / "config.json"))


def key_path() -> Path:
    return Path(os.environ.get("JEV_GATE_KEY_FILE") or (_home() / ".gjc" / "agent" / "jev-advisor" / ".env"))


def jobs_path() -> Path:
    return Path(os.environ.get("JEV_GATE_JOBS") or (_home() / ".hermes" / "cron" / "jobs.json"))


def executions_db() -> Path:
    return Path(os.environ.get("JEV_GATE_EXECUTIONS_DB") or (_home() / ".hermes" / "cron" / "executions.db"))


def hermes_bin() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    candidate = _home() / ".local" / "bin" / "hermes"
    return str(candidate) if candidate.exists() else "hermes"


# ---------------------------------------------------------------- configuration


def load_config(path=None) -> dict:
    p = Path(path) if path else default_config_path()
    raw = {}
    if p.exists():
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            raise GateError(f"config is not valid JSON: {exc}") from None
    if not isinstance(raw, dict):
        raise GateError("config must be a JSON object")
    cfg = dict(DEFAULTS)
    cfg.update(raw)
    if cfg["mode"] not in ("off", "dry_run", "hold"):
        raise GateError("mode must be off, dry_run or hold")
    if not isinstance(cfg["allowlist"], list) or any(not isinstance(x, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", x) for x in cfg["allowlist"]):
        raise GateError("allowlist must be a list of job ids")
    if not isinstance(cfg["questions"], dict) or any(not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in cfg["questions"].items()):
        raise GateError("questions must map job ids to non-empty strings")
    if not isinstance(cfg["channels"], dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in cfg["channels"].items()):
        raise GateError("channels must map job ids to Discord channel ids")
    for key in ("max_attempts", "wall_clock_ms", "max_artifact_chars", "timeout_ms", "alert_cooldown_ms"):
        if not isinstance(cfg[key], int) or cfg[key] < 1:
            raise GateError(f"{key} must be a positive integer")
    if not isinstance(cfg["hold_confidence"], (int, float)) or not (0 <= cfg["hold_confidence"] <= 1):
        raise GateError("hold_confidence must be between 0 and 1")
    if not isinstance(cfg["abort_patterns"], list) or any(not isinstance(x, str) for x in cfg["abort_patterns"]):
        raise GateError("abort_patterns must be a list of strings")
    for pattern in cfg["abort_patterns"]:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise GateError(f"invalid abort pattern: {exc}") from None
    if not isinstance(cfg["allow_force_fixture"], bool):
        raise GateError("allow_force_fixture must be a boolean")
    forced = cfg.get("force_fixture")
    if forced is not None:
        if not isinstance(forced, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", forced):
            raise GateError("force_fixture must be a fixture name")
        if not cfg["allow_force_fixture"]:
            raise GateError("force_fixture requires allow_force_fixture=true")
    for job_id in cfg["allowlist"]:
        if job_id not in cfg["questions"]:
            raise GateError(f"missing question for allowlisted job {job_id}")
    cfg["_digest"] = hashlib.sha256(_canon(raw).encode("utf-8")).hexdigest()
    return cfg


def read_api_key(path=None):
    """Read the JEV key only from the dedicated .env file.

    Returns (key, source) or (None, None). Never consults os.environ.
    """
    p = Path(path) if path else key_path()
    values = {}
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            name = name.strip()
            if name in ("JEV_ADVISOR_API_KEY", "OPENROUTER_API_KEY"):
                values[name] = value.strip().strip('"').strip("'")
    except OSError:
        return None, None
    for name in ("JEV_ADVISOR_API_KEY", "OPENROUTER_API_KEY"):
        if values.get(name):
            return values[name], name
    return None, None


# ----------------------------------------------------------------- detection


def deterministic_hold(text: str, cfg: dict):
    """Return a reason string when the artifact must be held, else None."""
    if not isinstance(text, str) or not text.strip():
        return "empty_or_whitespace"
    stripped = text.strip()
    if stripped.upper() == "[SILENT]" or stripped.upper().startswith("[SILENT]\n"):
        return None
    first = stripped.splitlines()[0].strip()
    for pattern in cfg.get("abort_patterns") or []:
        try:
            if re.search(pattern, first, re.IGNORECASE):
                return "abort_pattern"
        except re.error:
            continue
    if len(stripped) <= 300:
        if re.search(r"(?i)i stopped retrying because|kept running .{0,80} without making progress|stopped retrying because", stripped):
            return "short_abort_text"
        if re.search(r"(?i)\b(truncated|cut off)\b", stripped) and stripped.endswith(("…", "...")):
            return "short_truncation"
    return None


# ------------------------------------------------------------------- checking


def _normalize_field(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def compose_check_prompt(question: str, artifact: str) -> str:
    return f"check question:\n{question}\n\nartifact:\n{artifact}"


def prepare_check(question, artifact, limit: int) -> dict:
    if not isinstance(question, str) or not isinstance(artifact, str):
        return {"status": "invalid_task"}
    normalized_question = _normalize_field(question)
    normalized_artifact = _normalize_field(artifact)
    if not normalized_question or not normalized_artifact:
        return {"status": "invalid_task"}
    prompt = compose_check_prompt(normalized_question, normalized_artifact)
    if len(prompt) > limit:
        return {"status": "input_too_large", "chars": len(prompt)}
    return {"status": "ok", "question": normalized_question, "artifact": normalized_artifact, "chars": len(prompt)}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _parse_check_response(raw: bytes) -> dict:
    if len(raw) > 65536:
        return {"status": "no_decision", "reason": "invalid_response"}
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"status": "no_decision", "reason": "invalid_response"}
    answers = data.get("answers") if isinstance(data, dict) else None
    answer = answers.get("check") if isinstance(answers, dict) else None
    if not isinstance(answer, dict):
        return {"status": "no_decision", "reason": "invalid_response"}
    choice = answer.get("choice")
    confidence = answer.get("confidence")
    if choice not in VERDICTS or not isinstance(confidence, (int, float)) or not (0 <= confidence <= 1):
        return {"status": "no_decision", "reason": "invalid_response"}
    probabilities = answer.get("probabilities")
    if probabilities is not None:
        if not isinstance(probabilities, dict) or set(probabilities) != VERDICTS:
            return {"status": "no_decision", "reason": "invalid_response"}
        values = list(probabilities.values())
        if any(not isinstance(v, (int, float)) or not (0 <= v <= 1) for v in values):
            return {"status": "no_decision", "reason": "invalid_response"}
        if abs(sum(values) - 1.0) > 0.001:
            return {"status": "no_decision", "reason": "invalid_response"}
    return {"status": "decision", "verdict": choice, "confidence": float(confidence), "probabilities": probabilities}


def request_check(question: str, artifact: str, cfg: dict, key: str, timeout_s=None) -> dict:
    prepared = prepare_check(question, artifact, cfg["max_artifact_chars"])
    if prepared["status"] != "ok":
        return {"status": "no_decision", "reason": prepared["status"], "chars": prepared.get("chars")}
    body = json.dumps(
        {
            "model": DEFAULT_MODEL,
            "state": prepared["artifact"],
            "questions": {
                "check": {
                    "type": "choice",
                    "instructions": prepared["question"],
                    "criteria": CHECK_CRITERIA,
                }
            },
        },
        ensure_ascii=False,
    ).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
        "HTTP-Referer": "https://github.com/jjongguet/gjc-plugin",
        "X-Title": "jev-gate",
    }
    request = urllib.request.Request(DEFAULT_ENDPOINT, data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(_NoRedirect())
    timeout_s = timeout_s if timeout_s is not None else cfg["timeout_ms"] / 1000.0
    try:
        with opener.open(request, timeout=timeout_s) as response:
            raw = response.read(65537)
    except urllib.error.HTTPError as exc:
        return {"status": "no_decision", "reason": "provider_error", "http_status": exc.code}
    except (urllib.error.URLError, TimeoutError, OSError):
        return {"status": "no_decision", "reason": "timeout_or_transport"}
    return _parse_check_response(raw)


# --------------------------------------------------------------------- state


def _profile_of(execution) -> str:
    profile = getattr(execution, "profile", None) or "default"
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(profile))[:64] or "default"


def _paths(profile: str):
    base = data_root() / profile
    return base, base / "state.json", base / "state.lock", base / "receipts"


def _ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _acquire(lock_path: Path, wait_ms: int = 1000):
    _ensure_dir(lock_path.parent)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + wait_ms / 1000.0
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.05)


def _release(fd):
    if fd is not None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "jobs": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        raise GateError("state is corrupt")
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("jobs"), dict):
        raise GateError("state is corrupt")
    return data


def save_state(path: Path, state: dict):
    _ensure_dir(path.parent)
    temp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
    try:
        dir_fd = os.open(path.parent, os.O_RDONLY)
        os.fsync(dir_fd)
        os.close(dir_fd)
    except OSError:
        pass


def append_receipt(profile: str, job_id: str, receipt: dict):
    base, _, _, receipts = _paths(profile)
    _ensure_dir(receipts)
    path = receipts / f"{job_id}.jsonl"
    line = json.dumps(receipt, ensure_ascii=False, sort_keys=True)
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) > 64:
            path.write_text("\n".join(lines[-64:]) + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
    except OSError:
        pass


def marker_path(profile: str, job_id: str) -> Path:
    base, _, _, _ = _paths(profile)
    return base / f"pending_{job_id}.json"


def _write_marker(profile: str, job_id: str, enqueue_key: str):
    base, _, _, _ = _paths(profile)
    _ensure_dir(base)
    path = marker_path(profile, job_id)
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"job_id": job_id, "enqueue_key": enqueue_key, "at": _now()}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def _read_marker(profile: str, job_id: str):
    path = marker_path(profile, job_id)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _clear_marker(profile: str, job_id: str):
    try:
        marker_path(profile, job_id).unlink()
    except OSError:
        pass


# -------------------------------------------------------------------- notices


def _notice(job_name: str, job_id: str, attempt: int, max_attempts: int, stage: str, reason: str, sha: str, chars: int, exhausted: bool = False, retry_requested: bool = True) -> str:
    state = "exhausted" if exhausted else "held"
    if exhausted:
        tail = "Retry budget exhausted; no replacement was sent."
    elif retry_requested:
        tail = "A replacement generation was requested."
    else:
        tail = "No replacement was requested for this manual run."
    return (
        f"JEV gate {state} this cron output: job={job_name} ({job_id}), attempt={attempt}/{max_attempts}, "
        f"stage={stage}, reason={reason}, artifact_sha={sha[:12]}, chars={chars}. "
        f"The original was not delivered. {tail}"
    )


def _send_home_alert(text: str, cfg: dict):
    channel = str(cfg.get("home_channel") or "").strip()
    if not channel:
        return "no_channel"
    try:
        proc = subprocess.run(
            [hermes_bin(), "send", "--to", f"discord:{channel}", "-f", "-"],
            input=text,
            text=True,
            timeout=20,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return "sent" if proc.returncode == 0 else "failed"
    except Exception:
        return "failed"


def _spawn_retry_helper(execution, profile: str, config_path: Path):
    try:
        subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--retry-helper",
                "--job-id",
                str(getattr(execution, "job_id", "")),
                "--execution-id",
                str(getattr(execution, "execution_id", "")),
                "--profile",
                profile,
                "--config",
                str(config_path),
            ],
            start_new_session=True,
            close_fds=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return "spawned"
    except Exception:
        return "spawn_failed"


# ------------------------------------------------------------------ decision


def _evaluate(job_id: str, text: str, cfg: dict, check_fn=None) -> dict:
    artifact_sha = _sha(text)
    chars = len(text)
    reason = deterministic_hold(text, cfg)
    if reason:
        return {"decision": "hold", "stage": "deterministic", "reason": reason, "artifact_sha": artifact_sha, "artifact_chars": chars, "check_status": "not_run"}
    question = cfg["questions"].get(job_id)
    if not question:
        return {"decision": "allow", "stage": "none", "reason": "missing_question", "artifact_sha": artifact_sha, "artifact_chars": chars, "check_status": "not_run", "gate_alert": True}
    key, key_source = read_api_key()
    if not key:
        return {"decision": "allow", "stage": "none", "reason": "unconfigured", "artifact_sha": artifact_sha, "artifact_chars": chars, "check_status": "not_run", "key_source": None, "gate_alert": True}
    if check_fn is not None:
        result = check_fn(question, text, cfg, key)
    else:
        result = request_check(question, text, cfg, key)
    if result.get("status") == "decision":
        verdict = result["verdict"]
        confidence = result["confidence"]
        hold = verdict == "incorrect" and confidence >= cfg["hold_confidence"]
        return {
            "decision": "hold" if hold else "allow",
            "stage": "jev_check",
            "reason": f"verdict_{verdict}",
            "artifact_sha": artifact_sha,
            "artifact_chars": chars,
            "check_status": "decision",
            "verdict": verdict,
            "confidence": confidence,
            "key_source": key_source,
            "question_sha": _sha(question),
            "composed_chars": result.get("chars"),
        }
    return {
        "decision": "allow",
        "stage": "jev_check",
        "reason": result.get("reason") or "no_decision",
        "artifact_sha": artifact_sha,
        "artifact_chars": chars,
        "check_status": result.get("reason") or "no_decision",
        "key_source": key_source,
        "gate_alert": result.get("reason") in ("timeout_or_transport", "provider_error", "invalid_response"),
        "http_status": result.get("http_status"),
    }


# ------------------------------------------------------------------- handle


def handle_turn(text: str, execution, config_path=None, now=None, check_fn=None) -> str | None:
    """Evaluate one cron turn and return None or a replacement notice."""
    config_path = Path(config_path) if config_path else default_config_path()
    cfg = load_config(config_path)
    job_id = str(getattr(execution, "job_id", "") or "")
    job_name = str(getattr(execution, "job_name", job_id) or job_id)
    profile = _profile_of(execution)
    if cfg["mode"] == "off" or job_id not in cfg["allowlist"]:
        return None
    now = now if now is not None else _now()
    forced_fixture = None
    forced = cfg.get("force_fixture")
    if forced:
        fixture = Path(__file__).resolve().parent / "fixtures" / "precision" / "bad" / f"{forced}.txt"
        if not fixture.exists():
            raise GateError(f"force_fixture not found: {forced}")
        text = fixture.read_text(encoding="utf-8")
        forced_fixture = forced
    base, state_path, lock_path, _ = _paths(profile)
    _ensure_dir(base)

    lock_fd = _acquire(lock_path)
    if lock_fd is None:
        decision = _evaluate(job_id, text, cfg, check_fn)
        if decision["decision"] == "hold":
            alert_type, alert_target, alert_delivery = "job_notice", cfg["channels"].get(job_id), "replacement"
        elif decision.get("gate_alert"):
            alert_type, alert_target = "home", str(cfg.get("home_channel") or "")
            alert_delivery = _send_home_alert(_notice(job_name, job_id, 0, cfg["max_attempts"], decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], exhausted=True), cfg)
        else:
            alert_type = alert_target = alert_delivery = None
        receipt = _receipt(cfg, execution, decision, attempt=0, max_attempts=cfg["max_attempts"], run_group_id="", stage=decision["stage"], lock_status="unavailable", alert_type=alert_type, alert_target=alert_target, alert_delivery=alert_delivery)
        append_receipt(profile, job_id, receipt)
        if decision["decision"] == "hold":
            return _notice(job_name, job_id, 0, cfg["max_attempts"], decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], retry_requested=False)
        return None

    try:
        state = load_state(state_path)
        jobs = state.setdefault("jobs", {})
        rec = jobs.get(job_id)
        source = str(getattr(execution, "source", "") or "")
        scheduled = getattr(execution, "scheduled_instant", None)
        execution_id = str(getattr(execution, "execution_id", "") or "")
        started_at = getattr(execution, "started_at", None)
        manual = False
        joined = False
        manual_rec = None

        if source == "direct":
            marker = _read_marker(profile, job_id)
            if rec and rec.get("status") == "retrying" and marker and rec.get("enqueue_key") and marker.get("enqueue_key") == rec.get("enqueue_key"):
                joined = True
            else:
                manual = True
                manual_rec = {
                    "job_id": job_id,
                    "job_name": job_name,
                    "run_group_id": hashlib.sha256(f"{job_id}|manual|{execution_id}|{now}".encode("utf-8")).hexdigest()[:12],
                    "attempt": 1,
                    "max_attempts": cfg["max_attempts"],
                    "first_at": now,
                    "deadline_at": now + cfg["wall_clock_ms"] / 1000.0,
                    "status": "manual",
                    "pending_retry_at": None,
                    "last_execution_id": execution_id,
                    "last_source": source,
                    "last_scheduled_instant": scheduled,
                    "join_misses": 0,
                    "last_receipt_id": None,
                    "enqueue_key": None,
                    "manual": True,
                }
        else:
            if rec and rec.get("status") == "retrying":
                rec["status"] = "superseded"
            rec = {
                "job_id": job_id,
                "job_name": job_name,
                "run_group_id": hashlib.sha256(f"{job_id}|{scheduled}|{execution_id}|{now}".encode("utf-8")).hexdigest()[:12],
                "attempt": 1,
                "max_attempts": cfg["max_attempts"],
                "first_at": now,
                "deadline_at": now + cfg["wall_clock_ms"] / 1000.0,
                "status": "evaluating",
                "pending_retry_at": None,
                "last_execution_id": execution_id,
                "last_source": source,
                "last_scheduled_instant": scheduled,
                "join_misses": 0,
                "last_receipt_id": None,
                "enqueue_key": None,
                "manual": False,
            }
        if joined and started_at and rec.get("pending_retry_at") and str(started_at) < str(rec["pending_retry_at"]):
            manual = True
            joined = False
            manual_rec = {
                "job_id": job_id,
                "job_name": job_name,
                "run_group_id": hashlib.sha256(f"{job_id}|manual|{execution_id}|{now}".encode("utf-8")).hexdigest()[:12],
                "attempt": 1,
                "max_attempts": cfg["max_attempts"],
                "first_at": now,
                "deadline_at": now + cfg["wall_clock_ms"] / 1000.0,
                "status": "manual",
                "pending_retry_at": None,
                "last_execution_id": execution_id,
                "last_source": source,
                "last_scheduled_instant": scheduled,
                "join_misses": 0,
                "last_receipt_id": None,
                "enqueue_key": None,
                "manual": True,
            }
        if manual:
            if rec:
                rec["last_manual_execution_id"] = execution_id
                rec["last_manual_at"] = now
                jobs[job_id] = rec
            else:
                jobs[job_id] = manual_rec
        else:
            jobs[job_id] = rec
        save_state(state_path, state)
    finally:
        _release(lock_fd)

    decision = _evaluate(job_id, text, cfg, check_fn)

    lock_fd = _acquire(lock_path)
    if lock_fd is None:
        if decision["decision"] == "hold":
            alert_type, alert_target, alert_delivery = "job_notice", cfg["channels"].get(job_id), "replacement"
        elif decision.get("gate_alert"):
            alert_type, alert_target = "home", str(cfg.get("home_channel") or "")
            alert_delivery = _send_home_alert(_notice(job_name, job_id, 0, cfg["max_attempts"], decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], exhausted=True), cfg)
        else:
            alert_type = alert_target = alert_delivery = None
        receipt = _receipt(cfg, execution, decision, attempt=0, max_attempts=cfg["max_attempts"], run_group_id="", stage=decision["stage"], lock_status="unavailable", alert_type=alert_type, alert_target=alert_target, alert_delivery=alert_delivery)
        append_receipt(profile, job_id, receipt)
        if decision["decision"] == "hold":
            return _notice(job_name, job_id, 0, cfg["max_attempts"], decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], retry_requested=False)
        return None
    try:
        state = load_state(state_path)
        pending = state.setdefault("jobs", {}).get(job_id)
        if manual:
            rec = dict(manual_rec or {})
            attempt = 1
            max_attempts = int(rec.get("max_attempts") or cfg["max_attempts"])
            deadline = float(rec.get("deadline_at") or (now + cfg["wall_clock_ms"] / 1000.0))
        else:
            rec = pending or {}
            state["jobs"][job_id] = rec
            attempt = int(rec.get("attempt") or 1)
            max_attempts = int(rec.get("max_attempts") or cfg["max_attempts"])
            deadline = float(rec.get("deadline_at") or (now + cfg["wall_clock_ms"] / 1000.0))
        hold = decision["decision"] == "hold"
        exhausted = False
        enqueue_status = "not_requested"

        if cfg["mode"] == "dry_run":
            if manual:
                rec["status"] = "manual_dry_run"
                if pending:
                    pending["last_manual_at"] = now
                else:
                    state["jobs"][job_id] = rec
            else:
                rec["status"] = "dry_run"
                rec["last_receipt_id"] = None
            enqueue_status = "dry_run"
            replacement = None
        elif hold:
            if manual:
                replacement = _notice(job_name, job_id, attempt, max_attempts, decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], retry_requested=False)
                if pending:
                    pending["last_manual_at"] = now
                else:
                    rec["status"] = "manual_hold"
                    state["jobs"][job_id] = rec
            elif attempt >= max_attempts or now >= deadline:
                rec["status"] = "exhausted"
                rec["pending_retry_at"] = None
                rec["enqueue_key"] = None
                exhausted = True
                replacement = _notice(job_name, job_id, attempt, max_attempts, decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], exhausted=True)
            else:
                attempt += 1
                rec["attempt"] = attempt
                rec["status"] = "retrying"
                rec["pending_retry_at"] = now
                rec["enqueue_key"] = hashlib.sha256(f"{job_id}|{attempt}|{now}".encode("utf-8")).hexdigest()[:16]
                _write_marker(profile, job_id, rec["enqueue_key"])
                enqueue_status = _spawn_retry_helper(execution, profile, config_path)
                replacement = _notice(job_name, job_id, attempt, max_attempts, decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"])
        else:
            if manual:
                replacement = None
                if pending:
                    pending["last_manual_at"] = now
                else:
                    rec["status"] = "manual_approved"
                    state["jobs"][job_id] = rec
            else:
                rec["status"] = "approved"
                rec["pending_retry_at"] = None
                rec["enqueue_key"] = None
                _clear_marker(profile, job_id)
                replacement = None

        if not manual:
            rec["last_execution_id"] = str(getattr(execution, "execution_id", "") or "")
            rec["last_source"] = str(getattr(execution, "source", "") or "")
            rec["last_scheduled_instant"] = getattr(execution, "scheduled_instant", None)
            state["jobs"][job_id] = rec
        save_state(state_path, state)
    finally:
        _release(lock_fd)

    if hold:
        alert_type, alert_target, alert_delivery = "job_notice", cfg["channels"].get(job_id), "replacement"
    elif decision.get("gate_alert"):
        alert_type, alert_target = "home", str(cfg.get("home_channel") or "")
        alert_delivery = _send_home_alert(_notice(job_name, job_id, attempt, max_attempts, decision["stage"], decision["reason"], decision["artifact_sha"], decision["artifact_chars"], exhausted=True), cfg)
    else:
        alert_type = alert_target = alert_delivery = None
    receipt = _receipt(
        cfg,
        execution,
        decision,
        attempt=attempt,
        max_attempts=max_attempts,
        run_group_id=str(rec.get("run_group_id") or ""),
        stage=decision["stage"],
        join_status="joined" if joined else ("manual" if manual else "new"),
        enqueue_status=enqueue_status,
        exhausted=exhausted,
        lock_status="ok",
        forced_fixture=forced_fixture,
        alert_type=alert_type,
        alert_target=alert_target,
        alert_delivery=alert_delivery,
    )
    append_receipt(profile, job_id, receipt)
    return replacement


def _receipt(cfg, execution, decision, *, attempt, max_attempts, run_group_id, stage, join_status="new", enqueue_status="not_requested", exhausted=False, lock_status="ok", forced_fixture=None, alert_type=None, alert_target=None, alert_delivery=None):
    return {
        "schema": SCHEMA_RECEIPT,
        "observed_at": _now(),
        "gate_version": "0.1.0",
        "config_digest": cfg.get("_digest"),
        "job_id": str(getattr(execution, "job_id", "") or ""),
        "job_name": str(getattr(execution, "job_name", "") or ""),
        "profile": _profile_of(execution),
        "execution_id": str(getattr(execution, "execution_id", "") or ""),
        "source": str(getattr(execution, "source", "") or ""),
        "scheduled_instant": getattr(execution, "scheduled_instant", None),
        "run_group_id": run_group_id,
        "attempt": attempt,
        "max_attempts": max_attempts,
        "stage": stage,
        "decision": "exhausted" if exhausted else decision["decision"],
        "check_status": decision.get("check_status"),
        "verdict": decision.get("verdict"),
        "confidence": decision.get("confidence"),
        "reason": decision.get("reason"),
        "question_sha256": decision.get("question_sha"),
        "composed_prompt_chars": decision.get("composed_chars"),
        "artifact_sha256": decision.get("artifact_sha"),
        "artifact_chars": decision.get("artifact_chars"),
        "key_source": decision.get("key_source"),
        "provider": "openrouter",
        "model": DEFAULT_MODEL,
        "join_status": join_status,
        "enqueue_status": enqueue_status,
        "lock_status": lock_status,
        "gate_alert": bool(decision.get("gate_alert")),
        "alert_type": alert_type,
        "alert_target": alert_target,
        "alert_delivery": alert_delivery,
        "http_status": decision.get("http_status"),
        "forced_fixture": forced_fixture,
    }


# ------------------------------------------------------------- retry helper


def _execution_status(execution_id: str):
    try:
        con = sqlite3.connect(f"file:{executions_db()}?mode=ro", uri=True, timeout=2)
        row = con.execute("select status from executions where id=?", (execution_id,)).fetchone()
        con.close()
        return row[0] if row else None
    except Exception:
        return None


def retry_helper(job_id: str, execution_id: str, profile: str, config_path: Path) -> int:
    cfg = load_config(config_path)
    deadline = time.monotonic() + 60
    terminal = False
    while time.monotonic() < deadline:
        status = _execution_status(execution_id)
        if status is None:
            break
        if status not in NONTERMINAL:
            terminal = True
            break
        time.sleep(0.5)
    if not terminal:
        append_receipt(profile, job_id, {
            "schema": SCHEMA_RECEIPT,
            "observed_at": _now(),
            "gate_version": "0.1.0",
            "config_digest": cfg.get("_digest"),
            "job_id": job_id,
            "execution_id": execution_id,
            "stage": "retry_helper",
            "decision": "hold",
            "reason": "terminal_unavailable",
            "enqueue_status": "skipped",
            "lock_status": "ok",
        })
        return 0
    base, state_path, lock_path, _ = _paths(profile)
    lock_fd = _acquire(lock_path)
    enqueue_key = None
    if lock_fd is not None:
        try:
            state = load_state(state_path)
            rec = state.get("jobs", {}).get(job_id) or {}
            enqueue_key = rec.get("enqueue_key")
        finally:
            _release(lock_fd)
    status = "skipped"
    if enqueue_key:
        _write_marker(profile, job_id, enqueue_key)
        # `hermes cron run` owns the replacement execution for the whole agent
        # turn (minutes on this host). Waiting on it with a timeout kills that
        # owner mid-run and orphans the execution, so trigger the run detached
        # and let the continuation marker track the retry instead.
        try:
            subprocess.Popen(
                [hermes_bin(), "cron", "run", job_id],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
            )
            status = "spawned"
        except Exception:
            status = "spawn_failed"
    append_receipt(profile, job_id, {
        "schema": SCHEMA_RECEIPT,
        "observed_at": _now(),
        "gate_version": "0.1.0",
        "config_digest": cfg.get("_digest"),
        "job_id": job_id,
        "execution_id": execution_id,
        "stage": "retry_helper",
        "decision": "hold",
        "reason": "replacement_requested",
        "enqueue_status": status,
        "lock_status": "ok",
    })
    return 0


# --------------------------------------------------------------- self-test


def _read_fixture_dir(path: Path):
    # macOS tar can add AppleDouble ._* siblings; they are not fixtures.
    return sorted(p for p in path.glob("*.txt") if p.is_file() and not p.name.startswith("._"))


def self_test(config_path=None) -> int:
    cfg = load_config(config_path) if config_path else dict(DEFAULTS)
    cfg.setdefault("allowlist", [])
    root = Path(__file__).resolve().parent / "fixtures"
    bad = _read_fixture_dir(root / "precision" / "bad")
    good = _read_fixture_dir(root / "precision" / "good")
    false_holds = 0
    held_bad = 0
    for path in bad:
        if deterministic_hold(path.read_text(encoding="utf-8"), cfg):
            held_bad += 1
    for path in good:
        if deterministic_hold(path.read_text(encoding="utf-8"), cfg):
            false_holds += 1
    print(json.dumps({
        "status": "ok" if false_holds == 0 and held_bad >= 9 and len(bad) == 10 and len(good) == 10 else "failed",
        "bad": len(bad),
        "good": len(good),
        "held_bad": held_bad,
        "false_holds": false_holds,
        "no_network": True,
        "no_send": True,
    }, ensure_ascii=False, sort_keys=True))
    return 0 if false_holds == 0 and held_bad >= 9 and len(bad) == 10 and len(good) == 10 else 1


def config_check(config_path=None) -> int:
    cfg = load_config(config_path)
    jobs = _load_jobs()
    job_map = {}
    for job_id, job in jobs.items():
        job_map[job_id] = {
            "name": job.get("name"),
            "no_agent": bool(job.get("no_agent")),
            "script": job.get("script"),
            "enabled": bool(job.get("enabled")),
            "deliver": job.get("deliver"),
            "gated": job_id in cfg["allowlist"],
            "question": job_id in cfg["questions"],
        }
    print(json.dumps({"mode": cfg["mode"], "allowlist": cfg["allowlist"], "jobs": job_map, "digest": cfg["_digest"]}, ensure_ascii=False, sort_keys=True))
    return 0


def _load_jobs():
    try:
        data = json.loads(jobs_path().read_text(encoding="utf-8"))
    except Exception:
        return {}
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    return {str(j.get("id")): j for j in jobs if isinstance(j, dict) and j.get("id")}


def print_job_map(config_path=None) -> int:
    cfg = load_config(config_path) if config_path else dict(DEFAULTS)
    jobs = _load_jobs()
    rows = []
    for job_id, job in sorted(jobs.items()):
        rows.append({
            "id": job_id,
            "name": job.get("name"),
            "no_agent": bool(job.get("no_agent")),
            "script": job.get("script"),
            "enabled": bool(job.get("enabled")),
            "deliver": job.get("deliver"),
            "gated": job_id in (cfg.get("allowlist") or []),
        })
    print(json.dumps(rows, ensure_ascii=False, sort_keys=True))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="jev-gate: bounded Hermes cron pre-delivery gate")
    parser.add_argument("--config", default=None)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--config-check", action="store_true")
    parser.add_argument("--print-job-map", action="store_true")
    parser.add_argument("--retry-helper", action="store_true")
    parser.add_argument("--job-id", default="")
    parser.add_argument("--execution-id", default="")
    parser.add_argument("--profile", default="default")
    args = parser.parse_args(argv)
    if args.retry_helper:
        return retry_helper(args.job_id, args.execution_id, args.profile, Path(args.config) if args.config else default_config_path())
    if args.self_test:
        return self_test(args.config)
    if args.config_check:
        return config_check(args.config)
    if args.print_job_map:
        return print_job_map(args.config)
    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GateError as exc:
        print(json.dumps({"status": "error", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
