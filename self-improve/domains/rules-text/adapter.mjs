/**
 * Second domain adapter: rule-text surfaces.
 *
 * Target: docs/portfolio/AGENTS.md — the tracked in-repo canonical rules-text
 * surface. The deterministic probe (probes/run.ts) scores structural contracts
 * over the target markdown in the baseline/candidate dirs: rule-text integrity,
 * not behavioral effect (no model, no network, no significance claim).
 *
 * Guards and smoke entries are declared for contract parity only:
 * buildGuardPlan is hardcoded and does not read adapter.guards today.
 */
import { DEFAULT_DIGEST_TARGETS } from "../../lib/isolate.mjs";

export const RULES_TEXT_TARGETS = Object.freeze(["docs/portfolio/AGENTS.md"]);

export const DOMAIN = Object.freeze({
  id: "rules-text",
  root: ".",
  editable: RULES_TEXT_TARGETS,
  textFixtures: RULES_TEXT_TARGETS,
  generated: [],
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
      // Prose-safe variant: URLs are legitimate rule-text content (link
      // coverage is scored), so only executable network/timer patterns block.
      pattern: "\\b(fetch\\s*\\(|setInterval\\s*\\(|setTimeout\\s*\\()",
      flags: "",
    },
    {
      id: "critic_fixture_hardcode",
      reason: "held-out fixture literal",
      pattern: "heldout|HELDOUT_",
      flags: "i",
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
    { id: "smoke-loop", args: ["--loop"], plugin: "verification-receipts" },
    { id: "smoke-advisor", args: ["--advisor"], plugin: "jev-advisor" },
    { id: "smoke-metrics", args: ["--metrics"], plugin: "jev-advisor" },
  ],
  probes: [
    { id: "rule_text_integrity", objective: "probe.rule_text_integrity", runner: "domains/rules-text/probes/run.ts" },
    { id: "link_coverage", objective: "probe.rule_link_coverage", runner: "domains/rules-text/probes/run.ts" },
  ],
  heldout: [
    { id: "heldout_rule_text", objective: "probe.heldout_rule_text", runner: "domains/rules-text/probes/run.ts" },
  ],
  objectives: ["probe.rule_text_integrity", "probe.rule_link_coverage"],
});

export default DOMAIN;
