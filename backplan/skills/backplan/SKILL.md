---
name: backplan
description: Plan execution-bound work backward from its end state at the moment it arrives — write the end state first, derive success criteria, the issue breakdown, Linear project mapping, policy decisions and automation candidates, then grade and render the plan with backplan_check. Fires when the request will change something (files, deploys, artifacts, money) and completion criteria are unclear, work spans multiple steps or repos, project attribution is undecided, boundaries need agreement, or an existing project is being changed. Never for pure read-only questions.
---

# Backplan — backward planning into Linear

Not a named ceremony — this is what planning looks like at the moment
execution-bound work arrives: derive it, grade it, register it, then execute.
`backplan_check` (gjc-plugin `backplan`) is the deterministic gate that grades
the draft and renders Linear-ready payloads. The plugin is keyless and local:
it never writes to Linear; registration goes through the workspace Linear MCP
tools and `~/.gjc-user-policy/bin/linear-trace.py`.

## When this fires

Fire when any of these holds — the depth of the derivation scales with the
situation, but the grade-and-register step does not get skipped:

- The request will change something: files, deployments, artifacts, money.
- Completion criteria are not yet checkable ("검증 가능한 형태").
- The work spans multiple steps, repos, or sessions.
- Project attribution must be decided (including creating a project).
- Scope/boundaries must be agreed before size and risk are knowable.
- An existing project is being changed (reuse vs extension vs redefinition).

Skip only for pure consultation/lookup ("이거 뭐야", "설명해줘", "왜 그래?") —
the workspace rule forbids tickets for those. Preserve the request verbatim in
`request`. Do not paraphrase scope away.

## The method — write the end first

1. **End state.** If this were finished, what is observably true? Write that
   sentence before anything else: "X shows Y at Z", not "작업이 잘 됨".
2. **Success criteria.** How will each end-state claim be checked — command,
   artifact, observation? Goal-level criteria live in `success_criteria`;
   per-issue checks live in `completion_criteria`.
3. **Backward decomposition.** From the end state, what must exist immediately
   before it? Recurse until each leaf is an independently completable,
   verifiable result — that leaf is an issue. A leaf that only makes sense as
   a step of a parent issue is a sub-issue (`parentId`) instead; mechanical
   file/command-level steps stay checklists. Stop when an item can be finished
   and checked in one session.
4. **Brownfield (역공학).** When the target already exists, measure it first:
   repo/branch/deployment state, current behavior, receipts. Derive from
   artifacts, reuse first, do not rebuild what already works. For shipped
   artifacts, the measuring instrument is REA — see "Brownfield measurement
   with REA" below.
5. **Project mapping.** Every issue belongs to a project. One standing
   project per topic (product/repo/area): reuse it for all later work, and
   when a topic's work returns after its project completed, reopen that
   project instead of spawning a sibling. Create a project only for (a) a
   topic's first registration, or (b) a finite goal spanning several topics.
   Never one project per task or session; orphan tickets are not created.
   Before creating an issue, search the topic for similar ones and link
   similar/prerequisite/duplicate issues via relations
   (`relatedTo`/`blocks`/`blockedBy`/`duplicateOf`) — no unlinked drifting
   issues. `project.reason` records why this mapping is correct.
6. **Policy decisions.** What must be decided before or during, and where is
   the decision recorded (project description, rule file, ADR)?
   `needs_user_decision: true` only when the choice materially changes
   correctness, scope, cost or safety — and then list the `options`.
7. **Automation candidates.** Repeated manual steps noticed along the way are
   recorded as `backlog`/`out_of_scope`. Never silently pull automation into
   current scope: promote it to a real issue only with explicit scope and
   approval.

## Brownfield measurement with REA

When the target already exists as a shipped artifact — native binary, app or
Electron/JavaScript bundle, website runtime, HAR capture, APK, firmware —
measure it with REA through the `rea` skill (`npx -y rea-agents@6.4.0`)
instead of guessing what source availability cannot establish:

