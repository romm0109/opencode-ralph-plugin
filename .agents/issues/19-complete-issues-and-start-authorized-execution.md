# 19. Validate written issues and start execution from the pinned approval

**Type:** AFK  
**User stories:** PRD §5 stories 3, 5, 8  
**Requirements:** PRD §§7.3–7.10, 10–11

## What to build

Implement `ralph_complete_issues` to validate and accept the stage-written dependency graph and Markdown files, then automatically run preflight and the existing scheduler. Derive execution eligibility from the human-approved explanation, pinned commit, unchanged commands, and accepted artifact hashes. Remove the need for a second human execution approval without weakening exact-candidate checks or recovery evidence. Make managed planning artifacts compatible with clean-checkout validation without committing or ignoring unrelated user work. Demonstrate the path through a real temporary Git project and the existing worker/reviewer engine.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/planning/issues.ts` (lines 1–95) — graph validation/publication followed by execution_approval.
- `src/planning/graph.ts` (lines 1–84) — strict graph validation and dependency ordering.
- `src/planning/approvals.ts` (lines 1–42) — old second-user-approval and graph-hash matching.
- `src/core/orchestrator.ts` (lines 35–61) — execution approval boundary and preflight-to-scheduler flow.
- `src/execution/preflight.ts` (lines 74–159) — old approval checks, artifact hashing, committed SHA, dirty checkout rejection.
- `src/state/run-store.ts` (lines 483–569) — carried artifact approval invalidation.
- `src/recovery/reconcile.ts` (lines 42–81) — validation evidence currently bound to executionApproval.
- `tests/integration/05-baseline.test.ts` (lines 1–90) — baseline fixture and real Git validation.
- `tests/helpers/packaged-workflow.ts` (lines 30–48) — old fixture commits artifacts during execution approval; no longer valid.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Keep validateIssueGraph/topologicalOrder and issueBundleHash as acceptance boundaries. Represent human scope authorization separately from derived accepted-bundle execution eligibility: accepted PRD/graph hashes may be recorded after the human approval, but must not invent a new human message. Reuse preflightRun, scheduleReadyIssues, finalizeExecution/runAutomaticReview, and exact candidate/command evidence rather than starting a replacement execution engine.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `src/planning/completion.ts; src/planning/issues.ts; src/planning/approvals.ts; src/planning/types.ts`

- **IMPLEMENT:** Register ralph_complete_issues({runId, attempt, graphPath}). Read exactly referenced local issue files, validate the accepted PRD reference, IDs, paths, content and DAG, then publish an immutable bundle. Persist execution eligibility linking artifact hashes to explanation authorization and pinned SHA. Remove the second execution-approval phase from the new flow.
- **PATTERN:** src/planning/graph.ts:51 and src/planning/artifacts.ts:22.
- **IMPORTS:** Import validateIssueGraph, topologicalOrder, issueBundleHash, artifactHash, and type ArtifactRevision; reuse readFile and safe path code.
- **GOTCHA:** Do not call recordApproval with an invented user result. Repeated completion must not schedule workers twice or replace a previously accepted bundle.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts tests/integration/08-concurrency.test.ts tests/integration/13-review-loop.test.ts`.

### UPDATE `src/execution/preflight.ts; src/core/orchestrator.ts; src/state/run-store.ts; src/recovery/reconcile.ts`

- **IMPLEMENT:** Check derived eligibility consistently in baseline, scheduler/review preparation, and recovery. Compare current HEAD with the pinned SHA before execution, validate command hash/revision and immutable artifacts, then run approved baseline and existing execution/review continuation automatically. Return a persisted blocker for changed inputs; issue 20 supplies the revision-question loop.
- **PATTERN:** src/execution/preflight.ts:74 and src/core/orchestrator.ts:45.
- **IMPORTS:** Reuse preflightRun, scheduleReadyIssues, approvalMatchesRevision (change its semantics/name intentionally), and runAutomaticReview; keep existing command authorization.
- **GOTCHA:** Every reference to executionApproval in execution/review/recovery must be audited; removing only the UI gate would bypass or break existing invariant checks.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts tests/integration/08-concurrency.test.ts tests/integration/13-review-loop.test.ts`.

### UPDATE `src/execution/preflight.ts; tests/helpers/single-issue.ts; tests/helpers/packaged-workflow.ts; tests/integration/05-baseline.test.ts`

- **IMPLEMENT:** Treat only exact recorded run-owned generated planning files as managed artifacts for dirtiness checks where needed; verify ownership/path confinement and accepted hashes. Keep unrelated tracked/untracked files blocking. Pass accepted PRD/issues explicitly to worker jobs as today. Replace fixture auto-commits tied to the old approval question.
- **PATTERN:** src/execution/preflight.ts:149 and tests/helpers/packaged-workflow.ts:30.
- **IMPORTS:** Use gitOutput/readReviewGit and existing filesystem/artifact helpers; do not add git add/commit to production planning.
- **GOTCHA:** A blanket .ralph ignore rule or automatic commit changes user policy and can hide user work. Pinning precedes artifact generation, so fixture commits would change the approved HEAD.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts tests/integration/08-concurrency.test.ts tests/integration/13-review-loop.test.ts`.

### UPDATE `docs/wiki/features/execution-baseline.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/execution-baseline.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] Valid issue completion reaches baseline/scheduling without another question; existing workers/reviewers retain independent sessions.
- [ ] Duplicate IDs, cycles, unknown dependencies, missing/foreign issue files, wrong PRD revision and stale owner calls cannot start execution.
- [ ] The exact approved SHA and command revision are enforced; changed HEAD/config/artifacts block before baseline or workers.
- [ ] Only recorded managed planning outputs are exempted from dirtiness checks; unrelated tracked/untracked work remains blocking and no user files are auto-committed.
- [ ] Derived authorization is traceable to the real scope approval and exact accepted bundle; no fictional user approval is persisted.
- [ ] Diamond scheduling, candidate checks before integration, skip reporting, two reviewers, and retained final branch continue to work.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/04-planning.test.ts tests/integration/05-baseline.test.ts tests/integration/08-concurrency.test.ts tests/integration/13-review-loop.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

- [18-complete-prd-and-open-fresh-issue-planning.md](18-complete-prd-and-open-fresh-issue-planning.md) — supplies the predecessor behavior required by this slice.
