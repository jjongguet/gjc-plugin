"""Unit tests for jev-gate. Standard library only; no network, no real send."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import gate  # noqa: E402

ABORT = "I stopped retrying because I kept running terminal 5 times without making progress. The last result above shows what blocked it. Tell me how you'd like to proceed, or send `continue` and I'll try a different approach."
GOOD = "# Digest\n\n- 2026-10-17 item A https://example.com/a\n- 2026-10-16 item B https://example.com/b\n- 2026-10-15 item C https://example.com/c\n"


def execution(source="builtin", execution_id="exec-1", started_at="2026-10-17T08:00:00+09:00"):
    return SimpleNamespace(
        job_id="job1",
        job_name="Job One",
        execution_id=execution_id,
        source=source,
        scheduled_instant="2026-10-17T08:00:00+09:00" if source == "builtin" else None,
        started_at=started_at,
        profile="default",
    )


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.config = self.root / "config.json"
        self.keyfile = self.root / "key.env"
        self.jobs = self.root / "jobs.json"
        self.execdb = self.root / "executions.db"
        os.environ["JEV_GATE_DATA_ROOT"] = str(self.data)
        os.environ["JEV_GATE_CONFIG"] = str(self.config)
        os.environ["JEV_GATE_KEY_FILE"] = str(self.keyfile)
        os.environ["JEV_GATE_JOBS"] = str(self.jobs)
        os.environ["JEV_GATE_EXECUTIONS_DB"] = str(self.execdb)
        self.keyfile.write_text("JEV_ADVISOR_API_KEY=test-key\n", encoding="utf-8")
        self.jobs.write_text(json.dumps({"jobs": [{"id": "job1", "name": "Job One", "no_agent": False, "enabled": True, "deliver": "discord:1"}]}), encoding="utf-8")
        self.write_config()
        self.spawned = []
        self.alerts = []
        self._orig_spawn = gate._spawn_retry_helper
        self._orig_alert = gate._send_home_alert
        gate._spawn_retry_helper = lambda *args: (self.spawned.append(args), "spawned")[1]
        gate._send_home_alert = lambda text, cfg: (self.alerts.append(text), "sent")[1]

    def tearDown(self):
        gate._spawn_retry_helper = self._orig_spawn
        gate._send_home_alert = self._orig_alert
        for name in ("JEV_GATE_DATA_ROOT", "JEV_GATE_CONFIG", "JEV_GATE_KEY_FILE", "JEV_GATE_JOBS", "JEV_GATE_EXECUTIONS_DB"):
            os.environ.pop(name, None)
        self.temp.cleanup()

    def write_config(self, **overrides):
        cfg = {
            "mode": "hold",
            "allowlist": ["job1"],
            "questions": {"job1": "Does the artifact contain three dated items with links?"},
            "channels": {"job1": "1557970957585481838"},
            "home_channel": "1557381856909988001",
            "max_attempts": 3,
            "wall_clock_ms": 900000,
            "hold_confidence": 0.9,
            "max_artifact_chars": 4000,
            "timeout_ms": 1000,
            "abort_patterns": gate.DEFAULT_ABORT_PATTERNS,
            "allow_force_fixture": False,
            "alert_cooldown_ms": 3600000,
        }
        cfg.update(overrides)
        self.config.write_text(json.dumps(cfg), encoding="utf-8")

    def test_deterministic_bad_and_good_fixtures(self):
        cfg = dict(gate.DEFAULTS)
        for path in sorted((HERE / "fixtures" / "precision" / "bad").glob("*.txt")):
            self.assertIsNotNone(gate.deterministic_hold(path.read_text(encoding="utf-8"), cfg), path.name)
        for path in sorted((HERE / "fixtures" / "precision" / "good").glob("*.txt")):
            self.assertIsNone(gate.deterministic_hold(path.read_text(encoding="utf-8"), cfg), path.name)

    def test_prepare_check_normalization_and_oversize(self):
        ok = gate.prepare_check("  question  ", "  artifact  ", 4000)
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["question"], "question")
        self.assertEqual(ok["artifact"], "artifact")
        big = gate.prepare_check("q", "x" * 4001, 4000)
        self.assertEqual(big["status"], "input_too_large")
        self.assertEqual(gate.prepare_check("", "a", 4000)["status"], "invalid_task")

    def test_parse_check_response(self):
        good = json.dumps({"answers": {"check": {"choice": "correct", "confidence": 0.8, "probabilities": {"correct": 0.8, "incorrect": 0.1, "unsure": 0.1}}}}).encode()
        parsed = gate._parse_check_response(good)
        self.assertEqual(parsed["status"], "decision")
        self.assertEqual(parsed["verdict"], "correct")
        bad = json.dumps({"answers": {"check": {"choice": "correct", "confidence": 2}}}).encode()
        self.assertEqual(gate._parse_check_response(bad)["status"], "no_decision")
        bad_sum = json.dumps({"answers": {"check": {"choice": "correct", "confidence": 0.5, "probabilities": {"correct": 0.5, "incorrect": 0.5, "unsure": 1.0}}}}).encode()
        self.assertEqual(gate._parse_check_response(bad_sum)["reason"], "invalid_response")

    def test_config_validation(self):
        self.write_config(mode="hold")
        self.assertEqual(gate.load_config(self.config)["mode"], "hold")
        self.write_config(mode="hold", allowlist=["missing"])
        with self.assertRaises(gate.GateError):
            gate.load_config(self.config)
        self.write_config(mode="bogus")
        with self.assertRaises(gate.GateError):
            gate.load_config(self.config)

    def test_hold_returns_notice_without_artifact_and_requests_retry(self):
        notice = gate.handle_turn(ABORT, execution(), config_path=self.config)
        self.assertIsNotNone(notice)
        self.assertIn("JEV gate held", notice)
        self.assertNotIn("I stopped retrying", notice)
        self.assertNotIn("terminal 5 times", notice)
        self.assertEqual(len(self.spawned), 1)
        state = json.loads((self.data / "default" / "state.json").read_text())
        self.assertEqual(state["jobs"]["job1"]["status"], "retrying")
        self.assertEqual(state["jobs"]["job1"]["attempt"], 2)
        receipts = (self.data / "default" / "receipts" / "job1.jsonl").read_text()
        self.assertNotIn("I stopped retrying", receipts)
        self.assertIn("artifact_sha256", receipts)

    def test_allow_returns_none(self):
        result = gate.handle_turn(GOOD, execution(), config_path=self.config, check_fn=lambda q, a, c, k: {"status": "decision", "verdict": "correct", "confidence": 0.9})
        self.assertIsNone(result)
        state = json.loads((self.data / "default" / "state.json").read_text())
        self.assertEqual(state["jobs"]["job1"]["status"], "approved")

    def test_low_confidence_incorrect_allows(self):
        result = gate.handle_turn(GOOD, execution(), config_path=self.config, check_fn=lambda q, a, c, k: {"status": "decision", "verdict": "incorrect", "confidence": 0.5})
        self.assertIsNone(result)

    def test_high_confidence_incorrect_holds(self):
        result = gate.handle_turn(GOOD, execution(), config_path=self.config, check_fn=lambda q, a, c, k: {"status": "decision", "verdict": "incorrect", "confidence": 0.95})
        self.assertIsNotNone(result)
        self.assertIn("JEV gate held", result)

    def test_dry_run_does_not_replace(self):
        self.write_config(mode="dry_run")
        result = gate.handle_turn(ABORT, execution(), config_path=self.config)
        self.assertIsNone(result)
        self.assertEqual(len(self.spawned), 0)
        state = json.loads((self.data / "default" / "state.json").read_text())
        self.assertEqual(state["jobs"]["job1"]["status"], "dry_run")
        receipts = (self.data / "default" / "receipts" / "job1.jsonl").read_text()
        self.assertIn('"decision": "hold"', receipts)
        self.assertIn('"enqueue_status": "dry_run"', receipts)

    def test_missing_key_allows_and_alerts(self):
        self.keyfile.unlink()
        result = gate.handle_turn(GOOD, execution(), config_path=self.config)
        self.assertIsNone(result)
        self.assertEqual(len(self.alerts), 1)
        self.assertIn("unconfigured", self.alerts[0])

    def test_manual_direct_run_does_not_consume_retry(self):
        gate.handle_turn(ABORT, execution(), config_path=self.config)
        before = json.loads((self.data / "default" / "state.json").read_text())["jobs"]["job1"]
        gate._clear_marker("default", "job1")  # a user manual run, not the helper's replacement
        result = gate.handle_turn(GOOD, execution(source="direct", execution_id="exec-manual"), config_path=self.config, check_fn=lambda q, a, c, k: {"status": "decision", "verdict": "correct", "confidence": 0.9})
        self.assertIsNone(result)
        after = json.loads((self.data / "default" / "state.json").read_text())["jobs"]["job1"]
        self.assertEqual(after["attempt"], before["attempt"])
        receipts = (self.data / "default" / "receipts" / "job1.jsonl").read_text().splitlines()
        self.assertTrue(any('"join_status": "manual"' in line for line in receipts))

    def test_exhausted_budget(self):
        self.write_config(max_attempts=1)
        result = gate.handle_turn(ABORT, execution(), config_path=self.config)
        self.assertIsNotNone(result)
        self.assertIn("exhausted", result)
        self.assertEqual(len(self.spawned), 0)
        state = json.loads((self.data / "default" / "state.json").read_text())
        self.assertEqual(state["jobs"]["job1"]["status"], "exhausted")

    def test_lock_failure_returns_hold_notice(self):
        lock_path = self.data / "default" / "state.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = gate._acquire(lock_path, wait_ms=100)
        self.assertIsNotNone(fd)
        try:
            result = gate.handle_turn(ABORT, execution(), config_path=self.config)
            self.assertIsNotNone(result)
            receipts = (self.data / "default" / "receipts" / "job1.jsonl").read_text()
            self.assertIn('"lock_status": "unavailable"', receipts)
        finally:
            gate._release(fd)

    def test_self_test_fixtures(self):
        self.assertEqual(gate.self_test(None if False else None), 0)

    def test_oracle_fixtures_shape(self):
        cases = json.loads((HERE / "fixtures" / "golden" / "check-cases.json").read_text(encoding="utf-8"))
        self.assertEqual(len(cases), 5)
        for case in cases:
            if case.get("artifact_oversize"):
                self.assertEqual(gate.prepare_check(case["question"], "x" * 4001, 4000)["status"], "input_too_large")
            else:
                parsed = gate._parse_check_response(json.dumps(case["response"]).encode())
                self.assertEqual(parsed["status"], case["expected"]["status"])


if __name__ == "__main__":
    unittest.main()
