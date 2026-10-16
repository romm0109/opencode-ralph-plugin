# 25. Verify the installed native workflow and record release evidence

**Type:** HITL  
**User stories:** PRD §5 stories 1–8  
**Requirements:** PRD §§8, 11–12

## What to build

Exercise the complete new flow from a packed install, not only internal functions, in two independent consumer repositories. Update deterministic host/model fixtures so completion tools and native question results drive planning, then verify execution through existing TDD, candidate integration, dual review and final report. Add installed-host smoke coverage and a live interactive trial for actual native forms, session focus and visible progress. Record platform-specific evidence and unresolved gaps accurately. This is HITL because interactive native-question and navigation acceptance requires a real human-visible host trial; automatic suites remain agent-executable.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `tests/helpers/packaged-workflow.ts` (lines 13–50) — existing packaged workflow fixture; remove old approval-question auto-commit.
- `tests/helpers/packaged-probe.ts` (lines 1–90) — consumer probe for actual tarball imports.
- `tests/helpers/package.ts` (lines 48–120) — tarball and separate consumer verification.
- `tests/helpers/model-fixture.ts` (lines 1–100) — local deterministic model service for installed OpenCode.
- `tests/e2e/full-workflow.test.ts` (lines 1–24) — verified versus skipped scenarios in two projects.
- `tests/smoke/opencode.test.ts` (lines 55–90) — real pinned OpenCode process and model-fixture lifecycle.
- `tests/integration/15-package.test.ts` (lines 1–52) — package isolation and deferred recovery-notification coverage.
- `scripts/package-smoke.ts` (lines 1–21) — generated evidence reports fixture scope and release blockers.
- `package.json` (lines 1–121) — package files, pinned versions and scripts.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Use package.ts consumer isolation and the lockfile/pinned CLI smoke pattern rather than testing developer absolute skill paths. Model fixtures may emit deterministic tool calls but must not directly mark stages accepted or fabricate human provenance behind the form boundary. Keep automated fixture evidence separate from a credentialed/interactive live trial. All build/browser/package/test commands run sequentially in the same checkout.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `tests/helpers/packaged-workflow.ts; tests/helpers/packaged-probe.ts; tests/helpers/model-fixture.ts; tests/helpers/fake-opencode.ts`

- **IMPLEMENT:** Drive command startup, native questions, scoped file authoring, completion calls and exact session reuse through public interfaces. Remove JSON-final-response planning and hidden git commits at the old approval gate. Cover a passing run and a run with timed-out skipped validation in separate consumers.
- **PATTERN:** tests/helpers/packaged-workflow.ts:30 and tests/helpers/package.ts:48.
- **IMPORTS:** Reuse createFakeOpenCode/createFakePluginContext, createModelFixture, verifyPackage, readFile/writeFile, and existing project Git helpers.
- **GOTCHA:** Do not fake accepted authorization by mutating store state. Fixture-native answers must settle real pending request identities through the same boundary as the host.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/15-package.test.ts`.

### UPDATE `tests/e2e/full-workflow.test.ts; tests/smoke/opencode.test.ts; tests/integration/15-package.test.ts; tests/browser/dashboard.test.ts`

- **IMPLEMENT:** Assert startup without ralph_workflow, mandatory opening form, same-session PRD, fresh issues, one automatic execution start, real permission denial handling, bounded retries/recovery, and visible final qualified results. Verify full bundled skills are in the tarball and no author-machine paths are needed.
- **PATTERN:** tests/smoke/opencode.test.ts:55 and tests/e2e/full-workflow.test.ts:4.
- **IMPORTS:** Use existing pinned @opencode/cli launch/model fixture and Bun/Playwright test harnesses; keep host process shutdown bounded.
- **GOTCHA:** No API-only assertion proves visible TUI navigation; retain a live interaction checklist for that evidence.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/15-package.test.ts`.

### UPDATE `docs/live-opencode-trial.md; docs/live-opencode-evidence.json; docs/package-validation.md; docs/wiki/features/package-distribution.md`

- **IMPLEMENT:** Run the sequential checks below, conduct a human-visible installed trial, and record exact runtime/dependency/platform results, artifact references and blockers. Verify no workflow continues outside OpenCode lifetime and no push/target merge/PR occurs.
- **PATTERN:** scripts/package-smoke.ts:5 and existing evidence document format.
- **IMPORTS:** No production imports; update evidence using captured results rather than manually marking unrun checks passed.
- **GOTCHA:** Linux/native Windows evidence may require other hosts or CI. Missing evidence remains an explicit release blocker, not a claimed success or reason to redesign the workflow.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/15-package.test.ts`.

### UPDATE `docs/wiki/features/package-distribution.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/package-distribution.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] Two clean consumer repositories load the tarball, bundled full skills, dashboard assets and new tools with isolated canonical state.
- [ ] Installed native flow demonstrates opening form, recommended grilling, ASD-STE100 instructions, scope/SHA approval, PRD session reuse, fresh issues and automatic execution.
- [ ] Workers and reviewers execute with existing checks and produce accurate verified-versus-skipped completion reports.
- [ ] Duplicate handoff, denied permission, stop/restart and unavailable native-question behavior have public-interface coverage.
- [ ] A live interactive trial records native form rendering, stage navigation and visible progress; synthetic evidence is labeled separately.
- [ ] All required checks are run sequentially and evidence identifies exact versions/platforms plus any unresolved release blockers.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/15-package.test.ts
bun run test:status
bun run test
bun run build
bun run test:browser
bun run test:package
bun run test:e2e
bun run test:smoke
OPENCODE_SMOKE=1 bun test --timeout 180000 tests/smoke/opencode.test.ts
```

The live HITL trial must use the actual OpenCode interface, answer native forms, inspect session switches and progress, and record evidence. If credentials or a platform are unavailable, report that limitation rather than claiming the trial passed.

## Blocked by

- [24-remove-obsolete-chat-workflow-protocol.md](24-remove-obsolete-chat-workflow-protocol.md) — supplies the predecessor behavior required by this slice.
