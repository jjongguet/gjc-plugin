# `gjc plugin` CLI defects reproduced on 0.19.0

Three `gjc plugin` CLI behaviours make local plugin work misleading, and one of them hides the only
information needed to fix the failure. All of them live in GJC core, not in this repository: the
decisions are taken by `gjc`'s own manifest parser, loader and installer, and none of those modules
is reachable from a plugin bundle. This document records the commands, the observed output and the
discriminator for each, so the defects can be fixed upstream or worked around knowingly. Nothing in
this repository can patch them; what this repository can do is stay inside what the runtime
preserves (see [What a bundle may declare](#what-a-bundle-may-declare)).

Every run below used a throwaway `HOME`; the real `~/.gjc` was never written to.

## Environment

```sh
gjc --version                      # gjc/0.19.0
uname -sm                          # Darwin arm64
```

Isolated run recipe (each defect starts from a fresh directory):

```sh
OWNED="$(mktemp -d)"
export HOME="$OWNED/home"
export GJC_CODING_AGENT_DIR="$HOME/.gjc/agent"
export GJC_AGENT_DIR="$HOME/.gjc/agent"
mkdir -p "$HOME" "$GJC_CODING_AGENT_DIR"
cd "$OWNED"
```

Two traps when reproducing: a `~` path expands against the new `HOME`, so pass the bundle as an
absolute path, and `gjc plugin install <path>` refuses a relative bundle that does not exist with
`missing_file`, which looks like a manifest defect but is a bad path.

## Defect 1 — `gjc plugin link` reports success and never loads the plugin

```sh
mkdir -p "$OWNED/probe-hook/hooks"
printf '%s' '{"name":"jjo-probe-hook","version":"0.0.1","gjc":{"hooks":"hooks"}}' > "$OWNED/probe-hook/package.json"
printf '%s\n' 'export default async function probe() { return undefined; }' > "$OWNED/probe-hook/hooks/probe.ts"

gjc plugin link "$OWNED/probe-hook"
gjc plugin doctor
gjc plugin list
ls -A "$HOME/.gjc/plugins"
```

Observed:

```text
✔ Linked jjo-probe-hook from $OWNED/probe-hook
                                                 # exit 0

Plugin Health Check

✔ plugins_directory: Found at $HOME/.gjc/plugins
⚠ package_manifest: Not created yet
✔ node_modules: Found

Summary: 2 ok, 1 warnings, 0 errors

No plugins installed

Install plugins with: gjc plugin install <package>

gjc-plugins.lock.json
node_modules
```

`$HOME/.gjc/plugins/node_modules/jjo-probe-hook` is a symlink to the source directory, and
`gjc-plugins.lock.json` records it:

```json
{"plugins":{"jjo-probe-hook":{"version":"0.0.1","enabledFeatures":null,"enabled":true}},"settings":{}}
```

`$HOME/.gjc/agent/gjc-plugins/registry.json` is **absent**: the bundle runtime has no entry to read,
so no hook from a linked package can fire.

**Discriminator.** `link` writes two things — a `node_modules` symlink and a lock entry — and none of
the three things the load paths read: `$HOME/.gjc/plugins/package.json` (`package_manifest: Not
created yet`, the file whose `dependencies` are enumerated), the plugin's own entry in that file, and
the bundle registry at `$HOME/.gjc/agent/gjc-plugins/registry.json`. A linked plugin therefore fails
`doctor`, is missing from `list`, and cannot be loaded by either runtime. `gjc plugin enable` does not
change this (recorded in JJO-1389).

## Defect 2 — `gjc plugin install --dry-run` installs

```sh
gjc plugin install "$OWNED/bundle" --user --dry-run       # $OWNED/bundle: any valid bundle
ls -A "$HOME/.gjc/agent/gjc-plugins"
gjc plugin install "$OWNED/bundle" --user --dry-run       # second time
```

Observed (bundle from this repository, `verification-receipts`):

```text
✔ installed GJC plugin verification-receipts@0.0.11 (user)
                                                 # exit 0

registry.json
verification-receipts

✘ GJC bundle "verification-receipts" is already installed in the user scope
  Try: gjc plugin upgrade verification-receipts --user
                                                 # exit 3
```

`registry.json` gained a full entry with `installedAt`, `updatedAt`, `copiedFiles[]` and
`source.kind: "path"`, and the bundle was copied into
`$HOME/.gjc/agent/gjc-plugins/verification-receipts`.

**Discriminator.** The same verb with the same arguments writes state on the first call and then
refuses the second call *because the first one wrote state*. `--dry-run` is advertised in
`gjc plugin --help` and is not consulted by the bundle-install path.

**Impact.** Any automation or pre-flight check that uses `--dry-run` to ask "would this install?"
mutates the installation it was asked to inspect, and a subsequent real install must first uninstall.

## Defect 3 — a bundle the runtime cannot preserve fails with one opaque code

Two manifests that differ in one hook field:

```sh
# A: one extra hook field the bundle runtime cannot preserve
#    {"kind":"gajae-code-plugin","name":"with-extra-field","version":"0.0.1",
#     "hooks":[{"name":"probe-hook","event":"session_shutdown","path":"hooks/probe.ts","timeout":5}]}

# B: identical bundle, canonical hook fields only
#    {"kind":"gajae-code-plugin","name":"canonical-only","version":"0.0.1",
#     "hooks":[{"name":"probe-hook","event":"session_shutdown","path":"hooks/probe.ts"}]}

gjc plugin install "$OWNED/with-extra-field" --user
gjc plugin install "$OWNED/canonical-only" --user
```

Observed:

```text
✘ Failed to install GJC bundle (unsupported_surface)
                                                 # exit 1, nothing installed

✔ installed GJC plugin canonical-only@0.0.1 (user)
                                                 # exit 0
```

**Discriminator.** The two bundles are byte-identical apart from the added field, one file each,
installed in the same `HOME` seconds apart. The decision is taken before any file is written, by the
manifest parser.

**The dropped diagnostic.** The parser raises a message that names the offending field and lists the
supported ones; the CLI prints only `err.code`. The message is present in the shipped installer — it
is the string the parser holds, not output the CLI ever shows:

```text
Unsupported GJC plugin hook field "timeout" at <manifest>; supported fields are
capabilities, event, name, path, phase, sha256, target
```

So a user with `unsupported_surface` reads one word and cannot learn which field, or what the
canonical set is, without reading the binary. Reported in JJO-1609/JJO-1389; the diagnostic path is
upstream.

## What a bundle may declare

The canonical GJC bundle manifest is the only shape the runtime preserves end to end. Everything
below was read from the 0.19.0 installer's own validation strings; only the manifest shapes were
exercised by the reproductions above.

- Top level: `kind: "gajae-code-plugin"`, `name`, `version`, and the surfaces `tools`, `hooks`,
  `mcps`/`mcpServers`, `skills`.
- Tool entry: `name`, `path`, `description`, `sha256`, and a schema through `schema`, `inputSchema`,
  `input_schema`, `parameters` or `schemaPath`/`schema_path`.
- Hook entry: `name`, `event`, `target` (`*` or a tool name), `phase` (`before`/`after`), `path`,
  `sha256`, `capabilities`. Any other field is `unsupported_surface`. `target`/`phase` belong to
  `tool_call`/`tool_result` events; session events omit them.
- A hook entry shaped like a Claude Code `plugin.json` (`{ matcher, hooks, source }`) is refused with
  `invalid_manifest` and an explanatory message.
- Each `mcpServers[name]` may only use the keys the bundle runtime preserves; any other key is
  `unsupported_surface`.

This repository's eight plugin manifests already use only canonical fields, which is why they install
on 0.19.0 while a Claude-Code-shaped or extended manifest does not.

## Upstream requests

1. `plugin link`: register the linked package where the loaders actually look — add it to
   `$HOME/.gjc/plugins/package.json` `dependencies` and/or write the bundle
   `registry.json` entry (`source.kind: "local-link"`), and make `doctor` accept it.
2. `plugin install --dry-run`: parse and validate only; write no bundle directory, no registry entry
   and no `installedAt`.
3. `plugin install` (bundle path): surface the parser message with the manifest path shortened to the
   bundle-relative path, and emit `{code, message}` under `--json`; keep the exit code.
4. `plugin install`: when validation fails, leave no partial state (a failed install currently cannot
   be distinguished from a successful one by directory presence alone).
5. Host validation error policy, reported separately from the CLI: a rejected tool call currently
   returns the caller's whole argument object, with both a value/bound violation and an absent
   required member (measured: `verification_status` called with `{}` answered
   `Validation failed for tool "verification_status": - receiptId: Invalid input …` followed by
   `Received arguments: {}`). The plugin side is closed — no advertised parameter carries a
   host-rejectable keyword or a non-empty `required` list (`scripts/tests/host-schema.test.mjs`
   guards every adapter and manifest) — so the remaining path is a value of the wrong JSON type,
   which `type` must still reject. Prefer returning the offending field name alone.

## Limits of this document

- Only the four behaviours above were exercised at runtime. The "supported fields" lists come from
  the installed binary's validation strings and were not each exercised.
- Nothing here proves the maintainers intend `link` or `--dry-run` to work differently; it records
  what 0.19.0 does with the commands it advertises.
- No upstream patch is included. The fix belongs to GJC core (`Yeachan-Heo/gajae-code`).
