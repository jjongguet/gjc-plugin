"""Unit tests for hermes/scripts/weekly_evolution.py (stdlib unittest)."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "hermes" / "scripts"))

import weekly_evolution  # noqa: E402

NOW = "2026-10-19T00:00:00+09:00"
NEXT_WEEK = "2026-10-26T00:00:00+09:00"
WIKI_SECRET = "TOP-SECRET-WIKI-BODY-NEVER-COPY"
RECEIPT_SECRET = "SECRET-RECEIPT-PAYLOAD-NEVER-COPY"


class WeeklyEvolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.tmp = Path(self._temp.name)
        self.wiki = self.tmp / "wiki"
        self.receipt = self.tmp / "rrsi.json"
        self.digest_root = self.tmp / "home" / ".hermes-evolution" / "digests"
        self.digest_root.parent.mkdir(parents=True, exist_ok=True)
        self.make_wiki(self.wiki)
        self.write_receipt(self.receipt)

    # -- fixtures -----------------------------------------------------

    def git(self, repo: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "-C", str(repo)] + list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )

    def init_repo(self, path: Path, remote: str = None) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q", str(path)], check=True)
        self.git(path, "config", "user.name", "Hermes Test")
        self.git(path, "config", "user.email", "hermes@example.invalid")
        self.git(path, "config", "commit.gpgsign", "false")
        if remote:
            self.git(path, "remote", "add", "origin", remote)
        return path

    def commit_file(self, repo: Path, relative: str, content: str, message: str) -> str:
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.git(repo, "add", "--", relative)
        self.git(repo, "commit", "-q", "-m", message)
        return self.git(repo, "rev-parse", "HEAD").stdout.decode().strip()

    def make_wiki(self, path: Path) -> Path:
        self.init_repo(path)
        self.commit_file(path, "concepts/page-a.md", "# Page A\n\n" + WIKI_SECRET + "\n", "add page a")
        self.commit_file(path, "journal/weekly.md", "# Weekly\n\n" + WIKI_SECRET + "\n", "add weekly")
        return path

    def write_receipt(self, path: Path, **overrides) -> Path:
        data = {
            "schema": "gjc.self-improve.journal-dream.v1",
            "provenance": {
                "source": "jev-journal",
                "segments": 1,
                "records": 12,
                "importedAttempts": 12,
                "branches": 3,
                "limit": 200,
                "seed": 1,
            },
            "counts": {"episodes": 1, "attempts": 12, "adoptions": 3},
            "dream": {
                "selected": {"id": "fixed-b2"},
                "verdict": "insufficient evidence at pass-gate size — thresholds not evaluated",
                "receiptHash": "a" * 64,
            },
            "receiptHash": "a" * 64,
        }
        data.update(overrides)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def run_main(self, args):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = weekly_evolution.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def base_args(self, now: str = NOW) -> list:
        return [
            "--host",
            "mac",
            "--now",
            now,
            "--digest-root",
            str(self.digest_root),
            "--wiki",
            str(self.wiki),
        ]

    def read_ledger(self) -> list:
        path = self.digest_root / "ledger.jsonl"
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def digest_path(self, now: str = NOW) -> Path:
        return self.digest_root / ("%s-mac.md" % now[:10])

    # -- dry-run ------------------------------------------------------

    def test_dry_run_writes_nothing_and_prints_complete_digest(self) -> None:
        head_before = self.git(self.wiki, "rev-parse", "HEAD").stdout.decode().strip()
        code, out, err = self.run_main(
            self.base_args()
            + ["--dry-run", "--rrsi-json", str(self.receipt)]
        )
        self.assertEqual(code, 0, err)
        for marker in (
            'schema: "hermes-evolution.digest.v1"',
            "## Summary",
            "## RRSI",
            "## Wiki evidence",
            "## Next actions",
            "concepts/page-a.md",
            head_before,
        ):
            self.assertIn(marker, out)
        self.assertFalse(self.digest_root.exists())
        self.assertFalse((self.wiki / ".git" / "FETCH_HEAD").exists())
        self.assertNotIn(WIKI_SECRET, out)
        self.assertEqual(
            self.git(self.wiki, "status", "--porcelain").stdout.decode().strip(), ""
        )
        self.assertEqual(
            self.git(self.wiki, "rev-parse", "HEAD").stdout.decode().strip(), head_before
        )

    def test_dry_run_default_state_root_is_not_created(self) -> None:
        home = self.tmp / "isolated-home"
        home.mkdir()
        args = [
            "--host",
            "mac",
            "--now",
            NOW,
            "--wiki",
            str(self.wiki),
            "--rrsi-json",
            str(self.receipt),
            "--dry-run",
        ]
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            code, out, err = self.run_main(args)
        self.assertEqual(code, 0, err)
        self.assertIn("## Summary", out)
        self.assertFalse((home / ".hermes-evolution").exists())

    def test_dry_run_with_digest_repo_writes_nothing(self) -> None:
        repo = self.init_repo(
            self.tmp / "private-dry-run",
            remote="https://github.com/jjongguet/private-digest.git",
        )
        self.commit_file(repo, "README.md", "# private digests\n", "init")
        code, out, err = self.run_main(
            [
                "--host",
                "mac",
                "--now",
                NOW,
                "--digest-repo",
                str(repo),
                "--wiki",
                str(self.wiki),
                "--rrsi-json",
                str(self.receipt),
                "--dry-run",
            ]
        )
        self.assertEqual(code, 0, err)
        self.assertIn("## Summary", out)
        self.assertFalse((repo / "digests").exists())
        self.assertEqual(
            self.git(repo, "status", "--porcelain").stdout.decode().strip(), ""
        )
        self.assertEqual(
            self.git(repo, "log", "-1", "--format=%s").stdout.decode().strip(),
            "init",
        )

    # -- exactly-once -------------------------------------------------

    def test_exactly_once_same_sha_appends_no_second_ledger_line(self) -> None:
        args = self.base_args() + ["--rrsi-json", str(self.receipt)]
        first = self.run_main(args)
        self.assertEqual(first[0], 0, first[2])
        self.assertIn("recorded", first[1])
        first_bytes = self.digest_path().read_bytes()

        second = self.run_main(args)
        self.assertEqual(second[0], 0, second[2])
        self.assertIn("already-recorded", second[1])
        entries = self.read_ledger()
        self.assertEqual(len(entries), 1)
        self.assertEqual(self.digest_path().read_bytes(), first_bytes)

    def test_conflict_on_different_sha_never_overwrites(self) -> None:
        args = self.base_args() + ["--rrsi-json", str(self.receipt)]
        first = self.run_main(args)
        self.assertEqual(first[0], 0, first[2])
        first_bytes = self.digest_path().read_bytes()

        later = "2026-10-19T01:00:00+09:00"
        second = self.run_main(self.base_args(later) + ["--rrsi-json", str(self.receipt)])
        self.assertEqual(second[0], 2)
        self.assertIn("conflict", second[2])
        self.assertEqual(len(self.read_ledger()), 1)
        self.assertEqual(self.digest_path().read_bytes(), first_bytes)

    def test_dry_run_reports_existing_conflict(self) -> None:
        self.assertEqual(
            self.run_main(self.base_args() + ["--rrsi-json", str(self.receipt)])[0], 0
        )
        later = "2026-10-19T02:00:00+09:00"
        code, out, err = self.run_main(
            self.base_args(later) + ["--rrsi-json", str(self.receipt), "--dry-run"]
        )
        self.assertEqual(code, 2)
        self.assertIn("conflict", err)
        self.assertIn("## Summary", out)

    def test_crash_recovery_appends_missing_ledger_row(self) -> None:
        code, out, err = self.run_main(
            self.base_args() + ["--rrsi-json", str(self.receipt), "--dry-run"]
        )
        self.assertEqual(code, 0, err)
        self.digest_root.mkdir(parents=True)
        self.digest_path().write_text(out, encoding="utf-8")

        recovered = self.run_main(self.base_args() + ["--rrsi-json", str(self.receipt)])
        self.assertEqual(recovered[0], 0, recovered[2])
        self.assertIn("recovered", recovered[1])
        self.assertEqual(len(self.read_ledger()), 1)

    def test_already_recorded_restores_a_missing_digest_file(self) -> None:
        args = self.base_args() + ["--rrsi-json", str(self.receipt)]
        self.assertEqual(self.run_main(args)[0], 0)
        original = self.digest_path().read_bytes()
        self.digest_path().unlink()

        again = self.run_main(args)
        self.assertEqual(again[0], 0, again[2])
        self.assertIn("already-recorded", again[1])
        self.assertEqual(self.digest_path().read_bytes(), original)
        self.assertEqual(len(self.read_ledger()), 1)

    def test_tampered_digest_file_is_a_conflict(self) -> None:
        args = self.base_args() + ["--rrsi-json", str(self.receipt)]
        self.assertEqual(self.run_main(args)[0], 0)
        self.digest_path().write_text("tampered\n", encoding="utf-8")

        again = self.run_main(args)
        self.assertEqual(again[0], 2)
        self.assertIn("conflict", again[2])
        self.assertEqual(self.digest_path().read_text(encoding="utf-8"), "tampered\n")
        self.assertEqual(len(self.read_ledger()), 1)

    # -- partial / blocked --------------------------------------------

    def test_partial_when_rrsi_surface_is_missing(self) -> None:
        with mock.patch.object(weekly_evolution.shutil, "which", return_value=None):
            code, out, err = self.run_main(self.base_args())
        self.assertEqual(code, 0, err)
        text = self.digest_path().read_text(encoding="utf-8")
        self.assertIn('status: "partial"', text)
        self.assertIn('rrsi_status: "skipped"', text)
        self.assertIn("JJO-129", text)

    def test_partial_when_wiki_is_missing(self) -> None:
        missing_wiki = self.tmp / "missing-wiki"
        args = self.base_args() + ["--rrsi-json", str(self.receipt)]
        args[args.index("--wiki") + 1] = str(missing_wiki)
        code, out, err = self.run_main(args)
        self.assertEqual(code, 0, err)
        text = self.digest_path().read_text(encoding="utf-8")
        self.assertIn('status: "partial"', text)
        self.assertIn("wiki_head: null", text)
        self.assertIn("근거 없음", text)

    def test_blocked_when_both_inputs_are_missing(self) -> None:
        missing_wiki = self.tmp / "missing-wiki"
        args = self.base_args()
        args[args.index("--wiki") + 1] = str(missing_wiki)
        with mock.patch.object(weekly_evolution.shutil, "which", return_value=None):
            code, out, err = self.run_main(args)
        self.assertEqual(code, 0, err)
        text = self.digest_path().read_text(encoding="utf-8")
        self.assertIn('status: "blocked"', text)
        self.assertIn('rrsi_status: "skipped"', text)

    def test_blocked_receipt_is_honoured(self) -> None:
        blocked = self.tmp / "blocked.json"
        blocked.write_text(
            json.dumps(
                {
                    "schema": "hermes-evolution.rrsi-blocked.v1",
                    "status": "blocked",
                    "reason": "python_rrsi_surface_missing",
                }
            ),
            encoding="utf-8",
        )
        code, out, err = self.run_main(self.base_args() + ["--rrsi-json", str(blocked)])
        self.assertEqual(code, 0, err)
        text = self.digest_path().read_text(encoding="utf-8")
        self.assertIn('status: "blocked"', text)
        self.assertIn('rrsi_status: "blocked"', text)
        self.assertIn("python_rrsi_surface_missing", text)

    def test_unchanged_receipt_is_reported_on_the_next_week(self) -> None:
        first = self.run_main(self.base_args() + ["--rrsi-json", str(self.receipt)])
        self.assertEqual(first[0], 0, first[2])
        second = self.run_main(
            self.base_args(NEXT_WEEK) + ["--rrsi-json", str(self.receipt)]
        )
        self.assertEqual(second[0], 0, second[2])
        text = (self.digest_root / "2026-10-26-mac.md").read_text(encoding="utf-8")
        self.assertIn('rrsi_status: "unchanged"', text)

    # -- repository guard ---------------------------------------------

    def test_public_repo_guard_refuses_gjc_plugin(self) -> None:
        repo = self.init_repo(
            self.tmp / "public-digest-repo",
            remote="https://github.com/jjongguet/gjc-plugin.git",
        )
        code, out, err = self.run_main(
            [
                "--host",
                "mac",
                "--now",
                NOW,
                "--digest-repo",
                str(repo),
                "--rrsi-json",
                str(self.receipt),
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("public", err)
        self.assertFalse((repo / "digests").exists())

    def test_non_git_digest_repo_is_refused(self) -> None:
        repo = self.tmp / "plain-directory"
        repo.mkdir()
        code, out, err = self.run_main(
            [
                "--host",
                "mac",
                "--now",
                NOW,
                "--digest-repo",
                str(repo),
                "--rrsi-json",
                str(self.receipt),
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("not_git", err)
        self.assertFalse((repo / "digests").exists())

    def test_gw_kmg_never_writes_the_private_repository(self) -> None:
        repo = self.init_repo(
            self.tmp / "private-repo",
            remote="https://github.com/jjongguet/private-digest.git",
        )
        code, out, err = self.run_main(
            [
                "--host",
                "gw-kmg",
                "--now",
                NOW,
                "--digest-repo",
                str(repo),
                "--rrsi-json",
                str(self.receipt),
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("Mac-owned", err)
        self.assertFalse((repo / "digests").exists())

    # -- private repository landing -----------------------------------

    def test_digest_repo_commits_and_pushes_only_owned_files(self) -> None:
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
        seed = self.init_repo(self.tmp / "seed")
        self.commit_file(seed, "README.md", "# private digests\n", "init")
        self.git(seed, "remote", "add", "origin", str(remote))
        branch = subprocess.run(
            ["git", "--git-dir", str(remote), "symbolic-ref", "--short", "HEAD"],
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.decode().strip()
        self.git(seed, "push", "-q", "origin", "HEAD:refs/heads/" + branch)
        repo = self.tmp / "private-digest"
        subprocess.run(["git", "clone", "-q", str(remote), str(repo)], check=True)
        self.git(repo, "config", "user.name", "Hermes Test")
        self.git(repo, "config", "user.email", "hermes@example.invalid")
        self.git(repo, "config", "commit.gpgsign", "false")
        (repo / "staged.txt").write_text("staged user work\n", encoding="utf-8")
        self.git(repo, "add", "--", "staged.txt")
        (repo / "unrelated.txt").write_text("user work\n", encoding="utf-8")

        code, out, err = self.run_main(
            [
                "--host",
                "mac",
                "--now",
                NOW,
                "--digest-repo",
                str(repo),
                "--wiki",
                str(self.wiki),
                "--rrsi-json",
                str(self.receipt),
            ]
        )
        self.assertEqual(code, 0, err)
        subject = (
            self.git(repo, "log", "-1", "--format=%s").stdout.decode().strip()
        )
        self.assertEqual(subject, "chore(hermes): weekly digest 2026-10-19 mac")
        committed = (
            self.git(repo, "show", "--name-only", "--format=", "HEAD")
            .stdout.decode()
            .split()
        )
        self.assertEqual(
            sorted(committed),
            ["digests/2026-10-19-mac.md", "digests/ledger.jsonl"],
        )
        status = self.git(repo, "status", "--porcelain").stdout.decode()
        self.assertIn("A  staged.txt", status)
        self.assertIn("?? unrelated.txt", status)
        remote_log = subprocess.run(
            ["git", "--git-dir", str(remote), "log", "-1", "--format=%s"],
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.decode().strip()
        self.assertEqual(remote_log, "chore(hermes): weekly digest 2026-10-19 mac")

    def test_no_push_writes_repo_files_without_committing(self) -> None:
        repo = self.init_repo(
            self.tmp / "private-no-push",
            remote="https://github.com/jjongguet/private-digest.git",
        )
        self.commit_file(repo, "README.md", "# private digests\n", "init")
        code, out, err = self.run_main(
            [
                "--host",
                "mac",
                "--now",
                NOW,
                "--digest-repo",
                str(repo),
                "--no-push",
                "--wiki",
                str(self.wiki),
                "--rrsi-json",
                str(self.receipt),
            ]
        )
        self.assertEqual(code, 0, err)
        self.assertTrue((repo / "digests" / "2026-10-19-mac.md").is_file())
        self.assertTrue((repo / "digests" / "ledger.jsonl").is_file())
        self.assertEqual(
            self.git(repo, "log", "-1", "--format=%s").stdout.decode().strip(), "init"
        )

    def test_wiki_prefers_refreshed_origin_main_without_pull(self) -> None:
        old = self.git(self.wiki, "rev-parse", "HEAD").stdout.decode().strip()
        self.git(self.wiki, "checkout", "-q", "-b", "remote-state")
        new = self.commit_file(
            self.wiki, "concepts/page-b.md", "# Page B\n", "add page b"
        )
        self.git(self.wiki, "update-ref", "refs/remotes/origin/main", new)
        self.git(self.wiki, "checkout", "-q", "--detach", old)

        collected = weekly_evolution.collect_wiki(self.wiki, fetch=False)

        self.assertEqual(collected["head"], new)
        self.assertEqual(collected["ref"], "refs/remotes/origin/main")
        self.assertIn(
            "concepts/page-b.md", [item["path"] for item in collected["citations"]]
        )
        # The refresh must not move the worktree HEAD or pull pages.
        self.assertEqual(
            self.git(self.wiki, "rev-parse", "HEAD").stdout.decode().strip(), old
        )

    # -- bounds and privacy -------------------------------------------

    def test_ledger_line_bound_and_fields(self) -> None:
        code, out, err = self.run_main(self.base_args() + ["--rrsi-json", str(self.receipt)])
        self.assertEqual(code, 0, err)
        raw_lines = (
            (self.digest_root / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
        )
        self.assertEqual(len(raw_lines), 1)
        self.assertLessEqual(len(raw_lines[0].encode("utf-8")), 2048)
        entry = json.loads(raw_lines[0])
        self.assertEqual(
            sorted(entry),
            [
                "date",
                "generated_at",
                "host",
                "path",
                "rrsi_status",
                "schema",
                "sha256",
                "status",
                "wiki_head",
                "wiki_ref",
            ],
        )
        self.assertEqual(entry["path"], "2026-10-19-mac.md")
        self.assertEqual(
            entry["sha256"],
            hashlib.sha256(self.digest_path().read_bytes()).hexdigest(),
        )
        self.assertNotIn(str(self.tmp), raw_lines[0])
        self.assertEqual(stat.S_IMODE(self.digest_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.digest_path().stat().st_mode), 0o600)
        self.assertEqual(
            stat.S_IMODE((self.digest_root / "ledger.jsonl").stat().st_mode), 0o600
        )
        self.assertEqual(stat.S_IMODE((self.digest_root / ".lock").stat().st_mode), 0o600)

    def test_digest_size_bound_with_oversized_receipt(self) -> None:
        huge = self.tmp / "huge.json"
        self.write_receipt(
            huge,
            dream={
                "selected": {"id": "fixed-b2"},
                "verdict": "x" * 200000,
                "receiptHash": "b" * 64,
            },
        )
        code, out, err = self.run_main(self.base_args() + ["--rrsi-json", str(huge)])
        self.assertEqual(code, 0, err)
        text = self.digest_path().read_text(encoding="utf-8")
        self.assertLess(len(text.encode("utf-8")), 8192)
        for heading in ("## Summary", "## RRSI", "## Wiki evidence", "## Next actions"):
            self.assertIn(heading, text)

    def test_no_raw_or_secret_fields_are_copied(self) -> None:
        tainted = self.tmp / "tainted.json"
        self.write_receipt(
            tainted,
            raw_transcript=RECEIPT_SECRET,
            token=RECEIPT_SECRET,
            messages=[{"content": RECEIPT_SECRET}],
            prompt=RECEIPT_SECRET,
        )
        code, out, err = self.run_main(self.base_args() + ["--rrsi-json", str(tainted)])
        self.assertEqual(code, 0, err)
        text = self.digest_path().read_text(encoding="utf-8")
        self.assertNotIn(RECEIPT_SECRET, text)
        self.assertNotIn(WIKI_SECRET, text)
        self.assertNotIn(str(self.tmp), text)

    def test_json_status_is_machine_readable(self) -> None:
        code, out, err = self.run_main(
            self.base_args() + ["--rrsi-json", str(self.receipt), "--json"]
        )
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["schema"], "hermes-evolution.run.v1")
        self.assertEqual(payload["date"], "2026-10-19")
        self.assertEqual(payload["host"], "mac")
        self.assertEqual(payload["recorded"], "recorded")
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["rrsi_status"], "ran")


if __name__ == "__main__":
    unittest.main()
