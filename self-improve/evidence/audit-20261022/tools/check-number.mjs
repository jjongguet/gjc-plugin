#!/usr/bin/env node
/**
 * Phase-A audit helper: prove a documented literal appears in the implementation
 * file named by the claim row. Usage:
 *   node tools/check-number.mjs <carrier> <source> <literal>
 * Exits 0 when the literal appears in <source>, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [carrier, source, literal] = process.argv.slice(2);
if (!carrier || !source || !literal) {
  process.stderr.write("usage: check-number.mjs <carrier> <source> <literal>\n");
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const text = readFileSync(path.join(repoRoot, source), "utf8");
const exact = text.includes(literal);
// A numeric literal must stand as a whole number, not inside a longer one:
// "12" must not be satisfied by "128". Separators are ignored on both sides.
const normalized = literal.replace(/[,._]/g, "");
const bounded = new RegExp(`(?<![0-9])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(text.replace(/[,._]/g, ""));
const found = exact || bounded;
process.stdout.write(`${found ? "PASS" : "FAIL"} ${carrier} literal=${literal} source=${source}\n`);
process.exit(found ? 0 : 1);
