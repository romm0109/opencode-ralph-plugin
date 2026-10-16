# Concurrent dependency execution

## Summary
Approved execution continues from a validated baseline into the DAG scheduler. It reuses the single-issue TDD/retry path, leases two executor slots by default, and serializes candidate integration independently of those slots. The router also exposes `scheduleIssues(runId)` for a prepared run.

## Key behavior
- Admission tickets are registered before asynchronous state reads, preserving approved graph order for ready executors. The ticket is released after FIFO slot reservation, not after execution; jobs still overlap within the configured cap.
- Readiness depends on integrated attempt state, never agent completion/submission. Qualified integration with omissions unlocks children while preserving verification debt.
- Graph selection order is stable; asynchronous setup can finish in a different order. Submissions enter one arrival-ordered integration queue. Every candidate refreshes integration HEAD, validates its exact commit, then advances the feature ref.
- Exhausted prerequisites block descendants; independent branches continue. Waiting attempts remain blocked. Repeated scheduler calls share the active owner across canonical store instances; public single-issue integrations share the queue.
- Executor slots cover each attempt's setup, dispatch and owned cleanup, ending before queued integration. Repairs reacquire a slot; direct single-issue calls share the same pool. Project concurrency is a positive integer, default two; the repository's existing active-run lock is separate.
- `execution.observed` and `issue.changed` snapshots expose pending/ready/running/integration_queued/integrated/blocked/failed states, queue order, check evidence and incomplete verification. The status command includes this projection.
- For compact command progress, existing-run `/ralph-status` JSON adds `issueSummary`: numeric `total`, `pending`, `ready`, `running`, `integration_queued`, `integrated`, `blocked`, `failed`. Only the selected run's `execution.issues` counts: total is array length, repeated statuses count individually and absent statuses are zero. Missing execution or empty issues yields eight zeros. Planning issues, issue attempts and other runs never contribute. Existing fields, explicit lookup and last-list-entry selection are unchanged; no-run responses never include the summary.
- Approved `resources` map environment source names to `port`, `namespace` or `directory`. Commands reference them through existing `env` mappings; missing allocations are blockers. The executor prompt receives values. Candidates prepare their own allocations.
- Approved `exclusiveResources` serialize shared resource use. Startup without allocated ports uses conservative serialization. No commands are invented or modified for isolation.
- Allocation and directory cleanup journal intent before effects. Resource values are accessible only through the owned job lease. Cleanup releases owned directories/ports/locks after successful process cleanup; failed cleanup retains ownership/evidence. Preparation/disposal are idempotent for the same environment and job identity.
- Concurrent journal writes retry their revision compare-and-swap while retaining attempt/validation/control identity. An unrelated active-control event cannot turn a genuine check omission into a repair.
- Main-session permission authorizes lifecycle commands before the executor session exists. Agent/session identity remains separately correlated. Setup denial/cancellation waits without a fabricated repair.

## Code references
- `src/execution/scheduler.ts`, `src/execution/readiness.ts` — stable readiness and status projection.
- `src/execution/executor-slots.ts`, `src/execution/execute-issue.ts` — shared executor slots across DAG and direct issue entrypoints.
- `src/execution/integration-queue.ts`, `src/execution/integrate-issue.ts` — shared serial integration and fresh candidate bases.
- `src/core/orchestrator.ts`, `src/commands/router.ts` — automatic baseline handoff and public scheduling boundary.
- `src/commands/router.ts`, `tests/integration/01-plugin.test.ts` — execution-only command summary and public dispatch tests for counts, selection, defaults, optional fields and unchanged no-run forms.
- `src/process/environment.ts`, `src/process/runner.ts` — approved allocation, exclusive leases, permission identity and owned cleanup.
- `src/config/commands.ts`, `skills/command-discovery/SKILL.md` — approved resource declarations.
- `src/state/run-store.ts`, `src/execution/validation.ts` — concurrent attempt projections, journal events and retry-safe timeout omission persistence.
- `tests/integration/08-concurrency.test.ts` — real-Git diamond plus independent E, exhaustion, queue separation, service isolation, owned cleanup, shared serialization and omissions.

## Related
- [Single issue execution and integration](single-issue-integration.md)
- [Execution baseline](execution-baseline.md)
- [Project lifecycle commands](project-commands.md)

## Notes
Tests use temporary real Git repositories, per-job controllable fake OpenCode SDK responses, actual Bun red/green tests and fixture HTTP services. Native Linux/Windows and credentialed live OpenCode smoke are not claimed. The in-process scheduler and resource owners require the existing interruption/recovery boundary after process exit; they do not restart autonomous work. Executor questions now release capacity and resume the same attempt; see [executor questions](executor-questions.md).

## Last updated
2026-10-15
