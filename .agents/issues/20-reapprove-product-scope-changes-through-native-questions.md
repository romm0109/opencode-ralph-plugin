# 20. Resolve product questions and reapprove changed scope across stages

**Type:** AFK  
**User stories:** PRD §5 stories 2, 3, 6, 8  
**Requirements:** PRD §§7.4–7.5, 10, 11

## What to build

Allow PRD and issue agents to raise missing product decisions through a stage-owned native question boundary instead of silently choosing them. Continue within approved scope when the answer only clarifies it; when scope changes, invalidate the affected authorization/artifacts and obtain renewed explanation approval. Use the same policy for executor questions while preserving the existing dependency blocking and integration safeguards. A changed starting commit must also be displayed and reapproved before execution. Technical choices already within scope do not add another approval gate.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/execution/questions.ts` (lines 24–107) — executor-question shape and waiting/affected descendants.
- `src/execution/questions.ts` (lines 157–235) — real answer validation and scope-change branching.
- `src/execution/questions.ts` (lines 263–325) — current scope artifact revisions and affected issue computation.
- `src/execution/questions.ts` (lines 385–425) — superseded sessions settle before approved-scope continuation.
- `src/planning/types.ts` (lines 10–26) — scopeChange retains previous artifacts/authorization and integration context.
- `tests/integration/09-questions.test.ts` (lines 1–100) — public executor question fixtures.
- `src/commands/resume.ts` (lines 34–63) — old commit selection after planning with separate execution approval.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Use request identities and artifact revisions as the authority; include recommendation and stage context in native questions. Retain affected/dependent issue blocking and stale result rejection from reviseQuestionScope/prepareApprovedScope. The plugin deterministically requires reapproval once a scope revision is proposed; semantic discovery is an agent responsibility, not a claimed automated proof that every requirement sentence is equivalent.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### ADD `src/planning/questions.ts; src/plugin.ts; skills/create-prd/SKILL.md; skills/to-issues/SKILL.md`

- **IMPLEMENT:** Expose ralph_request_product_decision to the owning PRD/issue stage with a question, recommendation, and optional proposed revised explanation/scope/criteria. Persist the native request and its answer. A submitted revised explanation always enters the native approval flow before further completion.
- **PATTERN:** src/opencode/native-input.ts:10 and src/execution/questions.ts:157.
- **IMPORTS:** Reuse requestNativeInput, explanationHash, type UserInputRequest/UserInputResult, and the authorization helper from issue 17.
- **GOTCHA:** A native answer to a clarification is not itself approval of a revised explanation. Completion must remain blocked while a decision or revised scope is pending.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/09-questions.test.ts tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts`.

### UPDATE `src/planning/completion.ts; src/planning/types.ts; src/state/run-store.ts; src/commands/resume.ts`

- **IMPLEMENT:** Invalidate dependent accepted drafts and execution eligibility on scope changes; retain previous revisions for history. Resume the necessary writing stage with explicit revised inputs. For changed HEAD/config blockers, show the new pinned inputs with the explanation and obtain renewed approval instead of silently updating them.
- **PATTERN:** src/state/run-store.ts:495 and src/planning/artifacts.ts:2.
- **IMPORTS:** Reuse artifactHash/explanationHash and recorded stage/session prompt delivery; remove old requestPlanningApproval use for this path.
- **GOTCHA:** Do not rerun the initial feature interview solely for an ordinary live clarification; interrupted discovery still follows issue 22 restart rules.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/09-questions.test.ts tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts`.

### UPDATE `src/execution/questions.ts; src/core/orchestrator.ts; tests/integration/09-questions.test.ts`

- **IMPLEMENT:** Route executor questions to the active workflow chat/native tool. Preserve scopeChange cancellation, affected descendants, accepted integrations, attempt budgets and revalidation. Replace old graph-approval assumptions with renewed explanation approval plus regenerated accepted bundle.
- **PATTERN:** prepareApprovedScope at src/execution/questions.ts:385.
- **IMPORTS:** Reuse createExecutorQuestion, answerExecutorQuestion, topologicalOrder, validateIssueGraph, and existing scheduler continuation.
- **GOTCHA:** Already integrated work must not be silently rolled back or repeated. Unaffected independent work may continue under existing issue-question semantics; affected work cannot advance on old revisions.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/09-questions.test.ts tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts`.

### UPDATE `docs/wiki/features/executor-questions.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/executor-questions.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] PRD and planner agents can ask a real native question with a recommendation and continue on a same-scope clarification.
- [ ] A scope-changing answer produces a revised explanation approval; stale approval and old artifacts cannot authorize completion.
- [ ] Changed HEAD/config is shown explicitly and requires renewed approval before execution; rejection leaves work paused.
- [ ] Executor questions block the issue and dependents, retain unrelated eligible progress, and reject late superseded submissions.
- [ ] Regenerated accepted artifacts link to renewed authorization without a second issue-breakdown/execution-approval gate.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/09-questions.test.ts tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [19-complete-issues-and-start-authorized-execution.md](19-complete-issues-and-start-authorized-execution.md) — supplies the predecessor behavior required by this slice.
