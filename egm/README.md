# egm

GJC integration for Google's [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) (EGM, Apache-2.0), pinned to **EGM v0.1.1** (`dea7761de06c`).

EGM is a design and review workflow: the **Elephant** (your long-context session) turns an idea into a brief and a design draft, and **Goldfish** reviewers (subagents that start without the earlier conversation) review the draft against EGM's document standards. You decide which trade-offs to take.

This plugin does **not** bundle or fork EGM. One command installs the pinned release into GJC's loose user surfaces and registers the `egm_readiness` bundle, because GJC plugin bundles cannot declare `skills` or `agents`:

| Written path (below the GJC agent directory) | Contents |
| --- | --- |
| `egm/v0.1.1/` | the 31 unmodified upstream files at the pinned tag, plus `bundle.json` (the ownership journal) |
| `skills/egm-<name>/` | the 7 EGM skills, each upstream body verbatim behind a short GJC adapter block, with 3 reference files copied verbatim |
| `agents/egm-<name>.md` | the 8 Goldfish reviewers: upstream persona body verbatim, frontmatter extended with `tools: read, search, find` |

The plugin's one tool is **`egm_readiness`** — a read-only, offline report of that install (journal, 31 bundle digests, 18 loose files, extra `egm-*` agents, session settings, `task` visibility) with remediation. It accepts exactly `{}`, writes nothing, never fetches or runs EGM, and never contacts the network.

## Install

From a `gjc-plugin` checkout root:

```sh
bun run egm:install
# same entry, without the package script:
bun egm/scripts/install.ts
```

The default fetches only the fixed upstream release (`git clone --depth 1 --branch v0.1.1`, then the commit must be `dea7761de06ce5b51c177ebb9bba0469f24af5a4`). To install from a checkout you already have:

```sh
bun egm/scripts/install.ts --source /path/to/elephant-goldfish-model-v0.1.1
```

