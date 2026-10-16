# 24. Remove the obsolete workflow protocol and align public documentation

**Type:** AFK  
**User stories:** PRD §5 stories 1, 3, 5, 7  
**Requirements:** PRD §§4, 7.12, 10, 15

## What to build

Remove the old model-selected ralph_workflow start/resume/reply transport, stale execution-approval prompts, and feature-specific chat receipt/question-suppression code. Finish wiring all public controls and exports to the new stage workflow with no compatibility fallback or old-state migration. Preserve unrelated project setup and previewed removal authorization, which currently share some helpers with the old transport. Align README, compatibility, troubleshooting and compact wiki descriptions with actual behavior. Old run detection may explain that a fresh workflow is required but must not become a legacy execution path.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/commands/chat-workflow.ts` (lines 1–75) — old prompt, receipts, affirmation parsing and protocol schema.
- `src/core/chat-input.ts` (lines 1–8) — old wait-boundary exception.
- `src/plugin.ts` (lines 6–25) — legacy imports shared with removal helpers.
- `src/plugin.ts` (lines 367–390) — removal explicitly relies on approvesChat and receipt provenance.
- `src/plugin.ts` (lines 425–510) — control resume, prompt receipts and native question suppression.
- `src/commands/router.ts` (lines 169–220) — public command routing and resume continuation.
- `tests/integration/chat-workflow.test.ts` (lines 95–140) — old tests assert no direct start and question suppression.
- `tests/integration/remove-project.test.ts` (lines 1–85) — preview/approval removal regression coverage.
- `docs/wiki/features/workflow-recovery.md` (lines 1–40) — current documentation describes the obsolete feature protocol.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Delete obsolete branches rather than accepting both new and old wire shapes. Keep only real new-flow schema/version rejection needed at the state boundary. Refactor shared ordinary-chat affirmative/removal receipt helpers into removal-owned code if still needed: absence of legacy feature transport does not authorize deleting removal checks. Public docs must describe native questions, one scope authorization, stage session boundaries and current recovery rules consistently.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### REMOVE `src/commands/chat-workflow.ts; src/core/chat-input.ts; src/plugin.ts`

- **IMPLEMENT:** Delete obsolete feature prompt, workflow tool registration, reply receipt consumer and feature question suppression after new-flow callers no longer rely on them. Move narrowly needed removal approval helpers to removal-owned code. Remove old generate-and-approve-graph paths and unused exports rather than leave a silent fallback.
- **PATTERN:** src/plugin.ts:383 and src/commands/chat-workflow.ts:49.
- **IMPORTS:** Update imports of approvesChat/ChatReceipt to a removal-specific module if retained; remove ChatInputRequired imports once no nonlegacy caller needs the exception.
- **GOTCHA:** Audit all call sites before deletion, including ralph_control resume, project setup, tests, server exports, and packaged probes. Do not remove unrelated control/removal authorization.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/chat-workflow.test.ts tests/integration/remove-project.test.ts tests/integration/save-commands.test.ts tests/integration/01-plugin.test.ts`.

### UPDATE `src/commands/router.ts; src/commands/resume.ts; src/state/run-store.ts; tests/integration/chat-workflow.test.ts`

- **IMPLEMENT:** Make all supported entrypoints drive the new stage runner. Replace old protocol tests with direct command/native-form/owner-tool assertions. Unsupported records produce a clear fresh-workflow message without migration, broad directory deletion or fabricated approval.
- **PATTERN:** src/commands/router.ts:169 and new stage discriminator from issue 16.
- **IMPORTS:** Reuse the new orchestrator/resume services and existing read-only status data.
- **GOTCHA:** Do not keep an accepted old action enum or version adapter for convenience in tests; test fixtures must use the real public new interface.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/chat-workflow.test.ts tests/integration/remove-project.test.ts tests/integration/save-commands.test.ts tests/integration/01-plugin.test.ts`.

### UPDATE `README.md; docs/opencode-compatibility.md; docs/troubleshooting.md; docs/wiki/features/feature-interview.md; docs/wiki/features/feature-planning.md; docs/wiki/features/workflow-recovery.md`

- **IMPLEMENT:** Replace old chat-reply/second-approval instructions with the delivered native flow, new completion tools and recovery boundaries. Link code/tests and explain no compatibility. Keep PRD requirements and implementation status distinct.
- **PATTERN:** docs/wiki/features/workflow-recovery.md:7.
- **IMPORTS:** Documentation only; use current tool names and tests actually implemented by predecessors.
- **GOTCHA:** Do not claim platform/live checks that have not run.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/chat-workflow.test.ts tests/integration/remove-project.test.ts tests/integration/save-commands.test.ts tests/integration/01-plugin.test.ts`.

### UPDATE `docs/wiki/features/workflow-recovery.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/workflow-recovery.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] No public feature path registers or invokes ralph_workflow start/resume/reply or suppresses native question forms.
- [ ] Old feature chat receipts and second-execution-approval paths are removed rather than supported alongside new interfaces.
- [ ] Unsupported saved runs never execute or migrate; their artifacts remain intact.
- [ ] Project setup saving and removal preview/real-user approval remain covered and functional.
- [ ] Public docs consistently describe full skills, stage session changes, completion tools, automatic execution, retry budgets and recovery.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/chat-workflow.test.ts tests/integration/remove-project.test.ts tests/integration/save-commands.test.ts tests/integration/01-plugin.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [22-restart-grilling-and-recover-accepted-planning.md](22-restart-grilling-and-recover-accepted-planning.md) — supplies the predecessor behavior required by this slice.
- [23-show-stage-and-execution-progress-in-active-chat.md](23-show-stage-and-execution-progress-in-active-chat.md) — supplies the predecessor behavior required by this slice.
