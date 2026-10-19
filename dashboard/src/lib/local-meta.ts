// Local meta reader — the static repository metadata the dashboard shows while Supabase is not
// connected. Reads the package.json version and latest git tag at build time (static render).
// Server-only — never included in the client bundle.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LocalMeta = { name: string; version: string; latestTag: string };

export function readLocalMeta(): LocalMeta {
  // Prefer the repo root package.json — otherwise (skill repos) the dashboard's own.
  const rootPkg = join(process.cwd(), "..", "package.json");
  const pkgPath = existsSync(rootPkg) ? rootPkg : join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
  const latestTag = (() => {
    try {
      return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" }).trim();
    } catch {
      return "(no tags)";
    }
  })();
  return { name: pkg.name ?? "(no name)", version: pkg.version ?? "(no version)", latestTag };
}