- Cite the saved report path and its evidence ids in the issue `context`.
- Turn REA unknowns (`record_unknown`) into `policy_decisions` — they are the
  plan's open questions, each naming the authority still required to close
  it.
- Phrase completion criteria as declared finite claims (the
  `verify_reconstruction` shape): a pass covers only the declared comparable
  claims, never global equivalence.
- Missing coverage is unknown, not absence — never write a criterion that
  depends on an absence a limited read cannot establish.

## Register, then execute

1. Write the draft JSON (snake_case keys, contract below) — inline or to a
   file — and call `backplan_check` with `plan` or `plan_path` (plus
   `session`/`worktree`/`branch` so the rendered execution line is filled).
2. Fix **every** `errors[]` entry until the tool says `ok`; treat `warnings[]`
   as judgment calls. The tool is the contract, not a suggestion.
3. Create or reuse the Linear project (`linear.project`; for `create` mode use
   the rendered description), then create the issues with the rendered
   `description` and `labels`, in plan order. Create any missing label first
   (`save_issue_label`) so registration cannot half-fail.
4. Start trace:
   `python3 ~/.gjc-user-policy/bin/linear-trace.py record --issue JJO-N --event start --authority user-approved --summary '실행 연결 …' --publish`.
   Include the plan digest in the first trace summary or the issue footer.
5. Execute issue-based. Checkpoint/commit/verification/delivery events follow
   `rule://linear-work`; a material plan change is a `scope-change` event and,
   when the plan itself changes, a fresh `backplan_check` run.

## Draft contract (snake_case)

Required: `goal`, `end_state`, `success_criteria` (1..12), `project`
(`{name, mode: "reuse"|"create", reason, boundaries?}`), `issues` (1..24),
`policy_decisions`, `automation_candidates` (both may be `[]` — but ask
yourself honestly before writing an empty array). Optional: `request`,
per-issue `dependencies[]` and `labels[]`.

Each issue: `title`, `objective`, `context`, `scope_in` (≥1), `scope_out`
(≥1 — write "해당 없음" if truly none), `completion_criteria` (1..12),
`delivery`.

Completion criteria must be observable; generic phrases ("완료", "동작함",
"done") are rejected, repeated criteria only warn, and duplicate issue titles are rejected. Unknown keys are rejected. Sizes are
bounded (strings ≤ 2000 chars, plan ≤ 256 KiB).

Minimal example:

```json
{
  "request": "사용자가 시킨 작업 원문",
  "goal": "상위 목표 한 문장",
  "end_state": "끝났을 때 관찰 가능한 상태 한 문장",
  "success_criteria": ["검증 방법이 명시된 성공 기준"],
  "project": { "name": "기존 활성 프로젝트 이름", "mode": "reuse", "reason": "이 프로젝트에 속하는 이유" },
  "issues": [
    {
      "title": "독립적으로 완료·검증 가능한 결과",
      "objective": "해결할 문제와 기대 결과",
      "context": "대상 레포·경로·근거",
      "scope_in": ["이번에 할 것"],
      "scope_out": ["하지 않을 것"],
      "completion_criteria": ["실행할 검증 명령과 기대 결과"],
      "delivery": "승인된 전달 범위 (로컬/푸시/배포)"
    }
  ],
  "policy_decisions": [],
  "automation_candidates": []
}
```

## Reading the tool result

`backplan_check: ok` + JSON → `digest` (sha256 of the normalized plan),
`linear.project` (payload; `description` non-null only for `create`),
`linear.issues[].description` (team-template-shaped Korean markdown) and
`linear.notes` (policy decisions + automation candidates to append where the
plan says). `backplan_check: invalid` → do not register anything; fix all
`errors[]` first.

## Anti-patterns

- Starting work before the ticket exists ("기록은 나중에" — there is no later).
- Orphan issues, or a new project per task, session, or small fix.
- Completion criteria that cannot be checked.
- Automation quietly folded into current scope.
- Paraphrasing the request so scope shifts without a `scope-change`.

## Boundaries

Keyless, offline, deterministic. It never approves, publishes, writes to
Linear or executes work. Human decisions stay human.
