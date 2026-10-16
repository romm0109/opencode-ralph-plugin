# Workflow controls and recovery

## Summary
OpenCode registers pause/resume/stop commands and invokes reconciliation on restart.
Recovery observes actual state, reports facts, and waits for explicit resume. Native orchestrator/resume invoke stage services directly; workers and reviewers keep their independent sessions and worktrees.

## Key behavior
- Native `/ralph-orchestrator` offers correlated existing-run choices through the native question adapter. A run without an accepted PRD offers fresh discovery or retention; accepted planning offers saved-stage resume, retention, and restart while execution has not begun. Unsupported protocols require a fresh workflow and are not migrated.
- Pre-PRD recovery cancels and inspects unfinished interview/PRD jobs; it records settled unfinished work rather than requiring completion evidence for a draft that will not be accepted. Unconfirmed cancellation or busy/unknown sessions retain the blocker.
- Discovery restart stops and inspects the recorded stage sessions before releasing the exact repository/run owner through a durable release intent/result. Cleanup uncertainty, foreign locks, pending operations and execution work block release. History, drafts and worktrees remain; released runs cannot resume. A fresh interview starts with its opening question and empty transcript.
- Native `/ralph-resume` continues saved stage ownership directly. Reactivation precedes guarded planning writes; it does not rebind a native owner into the invoking chat. Accepted PRD/graph intents finish immutable publication and the necessary handoff or execution boundary. Execution continuation occurs once when acceptance finalization already started it. Resuming completed integrations can collect the existing executor turn for final-review evidence; this observation must not create or prompt another worker.
- Reconciliation verifies accepted PRD bytes and scope authorization, repository ownership and stable host prompt receipts. A supported live authoring attempt with correlated delivery retains its owner and remaining budget through recovery freeze; stopped/blocked owners stay retired. Unknown delivery evidence blocks repeated dispatch. Recovery remains observational until explicit resume.
- Native PRD and issue authoring each allow three total attempts per approved stage, independent of issue/review budgets. Only accepted completion tools advance the stage. A settled turn with final prose, failed turn, or active-time timeout consumes an attempt; correctable completion validation stays in the live attempt.
- Authoring attempts persist the owning session, prompt identity, draft root, captured remaining active-time budget and terminal result. Pending product/approval questions, direct native question tools and pause suspend the deadline. The injected planning clock supports deterministic deadline checks.
- Failure retires tool authority before cancelling the recorded planning job. Retry requires confirmed cancellation and an idle/missing inspected owner; missing PRD interview sessions require intervention. PRD retries retain the same interview session; issue retries use reconciled fresh sessions. Each retry writes a separate draft namespace and receives accepted inputs, decision history, prior draft paths and the failure reason. Retired sessions retain their planning tool restrictions.
- Exhaustion retains the blocker and native recovery request. Only a correlated real native “Reset budget and retry” answer grants another three attempts, with answer provenance recorded in `budgetResets`; “Stop” stops the run. Unavailable native input leaves the request pending and publishes its diagnostic. Stop/pause racing cancellation cannot allocate another attempt. Accepted completion atomically terminates the planning job, so its later turn settlement cannot cancel execution or consume another attempt. Authorized scope transitions retire superseded authoring jobs without aborting the continuing session; obsolete jobs cannot block final review.
- `/ralph-remove` previews deletion of the checkout's `.ralph` and repository-shared saved workflow state. A new user approval is required. It checks the unchanged preview under setup/write locks and refuses active/unsettled jobs or uncertain live processes. It preserves code, branches and workspaces, including unregistered retained workspace directories. Linked-worktree scope is disclosed. Live host bookkeeping remains while the plugin is loaded, allowing a later setup in the same session.
- `/ralph-resume` and `ralph_control` share the typed router resume service. Without an ID, it selects the latest feature ahead of unrelated setup records. `--base <commit>`/`selectedCommit` requests renewed explanation authorization; `--review`/`review` retains explicit review-only retry after terminal ownership release. Options cannot be combined, and unknown flags are rejected.
- Native resume drives the saved phase; it does more than flip the control flag. Pending planning, failed baseline retry, scheduling, and automatic review continuation retain approvals and attempt budgets.
- Pause rejects new jobs and suspends review scheduling while current jobs settle. Production executor submissions retain their attempt identity; mergers and successful in-flight checks wait at the next scheduling/ref boundary rather than becoming failed retries. Each resumed in-flight boundary rechecks the original epoch so stop followed by resume cannot revive a stale callback.
- Stop cancels bound sessions, owned processes and registered environments with bounded cleanup. Late job results cannot advance stopped runs.
- Process ownership requires PID birth identity, owner token, repository and workspace. Owned wrappers watch parent liveness; the dashboard stays in the plugin process.
- Recovery shares the Git common-directory store across worktrees. Already advanced integration intents require exact SHA/check revision evidence and record completion once. Ambiguous operations block resume; validation without output never passes.
- Stop retains existing recovery/cleanup blockers, including repeated stops. Resume cannot race pending stop cleanup. Reconciliation must resolve retained ambiguity.
- Recovery binds production validation to the exact merger envelope, candidate, command hash/revision and approval. It restores the accepted issue result even if the ref or operation result was written before a crash. A proven old index/clean worktree is synchronized with a safe two-tree merge; local changes block recovery.
- Review counters, attempt identities, approvals and artifact revisions are retained; controls do not reset budgets. Native resume preserves the stage owner and correlated unanswered questions.
- Recovery holds a pending control marker through inspection and checks its epoch/revision before publishing. It verifies logical active-run lock identity and the latest accepted refs; uncertain execution/merge/repair completion blocks instead of repeating dispatch.
- An executing attempt with no submission/candidate can be recovered as a consumed failure only after a matching cancelled job, completed abort, idle/missing exact session and proven environment cleanup. Work and attempt history remain available to the next explicit retry. Busy, unknown or mismatched sessions stay blocked.
- Journal locks are replaced only after inspecting their recorded owner birth identity. Missing or corrupt owner evidence does not authorize replacement.

