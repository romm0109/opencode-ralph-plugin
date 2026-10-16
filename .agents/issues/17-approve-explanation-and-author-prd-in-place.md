# 17. Approve the explanation and author the full PRD in the interview session

**Type:** AFK  
**User stories:** PRD §5 stories 3, 4, 5  
**Requirements:** PRD §§7.2–7.4, 9, 10

## What to build

Add `ralph_complete_interview` so the owning interviewer can propose a structured explanation, scope, and acceptance criteria. The plugin resolves and displays the full HEAD SHA and command revision, then obtains native approval that explicitly covers PRD creation, issue planning, and execution. Approval injects the full create-prd skill into the same session and grants a stage-scoped planning writer; rejection returns to grilling. This slice ends with the agent able to write its feature PRD without changing project code. The agent must be instructed to finish with the PRD completion tool introduced by issue 18.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/planning/interview.ts` (lines 50–115) — old human-provenance validation and explanation approval handler.
- `src/planning/artifacts.ts` (lines 1–31) — stable explanation and artifact hashes.
- `src/state/run-store.ts` (lines 483–569) — state writes currently invalidate approvals by artifact revisions.
- `src/planning/prd.ts` (lines 1–79) — old five-heading JSON-only PRD contract and automatic generateIssues call.
- `src/plugin.ts` (lines 339–365) — tool registration pattern with host ToolContext.
- `src/plugin.ts` (lines 459–542) — both catalog filtering and execute-time enforcement points.
- `src/planning/generation.ts` (lines 20–82) — run-root checks, safe artifact names, and atomic revision publication.
- `tests/integration/03-interview.test.ts` (lines 405–443) — changed explanation invalidates carried approval.
- `tests/integration/04-planning.test.ts` (lines 1–120) — planning fixture and current short PRD structure.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Bind native results to requestId, sessionId, revision, and real user provenance as in handleInterviewResponse; do not accept approval in completion-tool arguments. Hash accepted explanation bytes with explanationHash. Model stage writes through a dedicated `ralph_write_planning_file` tool with stage-relative path and content; hide generic write/edit/shell/delegation tools and enforce the same checks in execute.before. This is agent-authored file writing through an enforced tool boundary, not JSON-only prose publication.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### ADD `src/planning/completion.ts; src/plugin.ts`

- **IMPLEMENT:** Register ralph_complete_interview with runId, attempt, text, scope[], and criteria[]; derive the session from ToolContext. Validate nonempty fields and ownership, then persist an explanation proposal and native approval request with the current full SHA, branch, command hash/revision, and explicit automatic-execution wording.
- **PATTERN:** src/planning/interview.ts:63 and src/plugin.ts:339.
- **IMPORTS:** Import z from zod, explanationHash from ./artifacts.js, readReviewGit from ../git/review-workspace.js, commandConfigHash from ../config/commands.js, and type RunStore/OpenCodeAdapter.
- **GOTCHA:** A repeated call must reuse or report the recorded request, not open a second approval or replace an already-approved explanation.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/04-planning.test.ts`.

### UPDATE `src/planning/types.ts; src/state/run-store.ts; src/planning/interview.ts; src/planning/prd.ts`

- **IMPLEMENT:** Record scope authorization against explanation revision/hash, native request/result, SHA, and configuration. Requested changes invalidate it. Upon approval queue create-prd instructions into the existing stage session; do not use the adapter path that creates a new PRD session.
- **PATTERN:** src/planning/artifacts.ts:2 and src/opencode/adapter.ts:481.
- **IMPORTS:** Reuse loadRoleInstructions, loadProjectConfig, and type UserInputResult. Extend the stage session adapter introduced by issue 16 for same-session prompt delivery.
- **GOTCHA:** A queued same-session prompt must not be awaited as a completed child turn from inside its own active tool; persist delivery intent and return control so the host can process it.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/04-planning.test.ts`.

### ADD `src/planning/artifact-writer.ts; src/plugin.ts; skills/create-prd/SKILL.md`

- **IMPLEMENT:** Implement ralph_write_planning_file({runId, attempt, path, content}) restricted to the owning PRD draft directory and PRD.md. Canonicalize and reject absolute/traversal/symlink escapes before writes, including symlink ancestors. Replace the short skill with the full source template and an explicit local output/completion contract.
- **PATTERN:** featureRoot at src/planning/generation.ts:20 and execute.before at src/plugin.ts:499.
- **IMPORTS:** Import realpath, lstat, mkdir, writeFile, rename from node:fs/promises as required; resolve/relative/join from node:path; randomUUID from node:crypto for temporary writes.
- **GOTCHA:** Do not grant generic shell or write tools and hope prompt text prevents source edits. Draft writes must not overwrite root PRD.md, another run, accepted revisions, or files through aliases/code mode.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/04-planning.test.ts`.

### UPDATE `docs/wiki/features/feature-planning.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/feature-planning.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] Completion proposals from an unrelated or superseded session are rejected without side effects.
- [ ] The approval displays explanation, criteria, branch, full pinned SHA, and authorization through implementation; no caller-provided answer can authorize it.
- [ ] No create-prd instructions enter the session before approval; after approval the same session receives the full 15-section template and explicit completion instruction.
- [ ] Rejection or changed scope invalidates old authorization and requires a new displayed revision.
- [ ] The PRD agent can write its run draft through the scoped tool; source edits, traversal, symlinks, foreign-run writes, shell and indirect writes are denied.
- [ ] Existing reviewer observation restrictions, command permissions, and unrelated setup/removal tools still behave correctly.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/04-planning.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [16-start-a-fresh-native-feature-interview.md](16-start-a-fresh-native-feature-interview.md) — supplies the predecessor behavior required by this slice.
