// 로컬 메타 리더 — Supabase 미연결(보류 — Addendum 1) 동안 대시보드가 표시하는
// 정적 레포 메타. package.json 버전과 최신 git 태그를 빌드 시점(정적 렌더)에 읽는다.
// 서버 전용 — 클라이언트 번들에 포함되지 않는다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LocalMeta = { name: string; version: string; latestTag: string };

export function readLocalMeta(): LocalMeta {
  // 레포 루트 package.json 우선 — 없으면(skill 레포) 대시보드 자신의 것.
  const rootPkg = join(process.cwd(), "..", "package.json");
  const pkgPath = existsSync(rootPkg) ? rootPkg : join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
  const latestTag = (() => {
    try {
      return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" }).trim();
    } catch {
      return "(태그 없음)";
    }
  })();
  return { name: pkg.name ?? "(이름 없음)", version: pkg.version ?? "(버전 없음)", latestTag };
}
