import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TIERS = ["fast", "balanced", "strong"];
const MAX_RESPONSE_BYTES = 64 * 1024;

function readJson(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8"));
}

const probes = readJson("self-improve/domains/gjc-plugin/probes/fixtures.json");
const heldout = readJson("self-improve/domains/gjc-plugin/heldout/fixtures.json");

test("decision_accuracy fixtures keep a valid shape and a real case denominator", () => {
  for (const [name, fixtures] of [["probes", probes], ["heldout", heldout]]) {
    for (const metric of ["extract_coverage", "decision_accuracy", "egress_boundary"]) {
      assert.ok(Array.isArray(fixtures.cases[metric]) && fixtures.cases[metric].length > 0, `${name}.${metric}`);
    }
    for (const item of fixtures.cases.decision_accuracy) {
      assert.equal(typeof item.raw, "string");
      assert.ok(item.confidenceKind === "self_reported" || item.confidenceKind === "provider_choice");
      assert.equal(typeof item.expected.accept, "boolean");
      if (item.expected.accept) assert.ok(TIERS.includes(item.expected.tier), "accepted cases must pin a tier");
      else assert.equal(item.expected.tier, undefined);
    }
  }
  assert.ok(probes.cases.decision_accuracy.length >= 16);
});

test("provenance-sourced headroom cases name their documented source and clusters", () => {
  const provenanceCases = probes.cases.decision_accuracy.filter((item) => item.provenance !== undefined);
  assert.ok(provenanceCases.length >= 5, "headroom cases must carry provenance");
  const clusters = new Set();
  for (const item of provenanceCases) {
    const { source, statement, cluster, note } = item.provenance;
    for (const [key, value] of Object.entries({ source, statement, cluster, note })) {
      assert.ok(typeof value === "string" && value.length > 0, `provenance.${key} required`);
    }
    assert.match(item.provenance.source, /jev-advisor\//, "provenance must name a plugin spec document or source line");
    clusters.add(cluster);
  }
  assert.ok(clusters.size >= 2, "at least two independent gap clusters must be sourced");
  const heldoutClusters = new Set(heldout.cases.decision_accuracy.map((item) => item.parallelOf).filter(Boolean));
  for (const cluster of clusters) {
    assert.ok(heldoutClusters.has(cluster), `cluster ${cluster} needs a held-out parallel`);
  }
});

test("cluster 1 cases sit exactly on the documented probability-sum tolerance boundary", () => {
  const boundaryCases = probes.cases.decision_accuracy.filter(
    (item) => item.provenance?.cluster === "probability-sum-tolerance-boundary",
  );
  assert.ok(boundaryCases.length >= 4);
  for (const item of boundaryCases) {
    const parsed = JSON.parse(item.raw);
    const probabilities = parsed.probabilities;
    assert.deepEqual(Object.keys(probabilities).sort(), [...TIERS].sort());
    const scaled = TIERS.reduce((total, tier) => total + Math.round(probabilities[tier] * 1e6), 0);
    assert.equal(Math.abs(scaled - 1e6), 1000, `${item.raw} must sit exactly at |sum-1| == 0.001 (decimal)`);
    assert.equal(item.expected.accept, true, "the documented tolerance is inclusive");
  }
  const heldoutBoundary = heldout.cases.decision_accuracy.filter(
    (item) => item.parallelOf === "probability-sum-tolerance-boundary",
  );
  assert.ok(heldoutBoundary.length >= 4);
});

test("cluster 2 cases pin both sides of the documented 64 KiB response cap", () => {
  const capCases = probes.cases.decision_accuracy.filter(
    (item) => item.provenance?.cluster === "response-size-cap-at-exported-parser",
  );
  assert.ok(capCases.length >= 2);
  const sized = capCases.map((item) => ({ bytes: Buffer.byteLength(item.raw), accept: item.expected.accept }));
  assert.ok(sized.some((row) => row.bytes === MAX_RESPONSE_BYTES && row.accept === true), "at-cap reply must stay accepted");
  assert.ok(sized.some((row) => row.bytes > MAX_RESPONSE_BYTES && row.accept === false), "over-cap reply must be rejected");
  const heldoutCap = heldout.cases.decision_accuracy.filter(
    (item) => item.parallelOf === "response-size-cap-at-exported-parser",
  );
  assert.ok(heldoutCap.length >= 1);
  assert.ok(Buffer.byteLength(heldoutCap[0].raw) > MAX_RESPONSE_BYTES);
});