- Native completion keeps PRD authoring in the interview session and opens a fresh issue session. Valid issues start execution under the scope authorization. Preflight tracks known run-owned planning artifacts; users do not commit those generated files for a second execution approval.
- Ordinary-chat feature receipts and question suppression are removed. `ralph_control resume`, router and slash commands use native stage services. Setup saving and previewed removal retain separate approval semantics; removal receipts are owned by `src/commands/removal-approval.ts`. Unsupported records require fresh workflow creation without migration or deleting their artifacts.

## Code references
- `src/commands/orchestrator.ts`, `src/commands/resume.ts`, `src/plugin.ts` — native existing-run selection, fresh restart and saved-stage continuation.
- `src/state/active-run.ts`, `src/commands/control.ts`, `src/state/run-store.ts` — matching stopped-planning release, inspected stage cancellation and guarded reactivation.
- `tests/integration/14-recovery.test.ts` — native first-question restart, uncertain cleanup, foreign/released ownership, immutable PRD tampering, ambiguous prompt evidence, five PRD handoff crash boundaries and three issue acceptance/eligibility boundaries. Real temporary Git projects with deterministic fake-host evidence; not installed native UI proof.
- `src/planning/generation.ts`, `src/planning/types.ts` — durable authoring attempts, bounded retries, native exhaustion recovery and injectable supervision clock.
- `src/opencode/adapter.ts`, `src/plugin.ts` — prompt-specific turn inspection, owned cancellation, native question waits, periodic supervision and retired-session tool confinement.
- `src/planning/completion.ts`, `src/planning/artifact-writer.ts`, `src/state/run-store.ts` — revision-checked acceptance/writes, retirement rejection and terminal planning jobs before downstream handoffs.
- `tests/integration/04-planning.test.ts` — real Git/fake-host cases for three-attempt exhaustion/reset, retained drafts, correctable validation, suspended deadlines, uncertain cancellation, stop/pause races and accepted handoffs. These are deterministic host fixtures, not proof of live native UI behavior.
- `src/commands/remove-project.ts` — previewed project removal preserving code/branches/worktrees.
- `src/tui.ts`, `tests/integration/tui-input.test.ts` — stage navigation and status TUI without custom answer dialogs.
- `tests/integration/chat-workflow.test.ts`, `tests/integration/remove-project.test.ts`, `tests/smoke/opencode.test.ts` — absence of legacy registration, native question availability, unsupported resume rejection and preserved removal approval. Smoke evidence is separate and historical.
- `src/commands/resume.ts`, `src/plugin.ts` — native resume continuation and guarded starting-commit selection.
- `src/commands/control.ts` — dispatch gates and bounded stop cleanup.
- `src/recovery/reconcile.ts`, `src/state/run-store.ts` — facts, guarded recovered-attempt writes and idempotent operation reconciliation.
- `src/git/worktrees.ts` — safe synchronization after a ref update interrupted checkout synchronization.
- `src/core/orchestrator.ts`, `src/execution/execute-issue.ts`, `src/execution/integrate-issue.ts`, `src/execution/validation.ts`, `src/commands/router.ts` — production pause boundaries and resumed question publication.
- `src/process/ownership.ts`, `src/process/owned-child.ts` — owned process inspection and parent monitoring.
- `src/plugin.ts`, `src/state/host-lease.ts` — filesystem host lease shared across isolated OpenCode location modules; only first activation recovers and last disposal stops work. Another live host fails closed; dead birth identities permit recovery.
- `tests/integration/14-recovery.test.ts` — real Git recovery and lifecycle regressions.

## Related
- [Bounded review repairs](bounded-review-repairs.md)
- [Validation evidence](../../recovery-validation.md)

## Notes
Question/approval persistence and executor/validation recovery have public-fixture coverage. Native feature input uses the host question tool; the obsolete chat transport and second execution approval have been deleted. The automatic review handoff reconstructs its approved lifecycle after explicit resume. Ambiguous publication, cleanup and repair operations stay blocked. Native Linux/Windows process trees and interactive live shutdown still require separate evidence.

Documentation audit (2026-10-16, Bun 1.4.3): typecheck, lint, 47 focused protocol/removal/setup/plugin tests and 15 status tests passed. The full integration run finished with 292 passed, one gated browser skip and one failure: `tests/integration/07-retries.test.ts` reported “Injected clock did not terminate check” at its 1.5-second completion assertion. That case also failed unchanged in isolation. This is not a green full-suite result or installed native UI evidence.

## Last updated
2026-10-16

Issue 15 package testing found that a recovery toast awaited during plugin initialization deadlocked the real host. Startup now records reconciliation first and defers the SDK notification to the next event-loop turn; disposal cancels pending notifications. See `src/plugin.ts` and `tests/integration/15-package.test.ts`.

Plugin disposal finishes its host lease even if dashboard shutdown fails. Dashboard shutdown tolerates a listener already closed by OpenCode, preventing a stale closing lease from blocking the next activation.
