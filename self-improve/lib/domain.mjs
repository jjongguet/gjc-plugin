/**
 * Domain adapter contract helpers: editable-surface glob matching and the hard
 * touched ⊆ surface ⊆ editable gate. Pure functions, no filesystem access.
 */

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}

export function matchesEditable(relPath, patterns) {
  const normalized = relPath.replaceAll("\\", "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function assertSurface({ touched, surface, editable }) {
  const offending = [];
  const surfaceSet = new Set(surface);
  for (const path of touched) {
    if (!surfaceSet.has(path)) offending.push({ path, violation: "touched_not_in_surface" });
  }
  for (const path of surface) {
    if (!matchesEditable(path, editable)) offending.push({ path, violation: "surface_outside_editable" });
  }
  return offending.length === 0
    ? { ok: true, reason: null, offending }
    : { ok: false, reason: "surface_violation", offending };
}

export function validateAdapterShape(adapter) {
  const required = [
    "id",
    "root",
    "editable",
    "generated",
    "protectedPaths",
    "criticRules",
    "budget",
    "probes",
    "heldout",
    "guards",
    "smoke",
  ];
  const arrayKeys = ["editable", "generated", "protectedPaths", "criticRules", "probes", "heldout", "guards", "smoke"];
  const missing = [];
  const wrongType = [];
  for (const key of required) {
    if (!(key in (adapter ?? {}))) missing.push(key);
  }
  for (const key of arrayKeys) {
    if (key in (adapter ?? {}) && !Array.isArray(adapter[key])) wrongType.push(key);
  }
  return { ok: missing.length === 0 && wrongType.length === 0, missing, wrongType };
}
