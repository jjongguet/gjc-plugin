#!/usr/bin/env python3
"""Deterministic weekly evolution digest writer for Hermes and Mac.

Python 3 standard library only. The script never reimplements the Dream-RSI
core: it invokes the existing ``rrsi/scripts/journal-dream.mjs`` entry point
when no precomputed receipt is supplied, and it treats the wiki as read-only
(``rev-parse``/``log``; ``fetch --prune`` only on non-dry runs unless
``--no-fetch`` is given).

Contract: hermes/docs/digest-contract.md
Runbook:  hermes/docs/runbook.md
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence

DIGEST_SCHEMA = "hermes-evolution.digest.v1"
LEDGER_SCHEMA = "hermes-evolution.ledger.v1"
RUN_SCHEMA = "hermes-evolution.run.v1"

HOSTS = ("mac", "gw-kmg")

MAX_DIGEST_BYTES = 8 * 1024
MAX_LEDGER_LINE_BYTES = 2 * 1024
MAX_CITATIONS = 5
MAX_CITATION_PATH = 300
MAX_VERDICT_CHARS = 300
MAX_SHA = 64
MAX_RECEIPT_BYTES = 4 * 1024 * 1024

WIKI_NAMESPACES = ("concepts", "entities", "references", "synthesis", "journal")
WIKI_DEFAULTS = {
    "mac": "~/jjongguet/personal-wiki",
    "gw-kmg": "/home/gjc/personal-wiki",
}
DIGEST_ROOT_DEFAULT = "~/.hermes-evolution/digests"

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def kst_timezone() -> _dt.tzinfo:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("Asia/Seoul")
    except Exception:  # pragma: no cover - only on hosts without tzdata
        return _dt.timezone(_dt.timedelta(hours=9), "KST")


def parse_now(value: Optional[str]) -> _dt.datetime:
    if not value:
        return _dt.datetime.now(kst_timezone()).replace(microsecond=0)
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = _dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=kst_timezone())
    return parsed.astimezone(kst_timezone()).replace(microsecond=0)


def run_command(
    argv: Sequence[str], *, cwd: Optional[Path] = None, timeout: int = 30
) -> Dict[str, Any]:
    environment = dict(os.environ)
    environment.setdefault("GIT_TERMINAL_PROMPT", "0")
    try:
        completed = subprocess.run(
            list(argv),
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            env=environment,
        )
    except FileNotFoundError:
        return {"returncode": 127, "stdout": "", "stderr": "missing_executable"}
    except subprocess.TimeoutExpired:
        return {"returncode": 124, "stdout": "", "stderr": "timeout"}
    return {
        "returncode": completed.returncode,
        "stdout": completed.stdout.decode("utf-8", "replace"),
        "stderr": completed.stderr.decode("utf-8", "replace"),
    }


def bounded_text(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = " ".join(value[: limit * 8].split())
    if not text:
        return None
    return text[:limit]


def bounded_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def yaml_string(value: str) -> str:
    # JSON strings are valid YAML double-quoted scalars.
    return json.dumps(value, ensure_ascii=False)


def read_frontmatter_value(path: Path, key: str) -> Optional[str]:
    """Read one scalar from a bounded YAML frontmatter block (no YAML parser)."""
    prefix = key + ":"
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            seen_start = False
            for index, raw in enumerate(handle):
                if index > 60:
                    break
                line = raw.rstrip("\n")
                if line == "---":
                    if seen_start:
                        break
                    seen_start = True
                    continue
                if not seen_start:
                    continue
                if not line.startswith(prefix):
                    continue
                value = line[len(prefix) :].strip()
                if len(value) >= 2 and value[0] == value[-1] == '"':
                    try:
                        decoded = json.loads(value)
                    except ValueError:
                        return None
                    return decoded if isinstance(decoded, str) else None
                return value or None
    except OSError:
        return None
    return None


# ---------------------------------------------------------------------------
# Read-only wiki evidence
# ---------------------------------------------------------------------------


def collect_wiki(wiki: Path, *, fetch: bool) -> Dict[str, Any]:
    """Collect the read ref and bounded page citations. Never writes page content.

    A refresh (``git fetch --prune``) updates only remote-tracking refs. The
    reader prefers ``refs/remotes/origin/main`` (or ``master``) so a fetch
    without a pull still summarizes the canonical remote state; it falls back
    to ``HEAD`` for a checkout with no remote-tracking branch. No pull, checkout
    or page write is ever performed.
    """
    result: Dict[str, Any] = {
        "status": "skipped",
        "reason": "missing",
        "head": None,
        "ref": None,
        "citations": [],
        "fetch": "skipped",
    }
    if not wiki.is_dir():
        return result

    if fetch:
        fetched = run_command(["git", "-C", str(wiki), "fetch", "--prune"], timeout=30)
        result["fetch"] = "ok" if fetched["returncode"] == 0 else "skipped"

    resolved = resolve_wiki_ref(wiki)
    if resolved is None:
        result["reason"] = "not_git_or_unreadable"
        return result
    ref, head = resolved

    result["status"] = "ok"
    result["head"] = head
    result["ref"] = ref
    result["citations"] = collect_citations(wiki, ref)
    return result


def resolve_wiki_ref(wiki: Path) -> Optional[tuple[str, str]]:
    for ref in ("refs/remotes/origin/main", "refs/remotes/origin/master", "HEAD"):
        resolved = run_command(
            ["git", "-C", str(wiki), "rev-parse", "--verify", "--quiet", ref], timeout=10
        )
        sha = resolved["stdout"].strip()
        if resolved["returncode"] == 0 and HEX40.match(sha):
            return ref, sha
    return None


def collect_citations(wiki: Path, ref: str = "HEAD") -> List[Dict[str, str]]:
    """Up to five canonical pages with the commit that last touched each path.

    Only path names and commit SHAs leave this function. Page bodies are never
    read, and raw sources (``_raw``) are excluded.
    """
    namespaces = [name for name in WIKI_NAMESPACES if (wiki / name).is_dir()]
    if not namespaces:
        return []
    argv = [
        "git",
        "-C",
        str(wiki),
        "log",
        "-n",
        "80",
        "--format=%H",
        "--name-only",
        ref,
        "--",
    ] + namespaces
    logged = run_command(argv, timeout=20)
    if logged["returncode"] != 0:
        return []
    tree = run_command(
        ["git", "-C", str(wiki), "ls-tree", "-r", "--name-only", ref, "--"]
        + namespaces,
        timeout=20,
    )
    if tree["returncode"] != 0:
        return []
    existing = set(tree["stdout"].splitlines())

    citations: List[Dict[str, str]] = []
    seen = set()
    current_sha: Optional[str] = None
    for raw in logged["stdout"].splitlines():
        line = raw.strip()
        if not line:
            continue
        if HEX40.match(line):
            current_sha = line
            continue
        if current_sha is None or not line.endswith(".md"):
            continue
        if line.startswith("_raw/") or "/_raw/" in line:
            continue
        if len(line) > MAX_CITATION_PATH:
            continue
        if line not in existing:
            continue
        if line in seen:
            continue
        seen.add(line)
        citations.append({"path": line, "commit": current_sha})
        if len(citations) >= MAX_CITATIONS:
            break
    return citations


# ---------------------------------------------------------------------------
# RRSI receipt
# ---------------------------------------------------------------------------


def collect_rrsi(
    rrsi_json: Optional[Path],
    repo_root: Path,
    *,
    digest_root: Path,
    host: str,
    date: str,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "status": "skipped",
        "reason": "not_run",
        "sha256": None,
        "summary": {},
    }

    if rrsi_json is not None:
        try:
            raw = rrsi_json.read_bytes()
        except OSError:
            result["status"] = "error"
            result["reason"] = "receipt_unreadable"
            return result
        if len(raw) > MAX_RECEIPT_BYTES:
            result["status"] = "error"
            result["reason"] = "receipt_too_large"
            return result
    else:
        journal = repo_root / "rrsi" / "scripts" / "journal-dream.mjs"
        if not journal.is_file():
            result["reason"] = "journal_dream_missing"
            return result
        bun = shutil.which("bun")
        if not bun:
            result["reason"] = "bun_missing"
            return result
        dreamed = run_command([bun, str(journal), "--json"], cwd=repo_root, timeout=90)
        if dreamed["returncode"] != 0:
            stderr = dreamed["stderr"]
            if "no_journal" in stderr or "no_records" in stderr:
                result["status"] = "no_input"
                result["reason"] = "journal_empty"
            else:
                result["status"] = "error"
                result["reason"] = "journal_dream_failed"
            return result
        raw = dreamed["stdout"].encode("utf-8")
        if len(raw) > MAX_RECEIPT_BYTES:
            result["status"] = "error"
            result["reason"] = "receipt_too_large"
            return result

    result["sha256"] = hashlib.sha256(raw).hexdigest()
    try:
        receipt = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        result["status"] = "error"
        result["reason"] = "receipt_invalid_json"
        return result
    if not isinstance(receipt, dict):
        result["status"] = "error"
        result["reason"] = "receipt_schema_invalid"
        return result

    if receipt.get("status") == "blocked":
        result["status"] = "blocked"
        reason = bounded_text(receipt.get("reason"), 80)
        result["reason"] = reason or "rrsi_blocked"
        return result

    provenance = receipt.get("provenance")
    if not isinstance(provenance, dict):
        result["status"] = "error"
        result["reason"] = "receipt_schema_invalid"
        return result

    records = bounded_int(provenance.get("records"))
    imported = bounded_int(provenance.get("importedAttempts"))
    if records is None or imported is None:
        result["status"] = "error"
        result["reason"] = "receipt_schema_invalid"
        return result
    if imported == 0 or records == 0:
        result["status"] = "no_input"
        result["reason"] = "journal_empty"
    else:
        result["status"] = "ran"

    counts = receipt.get("counts")
    counts = counts if isinstance(counts, dict) else {}
    dream = receipt.get("dream")
    dream = dream if isinstance(dream, dict) else {}
    selected = dream.get("selected")
    selected = selected if isinstance(selected, dict) else {}

    summary = {
        "records": records,
        "imported_attempts": imported,
        "episodes": bounded_int(counts.get("episodes")),
        "attempts": bounded_int(counts.get("attempts")),
        "adoptions": bounded_int(counts.get("adoptions")),
        "selected": bounded_text(selected.get("id"), 80),
        "verdict": bounded_text(dream.get("verdict"), MAX_VERDICT_CHARS),
        "receipt_hash": bounded_text(receipt.get("receiptHash"), MAX_SHA),
    }
    result["summary"] = summary

    if result["status"] == "ran":
        previous = previous_receipt_sha(digest_root, host, exclude_date=date)
        if previous and previous == result["sha256"]:
            result["status"] = "unchanged"
    return result


def previous_receipt_sha(digest_root: Path, host: str, *, exclude_date: str) -> Optional[str]:
    if not digest_root.is_dir():
        return None
    try:
        candidates = sorted(digest_root.glob("*-" + host + ".md"), reverse=True)
    except OSError:
        return None
    for candidate in candidates:
        if candidate.name.startswith(exclude_date + "-"):
            continue
        value = read_frontmatter_value(candidate, "rrsi_receipt_sha256")
        if value and HEX64.match(value):
            return value
        return None
    return None


# ---------------------------------------------------------------------------
# Digest rendering
# ---------------------------------------------------------------------------


def overall_status(wiki: Dict[str, Any], rrsi: Dict[str, Any]) -> str:
    if rrsi["status"] == "blocked":
        return "blocked"
    if wiki.get("citations") and rrsi["status"] in ("ran", "unchanged"):
        return "ok"
    if not wiki.get("head") and rrsi["status"] in ("skipped", "error", "no_input"):
        return "blocked"
    return "partial"


def next_actions(wiki: Dict[str, Any], rrsi: Dict[str, Any], status: str) -> List[str]:
    actions: List[str] = []
    if not wiki.get("head"):
        actions.append(
            "Restore a readable personal-wiki checkout; this loop only reads it."
        )
    if rrsi["status"] == "skipped":
        actions.append(
            "Enable the RRSI surface (the JJO-129 Python surface on gw-kmg, or bun "
            "plus rrsi/scripts/journal-dream.mjs on Mac); never substitute synthetic results."
        )
    elif rrsi["status"] == "error":
        actions.append("Inspect the RRSI receipt or journal-dream failure; rerun with a valid receipt.")
    elif rrsi["status"] == "no_input":
        actions.append("Record at least one exploration attempt before the next weekly run.")
    elif rrsi["status"] == "blocked":
        actions.append("Resolve the blocked RRSI precondition (JJO-129); the digest stays blocked.")
    if status == "partial":
        actions.append("Review the missing input above; this digest is incomplete but append-only.")
    if status == "ok":
        actions.append("No action required; the next weekly run is Monday 00:00 KST.")
    actions.append("Review this digest and open follow-up work outside the loop.")
    return actions[:4]


def render_digest(
    *,
    now: _dt.datetime,
    host: str,
    wiki: Dict[str, Any],
    rrsi: Dict[str, Any],
) -> str:
    date = now.date().isoformat()
    status = overall_status(wiki, rrsi)
    citations = wiki.get("citations") or []
    head = wiki.get("head")

    lines: List[str] = [
        "---",
        "schema: " + yaml_string(DIGEST_SCHEMA),
        "date: " + yaml_string(date),
        "host: " + yaml_string(host),
        "generated_at: " + yaml_string(now.isoformat()),
        "status: " + yaml_string(status),
        "rrsi_status: " + yaml_string(rrsi["status"]),
        "rrsi_receipt_sha256: " + (yaml_string(rrsi["sha256"]) if rrsi.get("sha256") else "null"),
        "wiki_head: " + (yaml_string(head) if head else "null"),
        "wiki_ref: " + (yaml_string(wiki.get("ref")) if wiki.get("ref") else "null"),
    ]
    if citations:
        lines.append("citations:")
        for citation in citations:
            lines.append("  - path: " + yaml_string(citation["path"]))
            lines.append("    commit: " + yaml_string(citation["commit"]))
    else:
        lines.append("citations: []")
    lines.extend(
        [
            "---",
            "",
            "# Hermes Evolution Digest %s (%s)" % (date, host),
            "",
            "## Summary",
            "- status: %s" % status,
            "- rrsi: %s" % rrsi["status"],
            "- wiki: %s"
            % (("head " + head + " (" + str(wiki.get("ref")) + ")") if head else "unavailable"),
            "- page content is read-only; no session logs, message ids or secrets are included.",
            "",
            "## RRSI",
        ]
    )

    summary = rrsi.get("summary") or {}
    if rrsi["status"] in ("ran", "unchanged"):
        counts = []
        if summary.get("records") is not None:
            counts.append("records %s" % summary["records"])
        if summary.get("imported_attempts") is not None:
            counts.append("imported attempts %s" % summary["imported_attempts"])
        if summary.get("episodes") is not None:
            counts.append("episodes %s" % summary["episodes"])
        if summary.get("attempts") is not None:
            counts.append("stored attempts %s" % summary["attempts"])
        if summary.get("adoptions") is not None:
            counts.append("adoptions %s" % summary["adoptions"])
        lines.append("- corpus: %s" % (" · ".join(counts) if counts else "not reported"))
        lines.append("- selected policy: %s" % (summary.get("selected") or "not reported"))
        if summary.get("verdict"):
            lines.append("- verdict: %s" % summary["verdict"])
        if summary.get("receipt_hash"):
            lines.append("- dream receipt hash: `%s`" % summary["receipt_hash"][:16])
        lines.append("- receipt sha256: `%s`" % (rrsi.get("sha256") or "unavailable"))
        if rrsi["status"] == "unchanged":
            lines.append("- the receipt is unchanged from the previous digest.")
    elif rrsi["status"] == "no_input":
        lines.append("- no journal records were available; this is not a zero-result claim.")
    elif rrsi["status"] == "blocked":
        lines.append("- blocked: %s" % (rrsi.get("reason") or "rrsi precondition missing"))
        lines.append("- no RRSI metrics are reported because the surface is unavailable.")
    elif rrsi["status"] == "error":
        lines.append("- error: %s" % (rrsi.get("reason") or "rrsi_failed"))
        lines.append("- no RRSI metrics are reported because the receipt was not usable.")
    else:
        lines.append("- skipped: %s" % (rrsi.get("reason") or "not available"))
        lines.append("- no RRSI metrics are reported because the surface is unavailable.")

    lines.extend(["", "## Wiki evidence"])
    if citations:
        for citation in citations:
            lines.append("- `%s` @ `%s`" % (citation["path"], citation["commit"]))
    else:
        lines.append("- 근거 없음")
    lines.append("- citation index only: page bodies are never read or reproduced.")

    lines.extend(["", "## Next actions"])
    for action in next_actions(wiki, rrsi, status):
        lines.append("- [ ] %s" % action)
    lines.append("")

    text = "\n".join(lines)
    return shrink_digest(text)


def shrink_digest(text: str) -> str:
    """Keep the digest under the byte bound without dropping required sections."""
    if len(text.encode("utf-8")) < MAX_DIGEST_BYTES:
        return text
    # Reduce the free-text verdict first; the structure and citations stay.
    reduced = re.sub(r"^- verdict: .{80,}$", "- verdict: [truncated]", text, flags=re.MULTILINE)
    if len(reduced.encode("utf-8")) < MAX_DIGEST_BYTES:
        return reduced
    # Last resort: keep frontmatter and required headings, trim trailing body.
    marker = "\n## Next actions\n"
    if marker in reduced:
        prefix, _tail = reduced.split(marker, 1)
        reduced = prefix + marker + "- [ ] Digest was truncated to the 8 KiB bound.\n"
    encoded = reduced.encode("utf-8")
    if len(encoded) >= MAX_DIGEST_BYTES:
        reduced = encoded[: MAX_DIGEST_BYTES - 2].decode("utf-8", "ignore") + "\n"
    return reduced


# ---------------------------------------------------------------------------
# Ledger, locking and writes
# ---------------------------------------------------------------------------


def ledger_record(
    *,
    date: str,
    host: str,
    digest_path: Path,
    sha256: str,
    generated_at: str,
    status: str,
    rrsi_status: str,
    wiki_head: Optional[str],
    wiki_ref: Optional[str],
) -> Dict[str, Optional[str]]:
    return {
        "schema": LEDGER_SCHEMA,
        "date": date,
        "host": host,
        "path": digest_path.name,
        "sha256": sha256,
        "generated_at": generated_at,
        "status": status,
        "rrsi_status": rrsi_status,
        "wiki_head": wiki_head,
        "wiki_ref": wiki_ref,
    }


def read_ledger(path: Path) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or len(line.encode("utf-8")) > MAX_LEDGER_LINE_BYTES:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
    except OSError:
        return []
    return entries


def find_ledger_entry(
    entries: Sequence[Dict[str, Any]], date: str, host: str
) -> Optional[Dict[str, Any]]:
    for entry in entries:
        if entry.get("date") == date and entry.get("host") == host:
            return entry
    return None


@contextmanager
def digest_lock(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    lock_path = root / ".lock"
    descriptor = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temp_name = tempfile.mkstemp(prefix=path.name + ".tmp.", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def append_ledger_line(path: Path, entry: Dict[str, Any]) -> None:
    line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
    encoded = line.encode("utf-8")
    if len(encoded) > MAX_LEDGER_LINE_BYTES:
        raise ValueError("ledger_line_too_long")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    created = not path.exists()
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())
    if created:
        os.chmod(path, 0o600)


# ---------------------------------------------------------------------------
# Digest repository guard and landing
# ---------------------------------------------------------------------------


def check_digest_repo(repo: Path) -> Optional[str]:
    if not repo.is_dir():
        return "digest_repo_not_a_directory"
    inside = run_command(["git", "-C", str(repo), "rev-parse", "--is-inside-work-tree"], timeout=10)
    if inside["returncode"] != 0 or inside["stdout"].strip() != "true":
        return "digest_repo_not_git"
    origin = run_command(["git", "-C", str(repo), "remote", "get-url", "origin"], timeout=10)
    if origin["returncode"] == 0 and "gjc-plugin" in origin["stdout"].lower():
        return "digest_repo_public_forbidden"
    return None


def land_digest(repo: Path, digest_path: Path, ledger_path: Path, message: str) -> Dict[str, Any]:
    try:
        rel_digest = digest_path.relative_to(repo).as_posix()
        rel_ledger = ledger_path.relative_to(repo).as_posix()
    except ValueError:
        return {"committed": False, "pushed": False, "error": "path_outside_repo"}

    added = run_command(["git", "-C", str(repo), "add", "--", rel_digest, rel_ledger], timeout=30)
    if added["returncode"] != 0:
        return {"committed": False, "pushed": False, "error": "git_add_failed"}

    staged = run_command(
        ["git", "-C", str(repo), "diff", "--cached", "--quiet", "--", rel_digest, rel_ledger],
        timeout=30,
    )
    if staged["returncode"] == 0:
        return {"committed": False, "pushed": False, "error": None, "unchanged": True}
    if staged["returncode"] != 1:
        return {"committed": False, "pushed": False, "error": "git_diff_failed"}

    # --only commits exactly these paths, leaving any unrelated staged work in
    # the index instead of sweeping it into the digest commit.
    committed = run_command(
        ["git", "-C", str(repo), "commit", "--only", "-m", message, "--", rel_digest, rel_ledger],
        timeout=60,
    )
    if committed["returncode"] != 0:
        return {"committed": False, "pushed": False, "error": "git_commit_failed"}

    pushed = run_command(["git", "-C", str(repo), "push"], timeout=120)
    if pushed["returncode"] != 0:
        return {"committed": True, "pushed": False, "error": "git_push_failed"}
    return {"committed": True, "pushed": True, "error": None}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="weekly_evolution.py",
        description="Write one deterministic weekly Hermes evolution digest.",
    )
    parser.add_argument("--host", required=True, choices=HOSTS)
    parser.add_argument("--now", default=None, help="ISO8601 timestamp; default: now in Asia/Seoul")
    parser.add_argument("--digest-root", default=None, help="default: ~/.hermes-evolution/digests")
    parser.add_argument("--digest-repo", default=None, help="private git checkout; writes <repo>/digests")
    parser.add_argument("--wiki", default=None, help="personal-wiki checkout (read-only)")
    parser.add_argument("--rrsi-json", default=None, help="precomputed journal-dream receipt")
    parser.add_argument("--dry-run", action="store_true", help="render to stdout; write nothing")
    parser.add_argument("--no-push", action="store_true", help="write only; never commit or push")
    parser.add_argument("--no-fetch", action="store_true", help="skip git fetch on the wiki")
    parser.add_argument("--json", action="store_true", help="machine-readable status")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.digest_root and args.digest_repo:
        parser.error("--digest-root and --digest-repo are mutually exclusive")

    try:
        now = parse_now(args.now)
    except ValueError:
        parser.error("--now must be an ISO8601 timestamp")
    date = now.date().isoformat()
    host = args.host

    if host == "gw-kmg" and args.digest_repo:
        sys.stderr.write(
            "refused: --host gw-kmg is local-only; the private digest repository is Mac-owned\n"
        )
        if args.json:
            print(
                json.dumps(
                    {
                        "schema": RUN_SCHEMA,
                        "date": date,
                        "host": host,
                        "error": "gw_kmg_repo_forbidden",
                    },
                    ensure_ascii=False,
                )
            )
        return 2

    wiki_path = Path(args.wiki or WIKI_DEFAULTS[host]).expanduser()
    rrsi_json = Path(args.rrsi_json).expanduser() if args.rrsi_json else None
    repo_root = Path(__file__).resolve().parents[2]

    digest_repo: Optional[Path] = None
    if args.digest_repo:
        digest_repo = Path(args.digest_repo).expanduser()
        guard = check_digest_repo(digest_repo)
        if guard:
            sys.stderr.write("refused: %s\n" % guard)
            if args.json:
                print(
                    json.dumps(
                        {"schema": RUN_SCHEMA, "date": date, "host": host, "error": guard},
                        ensure_ascii=False,
                    )
                )
            return 2
        digest_root = digest_repo / "digests"
    elif args.digest_root:
        digest_root = Path(args.digest_root).expanduser()
    else:
        digest_root = Path(DIGEST_ROOT_DEFAULT).expanduser()

    wiki = collect_wiki(wiki_path, fetch=(not args.dry_run and not args.no_fetch))
    rrsi = collect_rrsi(
        rrsi_json,
        repo_root,
        digest_root=digest_root,
        host=host,
        date=date,
    )

    digest_text = render_digest(now=now, host=host, wiki=wiki, rrsi=rrsi)
    digest_bytes = digest_text.encode("utf-8")
    digest_sha = hashlib.sha256(digest_bytes).hexdigest()
    digest_path = digest_root / ("%s-%s.md" % (date, host))
    ledger_path = digest_root / "ledger.jsonl"
    status = overall_status(wiki, rrsi)

    record = ledger_record(
        date=date,
        host=host,
        digest_path=digest_path,
        sha256=digest_sha,
        generated_at=now.isoformat(),
        status=status,
        rrsi_status=rrsi["status"],
        wiki_head=wiki.get("head"),
        wiki_ref=wiki.get("ref"),
    )

    if args.dry_run:
        existing = find_ledger_entry(read_ledger(ledger_path), date, host)
        conflict = bool(existing and existing.get("sha256") != digest_sha)
        if not existing and digest_path.exists():
            try:
                conflict = hashlib.sha256(digest_path.read_bytes()).hexdigest() != digest_sha
            except OSError:
                conflict = True
        if conflict:
            sys.stderr.write(
                "conflict: digest for %s %s is already recorded with a different sha256; "
                "refusing to overwrite\n" % (date, host)
            )
        print(digest_text, end="" if digest_text.endswith("\n") else "\n")
        if args.json:
            print(
                json.dumps(
                    {
                        "schema": RUN_SCHEMA,
                        "date": date,
                        "host": host,
                        "status": status,
                        "rrsi_status": rrsi["status"],
                        "wiki_head": wiki.get("head"),
                        "wiki_ref": wiki.get("ref"),
                        "sha256": digest_sha,
                        "path": str(digest_path),
                        "recorded": "conflict" if conflict else "dry-run",
                        "dry_run": True,
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
        return 2 if conflict else 0

    with digest_lock(digest_root):
        entries = read_ledger(ledger_path)
        existing = find_ledger_entry(entries, date, host)
        if existing:
            if existing.get("sha256") == digest_sha:
                if digest_path.exists():
                    try:
                        current_sha = hashlib.sha256(digest_path.read_bytes()).hexdigest()
                    except OSError:
                        current_sha = None
                    if current_sha != digest_sha:
                        sys.stderr.write(
                            "conflict: %s exists with a different sha256 than the ledger; "
                            "refusing to overwrite\n" % digest_path.name
                        )
                        return 2
                else:
                    atomic_write_bytes(digest_path, digest_bytes)
                emit_result(args, record, digest_path, recorded="already-recorded")
                return 0
            sys.stderr.write(
                "conflict: digest for %s %s is already recorded with a different sha256; "
                "refusing to overwrite\n" % (date, host)
            )
            if args.json:
                print(
                    json.dumps(
                        {
                            "schema": RUN_SCHEMA,
                            "date": date,
                            "host": host,
                            "status": status,
                            "rrsi_status": rrsi["status"],
                            "sha256": digest_sha,
                            "path": str(digest_path),
                            "recorded": "conflict",
                        },
                        ensure_ascii=False,
                    )
                )
            return 2

        if digest_path.exists():
            try:
                existing_sha = hashlib.sha256(digest_path.read_bytes()).hexdigest()
            except OSError:
                existing_sha = None
            if existing_sha != digest_sha:
                sys.stderr.write(
                    "conflict: %s exists with a different sha256; refusing to overwrite\n"
                    % digest_path.name
                )
                if args.json:
                    print(
                        json.dumps(
                            {
                                "schema": RUN_SCHEMA,
                                "date": date,
                                "host": host,
                                "status": status,
                                "rrsi_status": rrsi["status"],
                                "sha256": digest_sha,
                                "path": str(digest_path),
                                "recorded": "conflict",
                            },
                            ensure_ascii=False,
                        )
                    )
                return 2
            # Crash recovery: the digest was written but the ledger append did not
            # complete. Append the missing row; never duplicate an existing row.
            append_ledger_line(ledger_path, record)
            emit_result(args, record, digest_path, recorded="recovered")
            return 0

        atomic_write_bytes(digest_path, digest_bytes)
        append_ledger_line(ledger_path, record)

    landed = {"committed": False, "pushed": False, "error": None}
    if digest_repo is not None and not args.no_push:
        message = "chore(hermes): weekly digest %s %s" % (date, host)
        landed = land_digest(digest_repo, digest_path, ledger_path, message)
        if landed.get("error"):
            sys.stderr.write("landing: %s\n" % landed["error"])
            if args.json:
                print(
                    json.dumps(
                        {
                            "schema": RUN_SCHEMA,
                            "date": date,
                            "host": host,
                            "status": status,
                            "rrsi_status": rrsi["status"],
                            "sha256": digest_sha,
                            "path": str(digest_path),
                            "recorded": "recorded",
                            "committed": bool(landed.get("committed")),
                            "pushed": bool(landed.get("pushed")),
                            "error": landed.get("error"),
                        },
                        ensure_ascii=False,
                    )
                )
            return 2

    emit_result(args, record, digest_path, recorded="recorded", landed=landed)
    return 0


def emit_result(
    args: argparse.Namespace,
    record: Dict[str, Any],
    digest_path: Path,
    *,
    recorded: str,
    landed: Optional[Dict[str, Any]] = None,
) -> None:
    if args.json:
        payload = {
            "schema": RUN_SCHEMA,
            "date": record["date"],
            "host": record["host"],
            "status": record["status"],
            "rrsi_status": record["rrsi_status"],
            "wiki_head": record["wiki_head"],
            "wiki_ref": record.get("wiki_ref"),
            "sha256": record["sha256"],
            "path": str(digest_path),
            "recorded": recorded,
        }
        if landed:
            payload["committed"] = bool(landed.get("committed"))
            payload["pushed"] = bool(landed.get("pushed"))
        print(json.dumps(payload, ensure_ascii=False))
        return
    print(
        "%s %s host=%s status=%s rrsi=%s sha256=%s"
        % (recorded, digest_path.name, record["host"], record["status"], record["rrsi_status"], record["sha256"])
    )
    if landed and landed.get("committed"):
        print("committed=%s pushed=%s" % (bool(landed.get("committed")), bool(landed.get("pushed"))))


if __name__ == "__main__":
    raise SystemExit(main())
