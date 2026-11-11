# egm

GJC integration for Google's [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) (EGM, Apache-2.0), pinned to **EGM v0.1.1** (`dea7761de06c`).

EGM is a design and review workflow: the **Elephant** (your long-context session) turns an idea into a brief and a design draft, and **Goldfish** reviewers (subagents that start without the earlier conversation) review the draft against EGM's document standards. You decide which trade-offs to take.

This plugin does **not** bundle EGM. GJC 0.20.0 installs EGM natively through its own marketplace path (skills, reviewer personas and document standards together), so EGM's text is never forked here. The plugin adds one tool:

- **`egm_readiness`** — read-only, offline readiness report: the `egm` marketplace registration and the commit its source checkout names, the user-scope `egm@egm` install, a sha256 comparison of all 27 runtime files (7 skills and their references, 10 reviewer personas, the document standards) with the pinned release, the namespaced skill invocations, and the session settings that can switch off marketplace skills, the `task` subagent tool or individual reviewer personas, with remediation. It accepts exactly `{}`, writes nothing, never fetches, installs or runs EGM, and never contacts the network.

## Install (once per machine)

```sh
# 1. The pinned EGM release, installed by GJC itself
git clone --depth 1 --branch v0.1.1 https://github.com/google/elephant-goldfish-model ~/.gjc-plugin/egm/elephant-goldfish-model-v0.1.1
gjc plugin marketplace add ~/.gjc-plugin/egm/elephant-goldfish-model-v0.1.1
gjc plugin install egm@egm

# 2. The readiness tool, from this checkout root
gjc plugin install ./egm --user
```

Start a **new** `gjc` session afterwards; skills, personas and tools load when a session starts. Ask it to run `egm_readiness` and expect `egm_readiness: ready` with `runtime files: pinned (27/27 match the pin)`.

Why a local checkout: `gjc plugin marketplace add <git URL>` clones the upstream default branch and takes no tag or commit, so it installs whatever `main` holds at that moment. Keep the checkout: a local marketplace is read in place when GJC upgrades or reinstalls from it. `egm_readiness` still works for a URL install; it then reports the marketplace as following the default branch and lists every runtime file that differs from v0.1.1 (`drifted`).

## Use

GJC registers marketplace skills under the plugin name, so every EGM skill is `egm:<skill>`:

| Command | What it does |
| --- | --- |
| `/skill:egm:egm-brainstorm <idea>` | Clarifying questions, a Goldfish review, then `concepts_brief.md` |
| `/skill:egm:egm-draft` | A design document drafted section by section from the brief: `design_draft.md` |
| `/skill:egm:egm-review design_draft.md` | The five-phase Goldfish review (Zoom Out → Comprehension → Critic → Zoom Out → Readiness) and its report |
| `/skill:egm:egm-review-loop` · `/skill:egm:egm-resolve` · `/skill:egm:egm-bootstrap` · `/skill:egm:egm-drift-report` | Automated review loop, resolving reviewer findings, directory READMEs, design-to-code drift |

The bare `/skill:egm-review` form (used by EGM's own docs for omp) is not a registered command in GJC; it is sent to the model as plain text. Where the skills write their files, and how to name another folder (`EGM artifact directory: <path>`), is described in EGM's [harness guide](https://github.com/google/elephant-goldfish-model/blob/v0.1.1/docs/harnesses.md#artifact-directory).

## How Goldfish reviewers run in GJC

- GJC loads the ten personas in EGM's `agents/` directory as named `task` agents (`egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-implementation-readiness`, …). The review skills spawn them by name through the `task` tool, which a session activates through tool search.
- A session without the `task` tool cannot run a Goldfish review, and EGM's review skills then stop instead of reviewing in the same context. That is the case when GJC is launched with a `--tools` list that omits `task` (tool search then cannot activate it) or when `task.maxRecursionDepth` is `0`.

### What is and is not isolated

Measured by `scripts/smoke-native.mjs`, which captures the subagent's model request byte for byte:

- **The parent conversation does not reach the reviewer.** A token placed only in the parent turn is absent from the subagent request.
- **Host instruction files do reach the reviewer.** The user `SYSTEM.md`, `RULES.md` and always-apply rules are part of the subagent's system prompt; the user and project `AGENTS.md` were not. A Goldfish review in GJC is therefore not zero-context. Keep stable workspace conventions in instruction files, and state every assumption the reviewers should challenge as an explicit review criterion in the request (EGM gives the same advice for Codex in its [harness guide](https://github.com/google/elephant-goldfish-model/blob/v0.1.1/docs/harnesses.md#delegation)).
- **Read-only is instructed, not enforced.** GJC registers EGM's canonical personas, which carry no tool allowlist, so reviewers get the default subagent tool set, including file edits and `bash`. The Claude Code adapters' `tools: [Read, Grep, Glob]` and `omitClaudeMd` settings are not used by GJC.

## What egm_readiness reports

| Status | Meaning |
| --- | --- |
| `ready` | `egm@egm` is installed in user scope, all 27 runtime files match v0.1.1, and the session settings were read and block nothing |
| `unverified` | As above, but the session settings could not be read, so nothing is known about the subagent path |
| `drifted` | Every runtime file is present but at least one differs from v0.1.1 (for example a URL install of a newer `main`) |
| `blocked` | A setting switches EGM off: `claude-plugins` in `disabledProviders`, `task.maxRecursionDepth: 0`, an EGM persona in `task.disabledAgents`, a `skill:egm:*` entry in `disabledExtensions`, or a disabled install entry |
| `incomplete` | A skill, persona, reference or document standard is missing or unreadable in the install |
| `not_installed` | No user-scope `egm@egm` entry (or GJC's plugin registry is unreadable) |

It reads `~/.gjc/marketplaces.json`, `~/.gjc/plugins/installed_plugins.json`, the installed files and the source checkout's `.git` files (no `git` process). It does not inspect project-scope installs, see launch flags such as `--tools`, prove that a review ran or judge review quality.

## Version pin and upgrades

The pin (`EGM_PINNED_TAG`, `EGM_PINNED_COMMIT`, and the digest table `EGM_PINNED_FILES` in `lib/readiness.ts`) changes only in a new plugin release: regenerate each digest with `git show <tag>:<path> | shasum -a 256`, update this README and the smoke, and run both suites. To move an install to a new pin:

```sh
gjc plugin uninstall egm@egm && gjc plugin marketplace remove egm
# then the three install commands above with the new tag
```

To remove everything: `gjc plugin uninstall egm@egm`, `gjc plugin marketplace remove egm`, `gjc plugin uninstall egm --user`, then delete the checkout under `~/.gjc-plugin/egm/`.

## Build and verify

```sh
bun scripts/build.mjs           # regenerate tools/egm-readiness.ts (keyless)
bun scripts/verify.ts           # hermetic offline suite (synthetic fixtures, isolated HOME, no network)
node scripts/smoke-native.mjs   # native install + isolation smoke in a throwaway GJC root
```

Repo root: `bun run build:egm`, `bun run test:egm`, `bun run egm:smoke`. The smoke needs `gjc` 0.20.0 or newer, `git` and network access to GitHub for the pinned clone; its model is a scripted endpoint on `127.0.0.1`, and it leaves your real GJC registries unchanged. It exits `2` when a prerequisite is missing.

## License and attribution

EGM is Google's work under the [Apache License 2.0](https://github.com/google/elephant-goldfish-model/blob/v0.1.1/LICENSE) and is not an officially supported Google product. This plugin redistributes none of its files: the digest table holds sha256 values only, and the smoke reads lines from the installed copy at run time. Changes to EGM itself belong upstream.
