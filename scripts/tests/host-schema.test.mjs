/**
 * Host-schema guard: no advertised parameter may carry a keyword the GJC host
 * validates before the plugin runs.
 *
 * A host rejection happens outside the plugin, so the plugin cannot answer it, and
 * the measured host error quotes the caller's whole argument object (JJO-1107).
 * Every bound this repository advertises was already re-enforced in-plugin, so the
 * wire copy bought nothing and cost the echo. This test is the tripwire: adding a
 * rejectable keyword back to any parameter — or to a manifest's static schema,
 * which overrides the adapter — fails here.
 *
 * Two shapes are advertised: the adapter parameters are built from the host's
 * TypeBox, and a manifest's static `schema` is plain JSON Schema. The adapter case is
 * read through a recording stub and converted to the JSON Schema view, so both cases
 * are judged by the one walker the host-side smoke also uses.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rejectableConstraints } from "../../verification-receipts/scripts/smoke-environment.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// One recording stub per constructor: each node keeps its constructor name and raw
// arguments, so the conversion below sees exactly what the adapter asked for.
const Type = new Proxy({}, { get: (_target, name) => (...args) => ({ kind: String(name), args }) });

/** Recording-stub node tree -> the JSON Schema view the host would advertise. */
function toSchema(node) {
  if (Array.isArray(node)) return node.map(toSchema);
  if (!node || typeof node !== "object") return node;
  // A real TypeBox schema is already plain JSON Schema and has no `kind`.
  if (!node.kind) return node;
  const [first, second] = node.args ?? [];
  const options = second && typeof second === "object" ? second : {};
  switch (node.kind) {
    case "Object": {
      // TypeBox derives `required` from the fields that are not wrapped in Optional, so the
      // recording stub has to reproduce that: an absent required member is a host rejection.
      const fields = Object.entries(first ?? {});
      // TypeBox always emits the list, empty included, so the view must too; the walker only
      // reports a non-empty one, because an empty list cannot reject anything.
      const required = fields.filter(([, value]) => value?.kind !== "Optional").map(([key]) => key);
      return { type: "object", properties: Object.fromEntries(fields.map(([key, value]) => [key, toSchema(value)])), required, ...options };
    }
    case "Array":
      return { type: "array", items: toSchema(first), ...options };
    case "Optional":
      return toSchema(first);
    case "Union":
      return { anyOf: (first ?? []).map(toSchema), ...(options.description === undefined ? {} : { description: options.description }) };
    case "Literal":
      return { const: first };
    default:
      return { type: String(node.kind).toLowerCase(), ...(first && typeof first === "object" && !Array.isArray(first) ? first : {}) };
  }
}

function parametersOf(module, name) {
  const factory = module[name];
  expect(typeof factory, name).toBe("function");
  const tool = factory({ cwd: ROOT, typebox: { Type } });
  expect(tool.name, name).toBeTruthy();
  return { name: tool.name, parameters: tool.parameters };
}

const ADAPTERS = [
  "aside-memory/src/memory.adapter.ts",
  "backplan/src/check.adapter.ts",
  "jev-advisor/src/check.adapter.ts",
  "jev-advisor/src/metrics.adapter.ts",
  "jev-advisor/src/tool.adapter.ts",
  "rea/src/readiness.adapter.ts",
  "rrsi/src/rrsi.adapter.ts",
  "ui-regression/src/run.adapter.ts",
  "ui-regression/src/status.adapter.ts",
  "verification-receipts/src/loop.adapter.ts",
  "verification-receipts/src/run.adapter.ts",
  "verification-receipts/src/status.adapter.ts",
  "wiki/src/propose.adapter.ts",
  "wiki/src/query.adapter.ts",
];

// Tools whose adapter declares no parameters at all.
const NO_ARGUMENT_TOOLS = new Set(["plugin_metrics", "rea_readiness"]);

const PLUGINS = ["aside-memory", "backplan", "jev-advisor", "rea", "rrsi", "ui-regression", "verification-receipts", "wiki"];

for (const relative of ADAPTERS) {
  test(`${relative} advertises no host-rejectable parameter keyword`, async () => {
    const module = await import(path.join(ROOT, relative));
    const { name, parameters } = parametersOf(module, "default");
    expect(parameters, `${relative} declares parameters`).toBeTruthy();
    const schema = toSchema(parameters);
    // Exactly these two tools take no arguments; an empty view anywhere else means the
    // conversion broke and the assertion below stopped looking at anything.
    const fields = Object.keys(schema.properties ?? {}).length;
    expect(fields === 0, `${relative} field count`).toBe(NO_ARGUMENT_TOOLS.has(name));
    expect(rejectableConstraints(schema, "parameters"), name).toEqual([]);
  });
}

// A manifest's static `schema` overrides whatever the adapter declares (two tools use
// it because the installer's static extraction cannot read their parameters), so it is
// a separate advertisement and needs the same guard.
for (const plugin of PLUGINS) {
  test(`${plugin} manifest declares no host-rejectable static schema`, () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, plugin, "gajae-plugin.json"), "utf8"));
    expect(Array.isArray(manifest.tools ?? []), `${plugin} tools`).toBe(true);
    for (const tool of (manifest.tools ?? []).filter((entry) => entry.schema !== undefined)) {
      expect(rejectableConstraints(tool.schema, "parameters"), `${plugin}/${tool.name}`).toEqual([]);
    }
  });
}
