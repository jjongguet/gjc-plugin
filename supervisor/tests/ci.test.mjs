import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { aggregateCheckRuns, createCiResolver, parseRepoSlug } from "../lib/ci.mjs";
import { NOW } from "./helpers.mjs";

const tempCache = () => path.join(mkdtempSync(path.join(os.tmpdir(), "supervisor-ci-")), "ci-cache.json");
const session = (overrides = {}) => ({
  remote: "https://github.com/jjongguet/gjc-plugin.git",
  sha: "abc123",
  ...overrides,
});

test("repository slugs come only from GitHub remotes", () => {
  assert.equal(parseRepoSlug("https://github.com/jjongguet/gjc-plugin.git"), "jjongguet/gjc-plugin");
  assert.equal(parseRepoSlug("git@github.com:jjongguet/gjc-plugin.git"), "jjongguet/gjc-plugin");
  assert.equal(parseRepoSlug("ssh://git@github.com/jjongguet/gjc-plugin.git"), "jjongguet/gjc-plugin");
  assert.equal(parseRepoSlug("https://gitlab.com/a/b.git"), null);
  assert.equal(parseRepoSlug(""), null);
});

test("check-run aggregation never turns an empty or failing set into success", () => {
  assert.equal(aggregateCheckRuns({ check_runs: [] }).state, "unknown");
  assert.equal(aggregateCheckRuns({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }).state, "failure");
  assert.equal(aggregateCheckRuns({ check_runs: [{ name: "ci", status: "in_progress", conclusion: null }] }).state, "pending");
  assert.equal(aggregateCheckRuns({ check_runs: [{ name: "ci", status: "completed", conclusion: "skipped" }] }).state, "unknown");
  assert.equal(aggregateCheckRuns({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }).state, "success");
});

test("a resolved HEAD is cached so a ten minute loop does not re-spend the quota", async () => {
  const cacheFile = tempCache();
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) };
    };
    const resolver = await createCiResolver({ fetchImpl, cacheFile, now: NOW, token: "" });
    const first = await resolver.resolve(session());
    const second = await resolver.resolve(session());
    assert.equal(first.state, "success");
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    await resolver.flush();
    const reopened = await createCiResolver({ fetchImpl, cacheFile, now: NOW + 60_000, token: "" });
    assert.equal((await reopened.resolve(session())).cached, true);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test("private or missing repositories and the lookup cap are explicit states", async () => {
  const cacheFile = tempCache();
  try {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const resolver = await createCiResolver({ fetchImpl, cacheFile, now: NOW, token: "" });
    assert.deepEqual(await resolver.resolve(session()), { state: "unavailable", detail: "private_or_missing" });
    const capped = await createCiResolver({ fetchImpl, cacheFile: tempCache(), now: NOW, token: "", maxLookups: 1 });
    await capped.resolve(session({ sha: "one" }));
    assert.deepEqual(await capped.resolve(session({ sha: "two" })), { state: "deferred", detail: "lookup_cap" });
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test("a rate limit is recorded, not retried inside the run", async () => {
  const cacheFile = tempCache();
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: false, status: 429 };
    };
    const resolver = await createCiResolver({ fetchImpl, cacheFile, now: NOW, token: "" });
    assert.equal((await resolver.resolve(session())).detail, "rate_limited");
    assert.equal((await resolver.resolve(session())).detail, "rate_limited");
    assert.equal(calls, 1);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});
