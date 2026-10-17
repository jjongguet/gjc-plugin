"""Hermes plugin entry point for jev-gate.

The plugin registers one transform_llm_output hook. The hook only acts inside a
cron execution (ctx.current_cron_execution() is not None) and only for jobs in
the configured allowlist. It returns None (deliver the original) or a
metadata-only replacement notice. See gate.py for the policy and state.
"""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import gate  # noqa: E402


def register(ctx):
    def transform_llm_output(response_text=None, session_id=None, model=None, platform=None, turn_id=None, **kwargs):
        try:
            execution = ctx.current_cron_execution()
        except Exception:
            execution = None
        if execution is None:
            return None
        try:
            return gate.handle_turn(response_text or "", execution)
        except Exception:
            # The gate is advisory and must never break delivery.
            return None

    ctx.register_hook("transform_llm_output", transform_llm_output)
