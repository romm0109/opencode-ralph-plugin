# 22. Restart interrupted grilling and recover accepted planning safely

**Type:** AFK  
**User stories:** PRD §5 stories 1, 7, 8  
**Requirements:** PRD §§7.1, 7.12–7.13, 11

## What to build

Complete existing-run choices and recovery for new-format workflows. An interrupted run without an accepted PRD restarts discovery in a fresh session rather than reconstructing grilling in a different context. A run with an accepted PRD can recover later stages from exact saved artifacts, authorization, attempts and handoff evidence. Resume ordering must not write planning state while control still rejects that write or misreport it as a revision race. Stop-and-restart must settle ownership and cleanup without deleting prior artifacts or accepting stale callbacks.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/commands/resume.ts` (lines 12–78) — current stage resume and old cross-context interview continuation.
- `src/commands/chat-workflow.ts` (lines 171–208) — session rebind occurs before control resume and reports generic revision error.
- `src/state/run-store.ts` (lines 483–491) — recordPlanning rejects inactive control as well as revision conflicts.
- `src/recovery/reconcile.ts` (lines 84–140) — repository lock inspection and recovery facts.
- `src/commands/control.ts` (lines 20–73) — resume blocked by unresolved cleanup/recovery.
- `src/state/active-run.ts` (lines 5–53) — matching ownership release currently requires terminal review.
- `tests/integration/14-recovery.test.ts` (lines 592–644) — stop uncertainty and pending cleanup.
- `tests/integration/14-recovery.test.ts` (lines 783–882) — old question-rebinding and retained budgets tests to adapt.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Keep Git-common-directory ownership and host-lease guards. Only release a matching stopped run after verified cleanup, using an intent/result pattern analogous to releaseTerminalRun; do not weaken terminal-review ownership release globally. Recovery checks evidence, then waits for explicit user choice. Handoff reconciliation uses recorded session metadata and prompt receipts, not an assumption that missing state means no external effect happened.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `src/commands/orchestrator.ts; src/commands/resume.ts; src/recovery/reconcile.ts`

- **IMPLEMENT:** Show native existing-run choices appropriate to the saved boundary. For no accepted PRD, explain fresh discovery restart and preserve old history without feeding it as a replacement grill context. For accepted PRD/graph, inspect the saved owner/artifacts/attempt and resume only the necessary unfinished stage.
- **PATTERN:** src/recovery/reconcile.ts:84 and src/commands/resume.ts:65.
- **IMPORTS:** Reuse handleControlCommand, reconcileRun, requestNativeInput, and the new stage/handoff session adapter.
- **GOTCHA:** No legacy-run migration: unsupported records get a fresh-workflow-required message. Do not rebuild an old approval or transcript into new automatic-execution authorization.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/14-recovery.test.ts tests/integration/host-lease.test.ts tests/integration/03-interview.test.ts`.

### UPDATE `src/state/active-run.ts; src/state/run-store.ts; src/commands/control.ts`

- **IMPLEMENT:** Add safe stopped-planning release/restart with matching repository/run identity and verified cleanup. Atomically coordinate resume control and stage binding or explicitly sequence reactivation, reload, guarded update. Distinguish inactive, blocked and revision-conflict results in callers.
- **PATTERN:** src/state/active-run.ts:25 and src/commands/control.ts:62.
- **IMPORTS:** Reuse readFile/rm/join ownership helpers, recordOperation and revision-checked control updates.
- **GOTCHA:** Never remove an unknown lock, revive a superseded attempt, reset budgets, or discard retained cleanup blockers. A fresh session alone is not proof old work stopped.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/14-recovery.test.ts tests/integration/host-lease.test.ts tests/integration/03-interview.test.ts`.

### UPDATE `src/opencode/adapter.ts; src/planning/generation.ts; tests/integration/14-recovery.test.ts`

- **IMPLEMENT:** Reconcile crashes after stage acceptance, session creation, session attachment, prompt enqueue, and execution eligibility recording. Recover exactly one observed downstream effect or block ambiguity. Keep accepted PRD/graph and remaining budgets unchanged.
- **PATTERN:** src/opencode/adapter.ts:435 and publishRevision at src/planning/generation.ts:36.
- **IMPORTS:** Reuse inspectSession/cancelJob and durable handoff identifiers; extend fake session metadata/history observations for recovery fixtures.
- **GOTCHA:** Retain execution recovery guarantees for already advanced refs and verified checks; change the planning protocol without weakening actual Git/process reconciliation.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/14-recovery.test.ts tests/integration/host-lease.test.ts tests/integration/03-interview.test.ts`.

### UPDATE `docs/wiki/features/workflow-recovery.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/workflow-recovery.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] Invoking the command for an existing supported run asks applicable resume/restart choices through the native question tool.
- [ ] Interrupted grilling or unfinished PRD with no accepted PRD restarts from the opening question in a fresh context.
- [ ] Accepted-PRD recovery uses immutable artifacts and remaining attempts; no interview reconstruction or duplicate planner appears.
- [ ] Resume of inactive control no longer loops on the misleading changed-during-resume message.
- [ ] Stop/restart waits for confirmed cleanup, releases only matching ownership, preserves history/worktrees, and rejects old-session results.
- [ ] Crash-boundary tests prove one handoff/execution start; ambiguous effects remain blocked and execution evidence is never invented.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/14-recovery.test.ts tests/integration/host-lease.test.ts tests/integration/03-interview.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [20-reapprove-product-scope-changes-through-native-questions.md](20-reapprove-product-scope-changes-through-native-questions.md) — supplies the predecessor behavior required by this slice.
- [21-bound-planning-attempts-and-reject-late-completions.md](21-bound-planning-attempts-and-reject-late-completions.md) — supplies the predecessor behavior required by this slice.