Either way every one of the 31 files is checked against the pinned sha256 table before anything is written. A `--source` checkout must also resolve its `.git` HEAD to the pinned commit `dea7761de06ce5b51c177ebb9bba0469f24af5a4`: a mismatch fails as `source_head_mismatch`, an unreadable git identity as `source_commit_unknown`, and no flag bypasses the pin. The installer resolves the agent directory through the same chain `gjc` uses (`GJC_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, then `~/.gjc/agent`; the readiness tool also asks the host resolver when GJC exposes it). It writes only there, so a disposable `HOME` or `GJC_CODING_AGENT_DIR` keeps a test run away from the real install.

The same command registers this checkout's `egm/` plugin bundle through the installed `gjc` CLI, so the loose runtime and `egm_readiness` are both installed in one step. An existing user-scope `egm` bundle is replaced through the native `gjc plugin uninstall egm --user` / `gjc plugin install <checkout>/egm --user` pair, never `--force`; the separate `egm@egm` marketplace install is left alone. Start a **new** `gjc` session afterwards (skills and tools load at session start).

Ask the session to run `egm_readiness`; a healthy install prints `egm_readiness: install_verified`.

## Ownership, resume and refusals

`bundle.json` records the tag, the commit, the 31 upstream digests and the 18 written loose digests. It is written `pending` before the first file and `complete` after every written file is re-hashed, and it is replaced atomically (`bundle.json.tmp` + rename), so a failed replacement leaves the previous journal intact. The unchanged fast path compares the user-scope bundle registration (`gjc-plugins/registry.json`) with this checkout's manifest hash and copied-file hashes — including the installed copies — and replaces a stale, disabled, partial or tampered bundle through the native uninstall/install pair even when `plugin list` disagrees.

- **Resume.** A `pending` journal (an interrupted run) is completed by re-running the same command; the files it already claimed are rewritten.
- **Unchanged.** When a completed install already matches the pin exactly, the re-run reports `unchanged` and writes nothing.
- **Refused, with nothing written:** a source file that is missing, unreadable, a symlink or not at the pinned digest; a source checkout whose fetched tag or `.git` HEAD is not the pinned commit; a foreign file at any destination; a symlink anywhere on a destination path; a journal that does not match this pin and file set; and a **changed file of a completed install**.
- **Repair.** A missing file of a completed install is restored by a re-run. To restore a file you changed, delete that file first and re-run — the installer will not overwrite it silently.
- A destination that exists without a journal is treated as foreign even when its bytes happen to match; install into a clean agent directory or move the old files away.
- The composed files embed the absolute agent directory. If that directory moves (a different `HOME`), the journal no longer describes the files on disk and the installer refuses; remove the tree and reinstall rather than editing the journal.
- The installer never deletes runtime files. Removal is manual: take the paths from the journal (`bundle.json` lists every written bundle and loose path), delete them, then remove the `egm/v0.1.1` tree.

A legacy `egm@egm` marketplace install is a separate path and is not created, upgraded or removed by this installer.

## Use

The skills are loose user skills, so they register without a plugin namespace:

| Command | What it does |
| --- | --- |
| `/skill:egm-brainstorm <idea>` | Clarifying questions, a Goldfish review, then `concepts_brief.md` |
| `/skill:egm-draft` | A design document drafted section by section from the brief: `design_draft.md` |
| `/skill:egm-review design_draft.md` | The five-phase Goldfish review (Zoom Out → Comprehension → Critic → Zoom Out → Readiness) and its report |
| `/skill:egm-review-loop` · `/skill:egm-resolve` · `/skill:egm-bootstrap` · `/skill:egm-drift-report` | Automated review loop, resolving reviewer findings, directory READMEs, design-to-code drift |

Where the skills write their files, and how to name another folder (`EGM artifact directory: <path>`), is described in EGM's [harness guide](https://github.com/google/elephant-goldfish-model/blob/v0.1.1/docs/harnesses.md#artifact-directory). Each composed skill carries a GJC adapter block that names the two bundle roots (`agents/`, `resources/`, `docs/`; and the skill's own `references/`) and the eight reviewer names.

## Goldfish reviewers in GJC

- Eight personas are registered as loose GJC agents: `egm-codebase-details`, `egm-comprehension`, `egm-design`, `egm-implementation-readiness`, `egm-inventive-catalyst`, `egm-structural`, `egm-style`, `egm-zoom-out`. The review skills dispatch them through the `task` tool; an ordinary session activates `task` through tool search.
- `edit`, `write` and `bash` are refused for reviewers because the frontmatter allowlist is exactly `tools: read, search, find` (GJC appends `yield` itself). A reviewer child therefore cannot modify files or run a shell through the built-in tools.
- The bootstrap orchestrator and the synthesizer are **not registered**: upstream gives them write and spawn tools. `egm-bootstrap` runs the orchestrator role inline in the current session, and the review skills dispatch reviewers directly instead of using the synthesizer.
- A session without `task` cannot run a Goldfish review; the review skills then stop instead of reviewing in the same context. That is the case when `gjc` is launched with a `--tools` list that omits `task` (tool search cannot activate it either), when `task.maxRecursionDepth` is `0`, or inside a `task` child.

### What is and is not isolated

- **The parent conversation does not reach the reviewer.** A reviewer starts with the persona and its request, not the earlier turns.
- **Host instruction files do reach the reviewer.** The user `SYSTEM.md`, `RULES.md` and always-apply rules are part of the child's system prompt; the user and project `AGENTS.md` are not. A Goldfish review in GJC is therefore **not zero-context**. Keep stable workspace conventions in instruction files, and state every assumption the reviewers should challenge as an explicit review criterion in the request (EGM gives the same advice for Codex in its [harness guide](https://github.com/google/elephant-goldfish-model/blob/v0.1.1/docs/harnesses.md#delegation)).
- **Plugin tools are still offered.** The allowlist removes the built-in file and shell tools; it does not remove tools contributed by other installed plugins.
- GJC exposes no agent-level field or hook here that excludes the host instruction files or the plugin tools from a child. This is a host limitation, not something this plugin can switch off.

## What egm_readiness reports

| Status | Meaning |
| --- | --- |
| `install_verified` | the journal is `complete`, all 31 bundle files and all 18 loose files match the pin, no extra `egm-*` agent is registered, the session settings were read and block nothing, and no observed tool list rules out `task` |
| `unverified` | as above, but the session settings could not be read, so nothing is known about the subagent path |
| `drifted` | the required files are present, but at least one differs from the pin (a changed bundle file, an edited composed skill, a wider tool allowlist) or an extra `egm-*` agent is registered |
| `blocked` | a setting or launch argument switches EGM off: `task.maxRecursionDepth: 0`, an EGM reviewer in `task.disabledAgents`, a `skill:egm-<name>` entry in `disabledExtensions`, or an observed tool list without `task` |
| `incomplete` | a required file is missing or unreadable, or the journal is `pending` or unreadable |
| `not_installed` | no journal, no bundle root and no loose files under the resolved agent directory |

There is deliberately no `ready`: a plugin tool cannot observe an ordinary session's tool set. Only an explicit `--tools`/`--no-tools` launch list and a `task` child's own `session_init` tool list are observable; anything else is reported as `unobservable` and does not block.

The report also reads the user-scope `egm` bundle registration from `gjc-plugins/registry.json` and reports `plugin: registered | disabled | missing | unreadable`, with the registered source, manifest hash and enabled flag. That block is a registration signal only: the installed bundle is **not** byte-compared with a checkout, so run the installer to verify or replace it. The statuses above stay runtime-scoped; a disabled or missing bundle does not change them.

The report reads the resolved agent directory, the session settings (`task.maxRecursionDepth`, `task.disabledAgents`, `disabledExtensions`), this process's launch arguments and the current session's entries. It does not inspect project-scope installs, prove that a review ran or judge review quality.

## Version pin and upgrades

The pin (`EGM_PINNED_TAG`, `EGM_PINNED_COMMIT`, and the digest table `EGM_PINNED_FILES` in `lib/readiness.ts`) changes only in a new plugin release. Regenerate every digest from a pinned clone (`git -C <clone> show v0.1.1:<path> | shasum -a 256`), update the core and this README, rebuild the tool and run the suites. To move an existing install to a new pin, remove the old bundle and the loose paths the old journal lists (the new journal cannot adopt them), then run the new installer.

## Build and verify

```sh
bun scripts/build.mjs           # regenerate tools/egm-readiness.ts (keyless)
bun scripts/build.mjs --check   # non-mutating drift check
bun scripts/verify.ts           # hermetic offline suite (synthetic fixtures, isolated HOME, no network)
node scripts/smoke-native.mjs   # native install + isolation smoke in a throwaway GJC root
```

Repo root: `bun run build:egm`, `bun run test:egm`, `bun run egm:smoke`. `build:egm` must run before `test:egm`: the suite proves the generated tool is in sync and then exercises it. The smoke needs `gjc` 0.21.1 or newer, `bun`, `git`, and network access to GitHub for the pinned clone; its model is a scripted endpoint on `127.0.0.1`, and it leaves your real GJC registries unchanged. It exits `2` when a prerequisite is missing.

## License and attribution

EGM is Google's work under the [Apache License 2.0](https://github.com/google/elephant-goldfish-model/blob/v0.1.1/LICENSE) and is not an officially supported Google product. This plugin redistributes none of its files: the installer fetches the release from upstream (or verifies a checkout you already have), the digest table holds sha256 values only, and GJC-specific text lives only in the adapter blocks added around the verbatim upstream bodies. Changes to EGM itself belong upstream.
