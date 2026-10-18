"""Hermes plugin entry point for jev-gate.

The plugin registers one transform_llm_output hook. Hermes v2026.9.24 builds
cron agent sessions as ``cron_<job_id>_<YYYYMMDD_HHMMSS>`` and does not expose a
``ctx.current_cron_execution()`` helper, so the hook derives the job execution
from the session id. It returns None (deliver the original) or a metadata-only
replacement notice. See gate.py for the policy and state.
"""
from __future__ import annotations

import re
import sqlite3
import sys
import types
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import gate  # noqa: E402

_CRON_SESSION = re.compile(r"^cron_([0-9a-f]{6,})_(\d{8}_\d{6})$")


def _execution_for(ctx, session_id):
    match = _CRON_SESSION.match(str(session_id or ""))
    if not match:
        return None
    job_id, stamp = match.group(1), match.group(2)
    execution_id = f"{job_id}-{stamp}"
    try:
        db = Path.home() / ".hermes" / "cron" / "executions.db"
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute(
                "select id from executions where job_id=? order by claimed_at desc limit 1",
                (job_id,),
            ).fetchone()
        finally:
            con.close()
        if row and row[0]:
            execution_id = str(row[0])
    except Exception:
        pass
    return types.SimpleNamespace(
        job_id=job_id,
        job_name=job_id,
        profile=ctx.profile_name,
        source="builtin",
        execution_id=execution_id,
        scheduled_instant=stamp,
        started_at=stamp,
    )


def register(ctx):
    def transform_llm_output(response_text=None, session_id=None, model=None, platform=None, turn_id=None, **kwargs):
        execution = _execution_for(ctx, session_id)
        if execution is None:
            return None
        try:
            return gate.handle_turn(response_text or "", execution)
        except Exception:
            # The gate is advisory and must never break delivery.
            return None

    ctx.register_hook("transform_llm_output", transform_llm_output)
