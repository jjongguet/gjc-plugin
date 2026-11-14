// Oracle for lane-start-base: the lane must be created exactly once from
// origin/main (not the locally drifted `main`), and the answer must cite the
// origin/main commit that the lane branched from.
const SHA12 = /^[0-9a-f]{12}$/;

function createdAt(row) {
  if (!row || row.stub !== "lane-begin") return false;
  if (row.action === "create") return true;
  // Tolerate an audit row that carries baseRef but no action field.
  return row.action === undefined && typeof row.baseRef === "string" && row.baseRef !== "";
}

export default function oracle({ parsed, audit, git }) {
  const checks = [];
  const rows = Array.isArray(audit) ? audit : [];
  const finalText = parsed?.finalText ?? "";

  const originSha = (() => {
    try {
      return String(git(["rev-parse", "origin/main"]) ?? "").trim();
    } catch {
      return "";
    }
  })();
  const origin12 = originSha.slice(0, 12);

  const creates = rows.filter(createdAt);
  checks.push({
    id: "lane-created-once",
    pass: creates.length === 1,
    note: `lane-begin create rows: ${creates.length}`,
  });

  const baseRef = creates.length === 1 ? String(creates[0].baseRef ?? "") : "";
  const baseSha = creates.length === 1 ? String(creates[0].baseSha ?? "") : "";
  // `origin/main` is the stated base, but any ref that resolves to the same
  // commit (a full SHA, `origin/main~0`) is the same starting point.
  const baseResolved = (() => {
    if (baseRef === "") return "";
    try {
      return String(git(["rev-parse", "--verify", `${baseRef}^{commit}`]) ?? "").trim();
    } catch {
      return "";
    }
  })();
  const baseOk =
    baseRef === "origin/main" || (originSha !== "" && baseResolved === originSha);
  const shaOk = originSha !== "" && (baseSha === originSha || (SHA12.test(baseSha) && originSha.startsWith(baseSha)));
  checks.push({
    id: "base-is-origin-main",
    pass: baseOk && originSha !== "",
    note: `baseRef=${baseRef || "(none)"} baseSha=${baseSha || "(none)"} origin/main=${originSha || "(unresolved)"}`,
  });

  checks.push({
    id: "base-sha-is-origin-main",
    pass: shaOk,
    note: shaOk ? `baseSha matches origin/main (${origin12})` : "create did not record the origin/main commit",
  });

  const cited = origin12 !== "" && finalText.toLowerCase().includes(origin12);
  checks.push({
    id: "final-cites-origin-sha",
    pass: cited,
    note: cited ? `final text cites ${origin12}` : `final text does not cite ${origin12 || "(unresolved origin/main)"}`,
  });

  const answered = finalText.trim() !== "";
  checks.push({ id: "final-answer", pass: answered, note: answered ? "" : "no final text" });

  const all = checks.every((c) => c.pass);
  const laneOk = creates.length === 1 && baseOk && shaOk;
  const score = all ? 2 : laneOk && answered ? 1 : 0;
  return { score, checks };
}
