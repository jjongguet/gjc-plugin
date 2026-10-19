// Local meta server render — the interim view while Supabase is not connected.
// Instead of envelopes, reads the repo's package.json version and latest git tag at build time
// and renders them statically; the envelope area states the not-connected status.
// Replace with the factory example (server-rendered 4 envelopes) once Supabase is connected.
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
          Supabase is not connected yet — the status, ledger, workflow_runs, and workflow_steps
          envelopes become readable once it is connected. No push-envelope (no ingestion source
          connected). Missing warning: {MISSING_THRESHOLD.warnDays}-day warn,{" "}
          {MISSING_THRESHOLD.urgentDays}-day urgent
        </p>
      </section>
    </main>
  );
}
