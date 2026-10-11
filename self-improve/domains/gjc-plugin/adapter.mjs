/**
 * First domain adapter: gjc-plugin itself.
 *
 * Engine-importable on plain Node (.mjs). Probe and held-out suites are separate
 * bun TS runners (domains/gjc-plugin/{probes,heldout}/run.ts) that speak
 * stdout-JSON receipts; they land with the engine milestone.
 */
import { DEFAULT_DIGEST_TARGETS } from "../../lib/isolate.mjs";

export const DOMAIN = Object.freeze({
  id: "gjc-plugin",
  root: ".",
  editable: [
    "jev-advisor/lib/decision.ts",
    "jev-advisor/src/*.adapter.ts",
    "verification-receipts/lib/**",
    "verification-receipts/src/*.adapter.ts",
  ],
  generated: [
    "jev-advisor/hooks/**",
    "jev-advisor/tools/**",
    "verification-receipts/tools/**",
    "ui-regression/tools/**",
  ],
  protectedPaths: [
    "**/tests/**",
    "**/scripts/verify.ts",
    "**/scripts/build.mjs",
    "package.json",
    "self-improve/**",
    "**/.gjc/**",
    "**/.env",
    "**/.env.*",
    "gjc-plugin.json",
    "**/gajae-plugin.json",
  ],
  criticRules: [
    {
      id: "critic_secret",
      reason: "secret-like assignment",
      pattern: "\\b(api[_-]?key|secret|token|password|credential)\\b\\s*[:=]",
      flags: "i",
    },
    {
      id: "critic_network",
      reason: "network or timer addition",
      pattern: "\\b(fetch\\s*\\(|https?://|setInterval\\s*\\(|setTimeout\\s*\\()",
      flags: "",
    },
    {
      id: "critic_fixture_hardcode",
      reason: "held-out fixture literal",
      pattern: "heldout|HELDOUT_",
      flags: "i",
    },
    {
      id: "critic_generated_edit",
      reason: "generated surface hand-edit",
      pattern: "^diff --git a/(jev-advisor/(hooks|tools)/|verification-receipts/tools/|ui-regression/tools/)",
      flags: "m",
    },
    {
      id: "critic_protected_edit",
      reason: "protected path edit",
      pattern: "^diff --git a/([^ ]*\\/tests\\/|[^ ]*\\/scripts\\/(verify|build)\\.|package\\.json|gjc-plugin\\.json)",
      flags: "m",
    },
  ],
  budget: [
    { maxFiles: 3, maxHunks: 12 },
    { maxFiles: 2, maxHunks: 8 },
    { maxFiles: 1, maxHunks: 4 },
  ],
  digestTargets: DEFAULT_DIGEST_TARGETS,
  guards: [
    { id: "build", kind: "command" },
    { id: "test", kind: "command" },
    { id: "validator", kind: "command" },
  ],
  smoke: [
    { id: "smoke-verification", args: ["--installed"], plugin: "verification-receipts" },
    { id: "smoke-advisor", args: ["--advisor"], plugin: "jev-advisor" },
    { id: "smoke-metrics", args: ["--metrics"], plugin: "jev-advisor" },
  ],
  probes: [],
  heldout: [],
});

export default DOMAIN;
