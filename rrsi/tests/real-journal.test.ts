#!/usr/bin/env bun
/** Manual real-journal diagnostic, not a CI gate. Writes only to isolated HOME. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJournalRecords } from "../lib/rrsi";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realJournalDir = path.join(os.homedir(), ".gjc-plugin", "jev-advisor", "journal", "v1");

for (const periodic of [false, true]) {
  test(`real journal: ${periodic ? "periodic refresh and unchanged rerun" : "capture -> import -> dream"}`, async () => {
    const { records, segments } = readJournalRecords({ journalDir: realJournalDir });
    console.log(`measured real jev-advisor journal: segments=${segments} records=${records.length}`);
    expect(records.length >= 10).toBe(true);
    const slice = records.slice(-40);
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-real-")));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = path.join(home, ".gjc-plugin", "jev-advisor", "journal", "v1");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, "seg-1.jsonl"), `${slice.map((record) => JSON.stringify(record)).join("\n")}\n`);
      if (!periodic) {
        const fakePi = { typebox: { Type: { Object: (fields) => fields, String: (options) => options ?? {}, Optional: (schema) => schema } } };
        const tool = (await import(pathToFileURL(path.join(plugin, "tools/rrsi.ts")).href)).default(fakePi);
        const call = async (params) => JSON.parse((await tool.execute("real", params)).content[0].text);
        const imported = await call({ action: "import", limit: "40" });
        expect(imported.imported).toBe(slice.length);
        expect(imported.journal.status).toBe("ok");
        const captured = await call({ action: "capture", goal: "real-journal round trip", attempts: JSON.stringify([{ objective: "round-trip:adopt", decision: "adopt", wallMs: 5 }]) });
        expect(captured.counts.attempts).toBe(slice.length + 1);
        const dreamed = await call({ action: "dream", seed: "11" });
        expect(dreamed.corpusAttempts).toBe(slice.length + 1);
        expect(dreamed.policies).toBe(40);
        expect(typeof dreamed.summary.verdict).toBe("string");
        expect(dreamed.summary.receiptHash.length).toBe(64);
        expect((await call({ action: "dream", seed: "11" })).summary.receiptHash).toBe(dreamed.summary.receiptHash);
      } else {
        const hook = await import(pathToFileURL(path.join(plugin, "hooks/rrsi-periodic.ts")).href);
        const root = path.join(home, ".gjc-plugin", "rrsi");
        const first = await hook.runPeriodic({ env: process.env, mode: "inline" });
        expect(first.status).toBe("ran");
        expect(first.storeWrite).toBe("added");
        const receipts = path.join(root, "runs", "v1");
        const files = readdirSync(receipts);
        expect(files.length).toBe(1);
        const receiptA = JSON.parse(readFileSync(path.join(receipts, files[0]), "utf8"));
        expect(receiptA.projectionDigest.length).toBe(64);
        expect(typeof receiptA.receiptHash).toBe("string");
        const storePath = path.join(root, "store.json");
        const bytes = readFileSync(storePath, "utf8");
        const store = JSON.parse(bytes);
        expect(store.episodes.filter((episode) => episode.source === "jev-journal").length).toBe(1);
        expect(store.episodes.filter((episode) => episode.id.startsWith("ep-jev-")).length).toBe(1);
        const statePath = path.join(root, "periodic.json");
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        state.lastAttemptAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        state.nextRetryAt = null;
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
        expect((await hook.runPeriodic({ env: process.env, mode: "inline" })).status).toBe("unchanged");
        expect(readFileSync(storePath, "utf8")).toBe(bytes);
        const later = readdirSync(receipts).filter((file) => !files.includes(file));
        expect(later.length).toBe(1);
        const receiptB = JSON.parse(readFileSync(path.join(receipts, later[0]), "utf8"));
        expect(receiptB.projectionDigest).toBe(receiptA.projectionDigest);
        expect(receiptB.receiptHash).toBe(receiptA.receiptHash);
      }
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
}
