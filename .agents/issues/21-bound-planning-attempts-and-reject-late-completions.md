# 21. Retry incomplete planning stages within three total attempts

**Type:** AFK  
**User stories:** PRD §5 stories 5, 7  
**Requirements:** PRD §§7.11, 7.12, 11

## What to build

Make PRD and issue authoring recoverable from failure without accepting final prose as completion. Each stage gets one initial attempt and at most two automatic retries, with partial drafts retained and explicit owner retirement. Correctable validation errors stay in the live attempt; timeouts, failed turns and ending without accepted completion consume an attempt. After three attempts, show the blocker and use a native question for retry/reset or stop choices. Test that cancellation and successful handoffs cannot race into an extra attempt or cancel downstream execution.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/planning/generation.ts` (lines 84–175) — old one-attempt dispatch/timeout and late-generation checks.
- `src/core/types.ts` (lines 40–82) — attempt envelope and failure/result vocabulary.
- `src/execution/attempts.ts` (lines 1–90) — existing execution attempt-budget conventions.
- `src/opencode/adapter.ts` (lines 463–495) — cancellation before/after prompt delivery.
- `src/commands/control.ts` (lines 74–149) — bounded owned cancellation and cleanup uncertainty.
- `tests/integration/04-planning.test.ts` (lines 410–490) — late output and timeout regressions.
- `tests/helpers/clock.ts` (lines 1–36) — test clock helpers.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Persist ownership/attempt status before dispatch, check the current attempt/control epoch on every callback, and use existing failure codes honestly. Reuse cancellation and session inspection rather than assuming that an aborted request stopped its agent. Stage retries are independent of issue attempts and final review rounds. Native question waiting must suspend active-time deadlines rather than burning retries while the user thinks.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `src/planning/generation.ts; src/planning/types.ts; src/state/run-store.ts`

- **IMPLEMENT:** Record each stage attempt, active-time budget, draft root, owner/session and terminal reason. Drive retry only for failed/timed-out/finished-without-completion attempts. Preserve accepted handoff outcomes and never retry a stage already accepted.
- **PATTERN:** src/planning/generation.ts:129 and src/commands/control.ts:62.
- **IMPORTS:** Reuse type JobEnvelope/JobResult/Failure, RunStore, and captured timeout settings; add clock injection following tests/helpers/clock.ts.
- **GOTCHA:** An invalid completion tool result is correctable during a live attempt; a missing completion at settled turn end is a failure. Paused/user-waiting time is not active authoring time.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/14-recovery.test.ts`.

### UPDATE `src/opencode/adapter.ts; src/planning/completion.ts; src/planning/artifact-writer.ts`

- **IMPLEMENT:** Retire failed attempt authority before interrupting its session and starting another. Reconcile session state where cancellation is uncertain. Preserve partial drafts in the failed attempt namespace and supply explicit accepted inputs to retries. Reject late writes, answers and completions from retired attempts.
- **PATTERN:** src/opencode/adapter.ts:451 and src/plugin.ts:499.
- **IMPORTS:** Reuse cancelJob, inspectSession, RunStore control guards and the stage session adapter; do not spawn a retry on an unconfirmed busy owner.
- **GOTCHA:** For PRD retries, continue its interview/PRD session only after prior activity is settled; do not silently move the live PRD stage into a new session and lose its interview context.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/14-recovery.test.ts`.

### UPDATE `src/planning/generation.ts; src/plugin.ts; tests/integration/04-planning.test.ts`

- **IMPLEMENT:** After attempt three, persist exhaustion, publish the error and ask for explicit recovery. Record any human-authorized budget reset; otherwise keep stopped/blocked state. Test handoff completion followed by old turn settlement, stop, pause and late callbacks.
- **PATTERN:** src/commands/control.ts:33 and tests/integration/04-planning.test.ts:410.
- **IMPORTS:** Reuse native input and existing control helpers; import expect/test from bun:test and temporary Git fixtures.
- **GOTCHA:** Do not grant a fourth automatic attempt or spend issue/review budgets on planning failures.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/14-recovery.test.ts`.

### UPDATE `docs/wiki/features/workflow-recovery.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/workflow-recovery.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] PRD and issue planning retry at most three total attempts each; final prose without completion never advances.
- [ ] Validation errors can be corrected in the live attempt without immediate budget consumption.
- [ ] Native user waiting and pause do not expire the authoring active-time budget.
- [ ] Failed-attempt drafts remain available; old sessions cannot write or complete after retirement.
- [ ] Exhaustion produces a native recovery choice; a budget reset requires a real explicit user choice recorded in state.
- [ ] Successful handoff, tool return, or ordinary turn completion does not stop the run or duplicate downstream work.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/14-recovery.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [19-complete-issues-and-start-authorized-execution.md](19-complete-issues-and-start-authorized-execution.md) — supplies the predecessor behavior required by this slice.
