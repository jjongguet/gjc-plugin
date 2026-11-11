# `gjc plugin` CLI on 0.20.0 — observed contract

JJO-1609 reported three `gjc plugin` behaviours that made local plugin work misleading on 0.19.0:
`link` claimed success and never loaded, `install --dry-run` installed, and a refused bundle printed
one opaque error code. The 0.19.0 measurements stay in
[the 0.19.0 reproduction](gjc-0.19-plugin-cli-reproduction.md); this document records what 0.20.0
does with the same commands, because the troubleshooting table in the README describes the binary a
reader is actually running.

`node scripts/check-plugin-cli.mjs` re-observes every case below against the `gjc` on `PATH` and
fails when the contract moves. Run it before changing this document, and change both together.

## Environment

```sh
gjc --version                      # gjc/0.20.0
uname -sm                          # Darwin arm64
```

Every case runs in a throwaway `HOME`; the real `~/.gjc` is never written:

```sh
OWNED="$(mktemp -d)"
export HOME="$OWNED/home"
export GJC_CODING_AGENT_DIR="$HOME/.gjc/agent"
export GJC_AGENT_DIR="$HOME/.gjc/agent"
mkdir -p "$HOME" "$GJC_CODING_AGENT_DIR"
cd "$OWNED"
```

Two traps carry over from 0.19.0: `~` expands against the new `HOME`, so pass bundles as absolute
paths, and the CLI extracts its own native module to `$HOME/.gjc/natives/` on first use — that file
is the binary's, not plugin state, and must be excluded from any "did this write?" comparison.

## 1. `plugin link` — the plugin is now discoverable; its surfaces still do not run

```sh
mkdir -p "$OWNED/probe-hook"
printf '%s' '{"name":"jjo-probe-hook","version":"0.0.1","gjc":{"hooks":"hooks"}}' > "$OWNED/probe-hook/package.json"

gjc plugin link "$OWNED/probe-hook"        # ✔ Linked jjo-probe-hook from $OWNED/probe-hook
gjc plugin doctor
gjc plugin doctor --json
gjc plugin list --json
gjc plugin features jjo-probe-hook
cat "$HOME/.gjc/plugins/gjc-plugins.lock.json"
```

Observed on 0.20.0:

```text
✔ Linked jjo-probe-hook from $OWNED/probe-hook

Plugin Health Check

✔ plugins_directory: Found at $HOME/.gjc/plugins
⚠ package_manifest: Not created yet
✔ node_modules: Found
✔ plugin:jjo-probe-hook: v0.0.1

Summary: 3 ok, 1 warnings, 0 errors
```

`plugin list --json` carries the plugin under `npm`, `plugin doctor --json` reports
`plugin:jjo-probe-hook` with `status: "ok"`, `plugin features jjo-probe-hook` answers for it, and
the runtime lock records the discovery flag that every one of those consumers reads:

```json
{"plugins":{"jjo-probe-hook":{"version":"0.0.1","enabledFeatures":null,"enabled":true,"linked":true}},"settings":{}}
```

The 0.19.0 failure — `doctor` reporting `orphan:`, `list` omitting the package, and nothing behind
the success line — is fixed: the lock's `linked: true` record is what the single plugin enumerator
(`installedPluginNames`) reads, so `doctor`, `list`, `features` and the session loader share one
inventory. `package_manifest: Not created yet` stays a warning by design: `link` deliberately does
not create the plugins `package.json`.

**What still does not happen: the linked package contributes no session surface.** A probe package
that declares both a `tools/` and a `hooks/` directory was linked and then observed from two sides:
the tool module appends to a marker file when it is imported, and a local OpenAI-compatible endpoint
records the `tools` array of the session's model request.

```text
request tools: read, bash, edit, find, search, …, resolve        # no jjo_linked_probe
marker file:   absent after `gjc -p --no-session --no-mcp` and after an interactive start
```

That is not a `link` regression. The same package installed as a `file:` dependency (reproducing
the pre-0.19 installation shape with `bun install` in `~/.gjc/plugins`) behaves identically: its
tool module is never imported. The surfaces that do load in a 0.20.0 session are the ones a bundle
install registers in `$HOME/.gjc/agent/gjc-plugins/registry.json` — the control bundle's three tools
appear in the request's `tools` array while the linked package's tool does not.

