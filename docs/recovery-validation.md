# Workflow recovery validation — 2026-10-15

Update: the production input and automatic-review limitations recorded below describe the earlier implementation. Native question forms, compiled-host command wrappers, and the automatic review handoff have since been implemented. Current verification is recorded in [the live OpenCode trial](live-opencode-trial.md). Historical test results below are retained with their original scope.

The existing controls, process ownership and restart reconciliation were extended
against the now-present execution, question and repair predecessors. All probes
use pinned Bun 1.4.3, temporary real Git repositories and the public command router
with the controllable OpenCode adapter.

## Behavioral red/green evidence

Each new fix began with its failing public regression, then passed after the
corresponding change:

- Crashes after integration ref advancement, before operation-result append or
  issue-result append, previously blocked valid evidence or stranded `merging`.
  Recovery now binds saved production validation to the exact merger envelope,
  commit, command hash/revision and approval, records completion once, and restores
  the issue to `integrated` without allocating another attempt or merger.
- A stop immediately followed by resume could revive an integration waiting at a
  paused boundary. A held-read regression first recorded an unexpected advance,
  then passed after rechecking the original attempt epoch after each wait.
  Validation also checks its original epoch before dispatching the next check.
- A crash immediately after `update-ref` left the integration index/worktree on the
  old tree. Recovery now finishes only a proven old-index/clean-worktree transition
  using Git's two-tree merge. It refuses ambiguous indexes or local modifications.
  The local-edit preservation case is additional coverage of this guard.
- Restart previously left pending questions with an invalid control epoch. Explicit
  resume renews unanswered request identities and republishes through the main
  session adapter. Old callbacks cannot answer the new question. Answers already
  persisted, authoritative approval records and the remaining active-time deadline
  survive another reopen unchanged.
- Pause previously rejected the active production executor's submission and turned
  an active merger/check into a failed attempt. Existing attempt identities can now
  settle while paused; the next merger/check/ref boundary waits for resume.
- An SDK result without its issue append previously appeared resumable while the
  executor remained `executing`. Uncertain execution/merge completion now blocks
  with retained facts instead of silently stranding work or repeating dispatch.
- Recovery previously ignored active-run lock identity and fully appended ref
  advances. It now retains matching locks, blocks foreign/corrupt owner evidence,
  and verifies the latest accepted integration ref even after its result was saved.

Reconciliation marks its scan pending, rejects controls while inspecting external
state, and compares its epoch/revision before publishing the final summary.
Existing stop regression coverage retains blockers across repeated stops, rejects
resume during bounded cleanup, cancels correlated sessions, and checks real process
ownership plus simulated PID reuse.

## Demonstration

The production router executes a real TDD submission and merger. Injected host
termination happens at three boundaries: immediately after the Git ref update,
before its operation result, and before its issue result. Reopening the common Git
store and reconciling repairs the checkout if necessary and records exactly one
accepted integration. The public router rejects dispatch before explicit resume.
After resume the issue returns the same accepted commit/attempt without another
SDK request. A second reconciliation adds no duplicate integration result.

Question coverage pauses after a real `needs_input` result, advances/reopens the
control epoch, resumes, observes the republished request, rejects the old answer,
and retains the new answer through another restart. The fake clock proves that
five seconds of active execution leaves 25 seconds of the original 30-second
budget. A separate in-flight repair interruption preserves the exact review round
and reserved attempt; its late callback cannot update the workflow or dispatch a
second repair. These last repair assertions extend existing behavior coverage and
did not require a production change. Documentation changes are non-behavior work.

## Limits

Ambiguous publication, check output, repair dispatch or cleanup stays blocked for
explicit evidence-based resolution. Recovery does not invent missing output, replay
side effects, reset budgets or replace a logical active-run lock. Reconciled work
is available to the public scheduler/review entrypoints; unanswered questions are
republished by `/ralph-resume`. Automatic reconstruction of host-supplied functional
review environment/surface/tool options is not implemented.

Production human-input provenance remains unsupported by the predecessor adapter;
these tests supply correlated human responses. No live-provider, native Linux/
Windows process-tree or real OpenCode shutdown smoke was run in this slice. The
existing platform declarations and gated tests remain intact. No package was
published and no target branch was merged.

## Final checks

- `bun run typecheck`: passed.
- `bun run lint`: passed (97 files).
- `bun test tests/integration/14-recovery.test.ts`: 33 passed, 0 failed,
  185 assertions.

An earlier broad run overlapped test development and loaded the pre-fix modules;
it reported the newly added ref-identity and in-flight-validation regressions as
failures. That run is not final verification. The final broad run is recorded
below after completion.

Final frozen-code broad run: `bun test tests/integration` passed 194 tests,
skipped the existing explicitly gated real agent-browser test, and failed none
(1,232 assertions across 15 files). The full suite includes local tarball consumer
and lifecycle fixtures; it does not establish native Linux/Windows or live-provider
coverage. No source changes followed these final checks.
