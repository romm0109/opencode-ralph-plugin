# Feature execution baseline

## Summary
The native issue owner completes planning with `ralph_complete_issues({runId, attempt, graphPath: "graph.json"})`. Completion validates the written DAG and exactly referenced Markdown, accepts an immutable bundle, then runs preflight and the existing scheduler/reviewer engine without another human approval. The explanation approval authorizes this scope at its pinned SHA and command revision; artifact acceptance derives execution eligibility without inventing a user message.

## Key behavior
- Preflight retains host command permission checks before an executor/merger session exists.
- Continuing an already approved run can retry a failed baseline without silently replacing approvals or resetting attempts.
- `executionEligibility` binds the real explanation request/message, explanation hash, pinned SHA, command hash/revision, accepted PRD and graph bundle hashes. Worker admission, integration, review and recovery use this identity. Native runs cannot use the historical graph approval gate.
- Ownership and attempt checks, strict graph/PRD references, required Markdown sections, safe numbered paths and symlink rejection precede acceptance. Acceptance/publication intent survives retries; concurrent and repeated completions reuse the accepted result without scheduling twice. Interrupted accepted execution uses explicit recovery/resume.
- `preflightRun` verifies artifact hashes, project verification, command hash, canonical repository lock, committed HEAD, selected commit and clean tracked/untracked state. Native runs require current HEAD to equal the explanation-pinned SHA, including when reusing baseline evidence. It never commits or stashes user changes.
- Only exact recorded generated planning files with matching bytes under this run’s confined feature paths are exempt from untracked dirtiness. Other files, including unrecorded files in the same draft directory, still block. No planning auto-commit or blanket ignore is added.
- Branch `ralph/<run-id>` and workspace under the canonical run root are recorded with operation intent before Git mutations. Existing branches block; the user's branch and unrelated worktrees remain unchanged.
- Baseline command envelopes use role `baseline`, attempt zero and no issue ID. Failures consume no issue attempts. Failed baselines attempt environment and owned worktree cleanup; ambiguous ownership blocks deletion.
- `validateCandidate` prepares the environment, runs checks and disposes partial startup. Evidence includes the exact candidate SHA, command revision/hash, lifecycle results and check results. Changed candidate HEAD or tracked files invalidate results.
- A check timeout with successful process cleanup persists that exact ID in `RunRecord.validationSkips`. Later validation skips those IDs; setup/readiness failures and nonzero check exits never qualify. Approved JSON is unchanged. All skipped checks yield `passed_with_omissions`, never `passed`.
- `/ralph-status` and adapter status publication expose baseline readiness/blockers and skips. Compare-and-swap reservations avoid duplicate preflight effects; stale completion cannot publish readiness. Cached readiness rechecks approval, configuration and artifact identity. A matching accepted baseline is reused before fresh-checkout checks; later guard failures throw and preserve its validation evidence instead of overwriting it with a failed baseline.

## Code references
- `src/execution/preflight.ts` — approval gates, baseline orchestration and typed blocker evidence.
- `src/execution/validation.ts` — qualified validation and shared run-local skip policy.
- `src/git/worktrees.ts` — Git argument arrays, owned workspace inspection and guarded removal.
- `src/state/run-store.ts` — baseline events and durable skip persistence.
- `src/planning/completion.ts`, `src/planning/approvals.ts`, `src/planning/eligibility.ts`, `src/planning/artifact-writer.ts` — owned bundle acceptance, derived authorization and exact managed file records.
- `src/planning/issues.ts`, `src/core/orchestrator.ts` — issue prompt and automatic preflight/scheduler continuation.
- `src/recovery/reconcile.ts`, `src/review/snapshot.ts` — recovery and review retain exact authorization evidence.
- `tests/integration/04-planning.test.ts` — registered native completion, invalid graphs/owners, changed inputs, publication receipt recovery and real Git worker/dual-review execution.
- `tests/integration/08-concurrency.test.ts`, `tests/integration/13-review-loop.test.ts` — diamond scheduling, candidate validation and independent reviewers.
- `tests/helpers/packaged-workflow.ts` — packaged native completion flow; setup is committed before scope pinning, generated planning files are never auto-committed.
- `src/process/environment.ts` — optional separate check execution; initial project verification remains strict.
- `tests/integration/05-baseline.test.ts` — real Git fixtures and public command demonstrations.

## Related
- [Planning approval](feature-planning.md)
- [Project commands](project-commands.md)

## Notes
Historical direct planning APIs/tests still describe the former execution approval phase; that phase cannot authorize native runs. Changed native inputs persist blockers; the revision-question workflow belongs to the next slice. Fake-host tests establish tool behavior, not installed native UI evidence. Native Linux/Windows remain unverified locally.

`tests/integration/07-retries.test.ts` verifies injected check deadlines by observing
the scheduled timer fire, then awaits Git integration and cleanup under the unchanged
test deadline. A separate 1.5-second watchdog around the whole operation caused false
failures and allowed unfinished work to outlive fixture cleanup; it is removed.

## Last updated
2026-10-16
