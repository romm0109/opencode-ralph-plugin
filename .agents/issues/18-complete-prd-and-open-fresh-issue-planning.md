# 18. Accept a written PRD and open one fresh issue-planning session

**Type:** AFK  
**User stories:** PRD §5 stories 4, 5  
**Requirements:** PRD §§6.2–6.4, 7.3, 7.11, 9–10

## What to build

Implement `ralph_complete_prd` as the only PRD-to-issues transition. Read the written PRD, validate the full bundled structure and approved explanation identity, publish an immutable accepted revision, and create exactly one fresh issue-planning session. Deliver the full adapted to-issues skill with explicit artifact context and focus that session. Expand the scoped writer to its issue draft files and graph without granting project-code writes. The issue planner can author local outputs but cannot start execution until issue 19 adds validated issue completion.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/planning/prd.ts` (lines 1–79) — current PRD acceptance and generateIssues transition.
- `src/planning/generation.ts` (lines 20–128) — publication intent, rename, and generation envelopes.
- `src/planning/issues.ts` (lines 1–95) — existing explicit PRD content, revision, and skill prompt.
- `src/opencode/adapter.ts` (lines 431–484) — session metadata, attachment, cancellation checks, prompt receipt.
- `src/planning/graph.ts` (lines 1–84) — graph shape and old issue heading validator.
- `src/agents/skills.ts` (lines 1–31) — bundled and overridden skill loading/hashing.
- `tests/integration/04-planning.test.ts` (lines 121–177) — fresh issue-session and diamond-plan path.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Reuse artifactHash and the intent-before-publication pattern in publishRevision, but accept stage-written files rather than trusting JSON in a final message. Reuse the session metadata correlation fields runId/jobId/attempt and attach ownership before delivering a prompt. The full to-issues template uses richer headings than graph.ts currently expects; define its required content intentionally instead of keeping the obsolete short validator. Session creation and prompt delivery are separately reconcilable effects.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `src/planning/completion.ts; src/planning/prd.ts; src/planning/generation.ts; src/plugin.ts`

- **IMPLEMENT:** Register ralph_complete_prd({runId, attempt, path}) with owner identity from ToolContext. Read only the permitted draft, validate nonempty full-template required sections and explanation reference, and snapshot immutable accepted bytes/hash. Return actionable invalid outcomes without advancing; repeat accepted calls return the recorded outcome.
- **PATTERN:** src/planning/prd.ts:49 and publishRevision at src/planning/generation.ts:36.
- **IMPORTS:** Reuse z, artifactHash, explanationHash, savePlanning, and type ArtifactRevision/RunStore; import readFile from node:fs/promises.
- **GOTCHA:** Executive Summary/Mission/etc. replace the old five headings. API Specification and Appendix are conditional in the full skill; do not reject an honest not-applicable API section or require invented APIs.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `src/planning/issues.ts; src/opencode/adapter.ts; src/planning/types.ts`

- **IMPLEMENT:** Persist the PRD-to-issues handoff before effects; create/attach a fresh session, queue its prompt once, emit the stage-focus event, and retain the accepted PRD input revision. A completion tool must return without waiting for its child stage to finish.
- **PATTERN:** src/opencode/adapter.ts:435 and src/planning/generation.ts:48.
- **IMPORTS:** Reuse loadProjectConfig, loadRoleInstructions, artifactHash, and the stage session/event adapter from issues 16–17.
- **GOTCHA:** Duplicate calls, a creation/prompt failure, or tool-return completion must not create a second child or cancel the run. Recover ambiguous creation from correlated session metadata before any retry.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `skills/to-issues/SKILL.md; src/planning/artifact-writer.ts; src/planning/graph.ts`

- **IMPLEMENT:** Bundle the full to-issues source and retain exploration, vertical slices, code/test references, task detail, and local Markdown. Explicitly replace tracker setup, output destination, breakdown quiz, and final-message completion with Ralph run paths and completion-tool instructions. Permit only graph.json and safe issues/<number>-<slug>.md drafts for this owner. Align required issue-section validation with the full adapted template.
- **PATTERN:** src/planning/graph.ts:51 and the scoped writer from issue 17.
- **IMPORTS:** Reuse topologicalOrder/validateIssueGraph exports; keep zod strict schemas and stage path allowlists.
- **GOTCHA:** Do not globally relax graph validation to accept any Markdown; keep required context, implementation/task detail, test guidance, acceptance criteria, and dependencies.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `docs/wiki/features/feature-planning.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/feature-planning.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] Wrong-owner, stale-attempt, empty/malformed PRD, and path escapes cannot open a planner.
- [ ] Valid completion records an immutable PRD and exactly one new planner session distinct from the interview/PRD session.
- [ ] The planner receives exact PRD content/hash, approved explanation, pinned commit, repository context and approved commands rather than implicit conversation inheritance.
- [ ] The full skill is bundled; there is no external tracker/setup prerequisite and no issue-breakdown approval prompt.
- [ ] Planner writes are limited to its graph and issue draft directory; accepted PRD bytes cannot be changed.
- [ ] Repeated completion returns the recorded handoff and does not prompt or navigate a new session again.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/tui-input.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [17-approve-explanation-and-author-prd-in-place.md](17-approve-explanation-and-author-prd-in-place.md) — supplies the predecessor behavior required by this slice.