**Impact.** `link` no longer lies about being installed or being visible to `doctor`/`list`, but a
linked npm-style package still has no effect on a running session. For hooks or tools that must run,
install the bundle: `gjc plugin install <bundle> --user`.

## 2. `install --dry-run` — no plugin state is written

Snapshot every file under the throwaway `HOME` (excluding `.gjc/natives/`) before and after the
command; run the dry-run once first so the binary's own native extraction is already done, then
compare bytes and hashes:

```sh
gjc plugin install "$OWNED/bundle" --user --dry-run      # warm-up: extracts .gjc/natives
BEFORE=$(snapshot)
gjc plugin install "$OWNED/bundle" --user --dry-run
gjc plugin install "$OWNED/bundle" --project --dry-run
AFTER=$(snapshot)
```

Observed on 0.20.0:

```text
[dry-run] Would install verification-receipts@0.0.11 (user)      # exit 0
[dry-run] Would install verification-receipts@0.0.11 (project)   # exit 0
BEFORE == AFTER                                                  # 0 files created, changed or removed
```

`$HOME/.gjc/agent/gjc-plugins` is absent afterwards and no `.gjc` appears in the project directory.
A second dry-run with the same arguments answers the same way instead of reporting "already
installed", which is the direct contradiction 0.19.0 produced.

**Control.** The observer detects writes: running the same install without `--dry-run` creates
`gjc-plugins/registry.json` plus the bundle's six files. The dry-run proof is therefore "nothing was
written", not "nothing was looked at".

## 3. A refused manifest names the field; `--json` still has no payload

Two bundles that differ in one hook field:

```sh
# A: {"kind":"gajae-code-plugin","name":"probe-extra-field","version":"0.0.1",
#     "hooks":[{"name":"probe-hook","event":"session_shutdown","path":"hooks/probe.ts","timeout":5}]}
# B: identical, canonical hook fields only

gjc plugin install "$OWNED/bundle-a" --user
gjc plugin install "$OWNED/bundle-a" --user --json
gjc plugin install "$OWNED/bundle-b" --user
```

Observed on 0.20.0 (stderr, exit 1):

```text
✘ Failed to install GJC bundle (unsupported_surface: Unsupported GJC plugin hook field "timeout" at <bundle>/gajae-plugin.json; supported fields are capabilities, event, filesystemRoots, name, networkDestinations, path, phase, sha256, target)
```

The diagnostic 0.19.0 dropped is restored: the offending field is named in quotes, the accepted set
is listed, and the manifest path is shortened to `<bundle>/…`. The canonical control installs
(`✔ installed GJC plugin probe-canonical@0.0.1 (user)`, exit 0).

**Known gap — `--json`.** On this failure path the flag produces no JSON: stdout is empty and the
human line above goes to stderr. `--json` is implemented for the success path
(`{"status":"installed",…}`), `plugin list --json` and `plugin doctor --json`, so the request in
JJO-1609 — `{code, message}` on failure — is still open upstream. Automation that needs the refusal
reason must parse the text line, or install without `--json` and read the exit code.

## Re-running this contract

```sh
node scripts/check-plugin-cli.mjs          # skips when no gjc is on PATH
```

The check links a probe package, snapshots the dry-run writes, drives the two refused/canonical
bundles, and starts one session against a local stub endpoint to compare bundle and linked tool
surfaces. It fails when any observed behaviour above changes, including when the two open gaps
close — that failure is the signal to rewrite this document and the README row together.

## Open upstream items

1. `plugin install --json` on the failure path: emit `{code, message}` and keep the exit code.
2. npm-style package surfaces: decide whether a linked (or dependency-installed) `package.json`
   plugin is meant to contribute tools/hooks to a session at all; today only bundle-registry
   surfaces load, while `link`'s success line implies otherwise.

## Limits of this document

- Only the three behaviours above were exercised. Field lists come from the refused-bundle
  diagnostic and were not each exercised.
- The session-surface observation used a local OpenAI-compatible stub as the model endpoint, so the
  evidence is the request the session sends, not a hosted provider's behaviour.
- Nothing here authorises a change to GJC core; the remaining gaps are upstream (`Yeachan-Heo/gajae-code`).
