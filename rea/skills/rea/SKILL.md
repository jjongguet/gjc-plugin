---
name: rea
description: Route reverse-engineering work to the REA MCP tools (shipped binaries, Electron/JavaScript apps, web runtime evidence, HAR captures, APKs, firmware, WASM/EVM). Use when a claim depends on a shipped artifact or observed runtime behavior rather than repository source; do not use REA for ordinary source-repository analysis. Skip REA when the session has no rea tools and the user has not asked to set them up.
---

# REA — reverse-engineer anything (GJC integration)

Pinned surface: **rea-agents 6.4.0**, registered as the `rea` MCP server. The
authoritative capability list is the connected server's actual `tools/list`;
this skill only routes, records evidence and explains recovery. Adapted from
the morluto/rea workflow skill (MIT). REA runs locally and never uploads
targets or evidence.

## When to use REA

- A claim depends on a **shipped artifact** that source cannot answer: a native
  binary, an ASAR/Electron/JavaScript bundle, an APK, a firmware image, a .NET
  assembly, WASM or EVM bytecode.
- The task needs **runtime evidence** the source tree does not establish:
  website behavior, saved HAR or mitmproxy captures, process runs, Electron
  runtime state.
- The user asks how an app feature works, to compare versions, or to
  reconstruct behavior for reimplementation.

Skip REA for ordinary analysis of a complete source repository — use the
repository tools (read/search/find) instead, and do not run readiness or setup
steps before every investigation.

## Route the target first

| Target | First REA tool |
| --- | --- |
| Extracted JavaScript/Electron tree or ASAR | `analyze_javascript_application` |
| Local archive/package (ZIP/APK/IPA/MSIX/DMG) | `open_binary`, then `inspect_artifact` for inventory questions |
| APK code, classes, methods, references | `inspect_android_package` |
| .NET PE/CLI assembly | `inspect_managed_artifact` |
| Native binary (user-provided Hopper/Ghidra/IDA) | `open_binary`, then function/trace tools |
| Go binary metadata | `inspect_go_binary` |
| Website, open Electron app, open browser page | the browser/Electron discovery tools for the live target |
| Saved HAR / mitmproxy capture | `inspect_web_network_capture` |
| WASM, EVM bytecode, ELF layout, recorded crash | `inspect_wasm_artifact` / `inspect_evm_interface` / `inspect_binary_layout` / `inspect_recorded_crash` |

## Record evidence, not impressions

- Keep observations, derivations, inferences and unknowns separate; cite
  `evidence_id` values for every conclusion.
- Missing coverage is **unknown, not absence**; a limited or paginated read
  never becomes a negative claim.
- Static analysis never observed execution. Comparisons yield candidates, not
  causality.
- Runtime actions stay within the user's requested target and scope; the
  workspace authorization boundaries still apply.
- When a result exceeds transport limits, use the retained reference with
  `inspect_analysis_view` or `export_evidence_bundle` instead of repeating the
  producer.

## Connection and recovery

If the session has no REA tools:

1. Run `rea_readiness` (from the `rea` gjc-plugin) for an offline report:
   fetch channel, MCP registration, loose-skill state, remediation.
2. Register once, user scope:
   `gjc mcp add rea --timeout 60000 -- npx -y rea-agents@6.4.0 mcp`
   (the `--` separator is required because `-y` is not a `gjc` flag; the
   declared timeout keeps the npx-backed server inside the session startup
   window instead of the ~250ms default wait)
3. Restart GJC; MCP tools appear at session startup. A running session does
   not pick up a new registration.

Do not repeat setup when one blocker explains the failure (restart pending,
missing Node/Bun, missing engine). Deep native analysis additionally needs a
user-provided engine (Hopper on macOS, Ghidra or IDA otherwise); JavaScript,
web, HAR, .NET and Go targets need no engine.

Boundaries: only inspect targets the user owns or is authorized to inspect.
Installing or updating `rea-agents` is the operator's decision, not a step
this skill performs.
