// 로컬 메타 서버 렌더 — Supabase 미연결(보류 — Addendum 1) 구간의 적응 뷰.
// 봉투 대신 레포 package.json 버전·최신 git 태그를 빌드 시점에 읽어 정적으로 표시하고,
// 봉투 영역은 미연결 상태를 명시한다. Supabase 연결 후 factory 본보기(4봉투 서버 렌더)로 교체.
import { readLocalMeta } from "@/lib/local-meta";
import { MISSING_THRESHOLD } from "@/platform/missing-threshold";

export default function DashboardPage() {
  const meta = readLocalMeta();
  return (
    <main>
      <h1>local meta</h1>
      <table>
        <tbody>
          <tr>
            <th>package</th>
            <td>{meta.name}</td>
          </tr>
          <tr>
            <th>version</th>
            <td>{meta.version}</td>
          </tr>
          <tr>
            <th>latest tag</th>
            <td>{meta.latestTag}</td>
          </tr>
        </tbody>
      </table>
      <section>
        <h2>envelopes</h2>
        <p>
          Supabase 미연결(보류 — Addendum 1) — status·ledger·workflow_runs·workflow_steps
          봉투 열람은 연결 후 활성화된다. push-envelope 없음(적재 원천 미연결).
          결측 경고: {MISSING_THRESHOLD.warnDays}일 warn·{MISSING_THRESHOLD.urgentDays}일 urgent
        </p>
      </section>
    </main>
  );
}
