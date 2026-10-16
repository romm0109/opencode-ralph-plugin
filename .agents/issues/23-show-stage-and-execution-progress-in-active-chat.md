# 23. Show stage progress and final execution results in the active chat

**Type:** AFK  
**User stories:** PRD §5 stories 5, 7, 8  
**Requirements:** PRD §§6.2, 7.10, 7.13, 10

## What to build

Make the new workflow visible through all stages and existing execution/review. Send durable, bounded progress with worker/reviewer identities and final results to the issue-planning chat rather than relying on the old ralph_workflow tool wrapper. Extend status/dashboard snapshots with stage owner, attempts and waiting/blocker state. Keep the browser read-only and preserve secret redaction, event ordering, and loopback authorization. Navigation events must focus only the intended project session and must not wake or start duplicate agents.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/commands/chat-workflow.ts` (lines 74–148) — existing progress wrapper, bounded steps, secret sanitization, and job results.
- `src/plugin.ts` (lines 235–243) — RPC status emission.
- `src/opencode/bridge.ts` (lines 6–22) — current status-only schema.
- `src/tui.ts` (lines 1–31) — scoped toast listener.
- `src/dashboard/projections.ts` (lines 8–72) — snapshot types and existing agent identities.
- `src/dashboard/projections.ts` (lines 89–103) — projection redaction boundary.
- `src/dashboard/web/App.tsx` (lines 150–190) — phase and execution status display.
- `tests/integration/10-dashboard.test.ts` (lines 1–100) — read-only/authenticated snapshot fixtures.
- `tests/browser/dashboard.test.ts` (lines 1–80) — browser state rendering checks.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Reuse runtimeSecretValues/sanitizeValue for chat output and sanitizeDisplay/projectRunSnapshot for browser data. Preserve append-only event sequence IDs and bounded log access. Synthetic progress messages use resume:false so worker updates cannot resume an idle assistant or answer a question. Keep observer/event ownership in the plugin lifecycle and avoid publishing notifications while initialization is still blocked.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `src/plugin.ts; src/opencode/adapter.ts; src/opencode/bridge.ts`

- **IMPLEMENT:** Move reusable progress publication out of runChatWorkflow into run/stage-owned observation. Report stage changes, attempts, worker roles/session references, selected commands, results, blockers and final completion into the active workflow chat. Persist the visible-session owner and recheck it on delivery.
- **PATTERN:** src/commands/chat-workflow.ts:74 and src/plugin.ts:293.
- **IMPORTS:** Reuse sanitizeValue/runtimeSecretValues, publishStatus, session.synthetic, and the new stage session event schema.
- **GOTCHA:** Old tool AbortSignal cleanup must not follow ordinary stage completion and stop downstream work. Progress is observation, not an execution trigger or approval.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/10-dashboard.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `src/dashboard/projections.ts; src/dashboard/web/App.tsx; src/tui.ts`

- **IMPLEMENT:** Expose current planning stage/attempt/owner and waiting reason without raw prompts, secrets, arbitrary filesystem paths or mutation actions. Render stage state distinctly and preserve navigation scoping/idempotence from issue 16.
- **PATTERN:** RunSnapshot at src/dashboard/projections.ts:8 and scoped listener at src/tui.ts:5.
- **IMPORTS:** Reuse RunRecord/RunEvent, sanitizeDisplay, existing State UI component, and ctx.ui session navigation.
- **GOTCHA:** Keep the dashboard API read-only; do not add an answer or approval endpoint to solve visibility.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/10-dashboard.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `tests/integration/10-dashboard.test.ts; tests/integration/tui-input.test.ts; tests/browser/dashboard.test.ts`

- **IMPLEMENT:** Cover planning snapshots, cross-location navigation rejection, progress with secret-like values, reviewer results and final qualified completion delivered to the issue-planning chat. Verify status/progress never triggers a model turn.
- **PATTERN:** projectRunSnapshot at src/dashboard/projections.ts:93.
- **IMPORTS:** Use bun:test fixtures and existing Playwright dashboard tests; reuse fake synthetic inbox and event recording.
- **GOTCHA:** A toast-only assertion does not prove durable chat progress or final results are visible.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/10-dashboard.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `docs/wiki/features/read-only-dashboard.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/read-only-dashboard.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] Users follow interview then fresh issue session; PRD remains in the interview session.
- [ ] Execution and review progress and final report appear in the issue-planning chat with bounded, sanitized worker/session details.
- [ ] Progress does not answer forms, invoke stage tools, wake idle agents, or start duplicate work.
- [ ] Dashboard distinguishes writing/waiting/retrying/blocked from completed stages and remains read-only/authenticated.
- [ ] Secret redaction, log bounds and cross-project notification/navigation isolation retain coverage.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/10-dashboard.test.ts tests/integration/tui-input.test.ts
bun run test:status
bun run test
bun run build
bun run test:browser
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [19-complete-issues-and-start-authorized-execution.md](19-complete-issues-and-start-authorized-execution.md) — supplies the predecessor behavior required by this slice.
