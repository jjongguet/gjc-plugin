---
name: rea
description: Route reverse-engineering work to the pinned REA CLI (`npx -y rea-agents@6.4.0`, no MCP registration needed) for shipped artifacts and observed runtime behavior — native binaries, Electron/JavaScript apps, web runtime evidence, HAR captures, APKs, firmware, WASM/EVM. Use when a claim depends on a shipped artifact rather than repository source; do not use REA for ordinary source-repository analysis.
---

# REA — reverse-engineer anything (GJC integration, CLI-first)

Pinned surface: **rea-agents 6.4.0**, invoked as a CLI through the shell. No
MCP registration is needed or expected; the MCP server remains an optional
mode (see below) because it loads ~170 tool schemas into every session's
context. Adapted from the morluto/rea workflow skill (MIT). REA runs locally
and never uploads targets or evidence.

## Invoke

```sh
npx -y rea-agents@6.4.0 <command> [args] [flags]
```

- The pinned package is fetched once into the npx cache; later calls start fast.
- Every call is **stateless**: pass the target path, address, endpoint or
  serial per command. There is no `open_binary` session — for inventory or
  overview questions call `inspect-artifact <path>`, `inspect <path>` or
  `analyze <path>` directly.
- Discover the command surface instead of guessing: `rea --llms` (compact
  one-line-per-command manifest), `rea --llms-full`, `rea <command> --help`,
  `rea <command> --schema` (argument contract).
- Budget output before it floods context: `--token-count` (size only),
  `--token-limit <n>`, `--token-offset <n>`, `--filter-output <keys>`,
  `--format toon|json|md|jsonl`.
- Long-running captures (browser, process, LLDB) stay bounded by the
  command's own options; keep them inside the user's requested target.

## When to use REA

- A claim depends on a **shipped artifact** that source cannot answer: a
  native binary, an ASAR/Electron/JavaScript bundle, an APK, a firmware
  image, a .NET assembly, WASM or EVM bytecode, a recorded crash core.
- The task needs **runtime evidence** the source tree does not establish:
  website behavior, saved HAR or mitmproxy captures, process runs, Electron
  runtime state, adb device state.
- The user asks how an app feature works, to compare versions, or to
  reconstruct behavior for reimplementation.

Skip REA for ordinary analysis of an accessible source repository — use the
repository tools (read/search/find) instead, and do not run readiness or
setup steps before every investigation.

## Route the target first

| Target | First command |
| --- | --- |
| Extracted JavaScript/Electron tree or ASAR | `analyze-javascript-application <path>` |
| Local archive/package (ZIP/APK/IPA/MSIX/AppX/DMG) | `inspect-artifact <path>`; `extract-artifact <path>` when extraction is requested |
| APK code, classes, methods, references | `inspect-android-package`, then `inspect-android-class` / `inspect-android-method` / `trace-android-references` |
| APK manifest and string resources | `decode-android-resources <path>` |
| .NET PE/CLI assembly | `inspect-managed-artifact`, then `inspect-managed-members` / `inspect-managed-native-boundaries` |
| Native binary (user-provided Hopper/Ghidra/IDA) | `analyze <path>` / `inspect <path>`, then `function` / `decompile` / `xrefs` / `search` / `trace-native-values` / `instructions` |
| Mach-O and Apple bundles | `inspect-macho`, `trace-dylib-resolution`, `decode-interface-builder`, `inspect-asset-catalog`, `inspect-signature`, `demangle-swift` |
| Website, open Electron page, browser page | `list-browser-targets` / `list-electron-targets`, `inspect-web-page`, `analyze-web-bundle`, `capture-browser-scenario`, `observe-web-execution` / `observe-web-session` |
| Saved HAR or mitmproxy capture | `inspect-web-network-capture <capturePath> <format>` |
| EVM bytecode, binary layout, firmware, crash core | `inspect-evm-interface` / `inspect-binary-layout` / `inspect-firmware-regions` (+ `extract-firmware`) / `inspect-recorded-crash` |
| Android device state and files | `list-adb-devices`, `inspect-adb-device`, `pull-adb-package`, `read-adb-logcat`, `capture-adb-screen` |
| JEB project | `open-jeb-project`, `list-jeb-units`, `decompile-jeb-item` |

## Record evidence, not impressions

- Results carry inline **Evidence**; keep observations, derivations,
  inferences and unknowns separate and cite evidence ids for every
  conclusion.
- Missing coverage is **unknown, not absence**; a limited or paginated read
  never becomes a negative claim.
- Static analysis never observed execution. Comparisons (`compare`,
  `compare-*`) yield candidates, not causality.
- Follow up on large results with `inspect-analysis-view <inputJson>` or
  `inspect-evidence-bundle <inputJson>`, and move bundles between machines
  with `evidence-export` / `evidence-import`, instead of repeating the
  producer.
- Runtime actions stay within the user's requested target and scope; the
  workspace authorization boundaries still apply.

## Readiness and recovery

1. `rea_readiness` (from the `rea` gjc-plugin) gives the offline report:
   runtimes and REA engine fit, the pinned CLI, skill state and remediation.
2. Probe the installation with `npx -y rea-agents@6.4.0 --version` (the
   pinned fetch takes ~1s once cached) and list configured engines with
   `providers` / `capabilities`. `doctor` audits REA's own MCP registrations
   across agent clients and emits a large report; in CLI-first mode its
   registration-drift findings are expected — do not run `rea setup` to
   satisfy it unless the operator wants those clients registered.
3. If `npx`/`bunx` is missing or Node falls outside ^22.19 || ^24.11 || >=26,
   fix the runtime before retrying.
4. Deep native analysis additionally needs a user-provided engine (Hopper on
   macOS, Ghidra or IDA otherwise); JavaScript, web, HAR, .NET, firmware and
   Android targets need no engine.
5. Do not repeat setup when one blocker explains the failure. Installing
   engines, updating `rea-agents` or reconfiguring the host remains the
   operator's decision, not a step this skill performs.

## Optional: MCP mode

Sessions that genuinely need the stateful MCP surface (a retained active
target, MCP prompts, Hopper GUI navigation tools) can register the server:

```sh
gjc mcp add rea --timeout 60000 -- npx -y rea-agents@6.4.0 mcp
```

The `--` separator and the declared timeout are required (plain `-y` is not a
`gjc` flag; without a timeout, sessions wait only ~250ms and an npx-backed
server cannot settle). Registration exposes every REA tool schema in each new
session — GJC 0.18.5 does not hide tools of conventionally registered
servers — so keep it only while that mode is used, and restart GJC after any
change; a running session does not pick up new tools.

Boundaries: only inspect targets the user owns or is authorized to inspect.
