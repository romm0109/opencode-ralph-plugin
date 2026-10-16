# Single issue execution and integration

## Summary
An approved, dependency-ready issue executes in an owned worktree at current integration HEAD. A separate merger session combines its committed submission with the latest integration base in a candidate worktree. Only successful validation of that exact candidate permits an expected-old-SHA ref advance.

## Key behavior
- Role guidance separates focused executor TDD, Git-only merger work, and host-owned full validation. Agents should not duplicate the complete host pipeline or run shared-artifact checks concurrently.
- Executor submission JSON has a strict top-level contract: `issueId`, `attempt`, `baseCommit`, `submittedCommit`, `tdd`. Extra commentary fields cause a consumed failed attempt; the retained commit/evidence are reconciled into the retry. Bundled instructions name this contract explicitly.
- `executeIssue` checks execution approval, matching baseline approval/starting SHA, command hash, PRD hash and approved graph. It reserves one attempt durably before creating the worktree. The reservation precedes submission setup, so setup failures consume the same budget as agent and validation failures.
- Jobs capture run/job/issue/attempt/base/revision identity, configured role models, skill content hashes and approved behaviors. Bundled TDD/merge rules remain present with project overrides.
- Submission parsing rejects missing/mismatched output and requires recorded red/green logs with exit codes or a documented non-behavior exception. Git verifies clean owned branch HEAD and ancestry. Expected red test failures are retained evidence, not failed attempts.
- `integrateIssue` reserves merging, dispatches a separate session, retains behavior-conflict feedback, verifies merger ownership/ancestry and runs approved commands with the merger session's permission identity.
- `compareAndAdvanceRef` requires durable successful validation of the exact SHA and current attempt/config/control identity. Candidate changes invalidate acceptance; changed integration HEAD creates a new candidate/session and reruns checks (at most three base rebuilds within the same issue attempt).
- Integration operations retain old/new SHA intent for recovery. User target branches remain untouched. The owned baseline checkout index is synchronized after ref advancement; synchronization failures are recorded without undoing acceptance.
- Accepted integration is recorded before non-forced issue/candidate cleanup. Failed and stale candidate worktrees remain inspectable. Cleanup errors retain accepted status, commit/test evidence and changed files.

- Executor setup/start/readiness uses the approved lifecycle before agent dispatch, with main-session command permission. Runtime allocations and lifecycle evidence are retained on the attempt; denial/cancellation wait, setup timeout consumes an attempt.
- `runIssue` / `createCommandRouter(...).executeIssue` execute and integrate one issue with three total attempts. Attempt history retains executor/merger results, failed check logs, merge feedback and worktree references. Issue agent completions never attest feature completion; the run remains running for independent work/final review. Exhaustion blocks that issue without stopping the entire run; repeat or concurrent calls cannot create a fourth job.
- Executor and merger dispatch use the run's `agentTimeoutMs` (default 1,800,000 ms). An injected clock controls deadlines in tests. Timeout cancellation finishes before repair; late output cannot replace the active attempt. Permission denial and cancellation wait rather than trigger repairs.
- Before repair, owned activity is stopped and retained workspace identity, HEAD and dirty files are reconciled into the executor prompt. Reconciliation or cancellation uncertainty waits for intervention. Failed work is retained, never force removed.
- Candidate validation reuses baseline run-local check IDs across repairs, issues and review validation. Only genuine check timeouts with confirmed cleanup cause skips; setup failures, spawn errors, nonzero exits and cancellation remain distinct. Cleanup always runs. Every check skipped permits integration with `passed_with_omissions`, visible in status; new runs retry the commands.
- The process runner publishes live ownership before waiting, letting `/ralph-stop` kill a running tree and record cancellation without adding a timeout skip.

## Code references
- `src/execution/attempts.ts`, `src/core/orchestrator.ts` — bounded ledger, cancellation, workspace reconciliation and single-issue repairs.
- `src/execution/validation.ts`, `src/process/runner.ts` — omission policy, typed command outcomes and live process ownership.
- `src/execution/execute-issue.ts` — public execution, attempt identity and submission verification.
- `src/execution/integrate-issue.ts` — merger, candidate validation and accepted cleanup.
- `src/agents/results.ts`, `src/agents/skills.ts` — correlated results, TDD evidence and role instructions.
- `src/git/worktrees.ts` — owned worktrees and guarded integration ref mutation.
- `tests/integration/07-retries.test.ts`, `tests/helpers/clock.ts` — fake-clock retry, exhaustion, timeout, permission, cancellation and skip regressions.
- `tests/integration/06-single-issue.test.ts` — real Git and fake SDK red/green demonstration and rejection scenarios.

## Related
- [Execution baseline](execution-baseline.md)
- [Planning approval](feature-planning.md)
- [Concurrent dependency execution](concurrent-execution.md)

## Notes
The public command router exposes bounded single-issue execution and dependency scheduling. Human requirement-question routing remains downstream slice 9. Agent prose is recorded evidence, not independently verified execution provenance. Tests execute on macOS with Bun 1.4.3; native Linux/Windows and credentialed live agent runs were not performed.

## Last updated
2026-10-15
