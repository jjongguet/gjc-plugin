# dashboard

A maintainer-only local meta view for this repository. At build time it reads the root
`package.json` version and the latest git tag and renders them statically.

- Not a plugin: it is not part of the GJC plugin distribution and it is not deployed.
- Supabase is not connected, so the envelope area only shows a not-connected notice and nothing is
  pushed anywhere.
- Access requires the `DASHBOARD_TOKEN` server environment variable (see `.env.example`).

## Commands

```sh
npm ci
npm run dev
npm test          # TypeScript check (tsc --noEmit)
npm run validate  # maintainer-only workspace-standard validator that lives outside this repository
```
