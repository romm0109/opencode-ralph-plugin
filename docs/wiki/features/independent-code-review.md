# Independent code review

## Summary

Issue 11 adds a code-review phase at the public router/adapter boundary. It freezes
an exact feature commit and committed requirements, supplies execution/check
evidence to an independent session, and persists validated findings and a summary.
Code review alone leaves the feature running and verification incomplete.

## Key behavior

- `createReviewSnapshot` requires a nonempty approved graph and matching persisted
  integrated issues, no integration queue or active implementation jobs, exact
  commit/base SHAs from the store's repository, and committed PRD/graph files.
  The graph must match the supplied approved graph. Snapshot writes use CAS;
  pin/workspace/publication effects have durable operation intents and results.
- The DAG scheduler now hands all-integrated execution to `reviewIntegratedExecution`.
  It checks the integration HEAD against the latest completed ref advance, freezes
  the hash-bound approved PRD and persisted graph/issue texts, and starts round one
  with the `code-review` model override and planning session as publication parent.
  Repeated scheduling reuses the frozen review; functional review/repairs remain
  separate workflow phases. Pending/blocked graphs never reach this handoff.
- Snapshots contain run, round (1–3), SHA, PRD/graph revisions and evidence refs.
  A Git ref pins the commit. Round inputs also freeze the diff, validation summary
  and execution evidence. Each round is immutable; later execution observations
  supersede it and require a newer round.
- `createCommandRouter(...).reviewCode` calls `runCodeReview` through the core phase
  boundary. A fresh detached worktree/session receives the configured model.
  The adapter lists installed tool IDs and enables only read/glob/grep/list;
  mutation, shell, delegation and custom tools are disabled for this job.
  HEAD and all tracked/untracked/ignored changes are checked after the response.
- JSON results require the exact role/SHA/round, nonempty evidence and unique
  finding IDs. Blocking citations must reference a real line in the frozen commit
  or supplied evidence. Style/refactoring findings are normalized to optional.
  Wrong identities, malformed output, vague/nonexistent blocking citations and
  workspace mutations become unverified; stale rounds cannot publish a verdict.
- Result/session identity and summary survive reopening. OpenCode receives a
  workspace-scoped toast; `/ralph-status` exposes the durable findings. Publication
  failures are journaled. No repair, target merge or feature completion occurs.
- Worktrees and pin refs are retained with operation evidence for later recovery
  and cleanup. Repeated completed review calls reuse the stored verdict without
  another session; interrupted operations require reconciliation, not redispatch.

## Code references

- `src/review/types.ts`, `src/review/snapshot.ts` — shared contract and frozen input gate.
- `src/review/after-execution.ts`, `src/execution/scheduler.ts` — automatic handoff and approved planning provenance.
- `src/review/code-review.ts`, `src/review/validate-result.ts` — dispatch, evidence checks and verdict.
- `src/git/review-workspace.ts` — Git-only operations and source citation validation.
- `src/state/run-store.ts`, `src/core/types.ts` — atomic round/result identity and operation ledger.
- `src/core/orchestrator.ts`, `src/commands/router.ts` — public review phase and status.
- `src/opencode/adapter.ts` — SDK read-only tool policy, session/model binding.
- `src/roles/instructions.ts`, `skills/code-review/SKILL.md` — bundled role instructions.
- `tests/integration/11-code-review.test.ts` — real Git and controlled SDK workflow regression tests.

## Related

- [Plugin and durable session results](plugin-session-results.md)
- [Open questions](../open-questions.md)

## Notes

The committed-requirements entrypoint remains available for isolated review callers.
Scheduler reviews instead verify persisted execution approval hashes and copy the
approved artifact contents into durable round inputs; these artifacts need not be
committed in the feature workspace. Functional review and repair dispatch belong
to issues 12/13. Real macOS SDK probes verify observation aliases and mutation denial. Native Linux/Windows behavior remains pending CI; no platform is excluded from these tests.

## Last updated

2026-10-15

Frozen inputs include submission TDD and bounded native executor receipts, including earlier completed attempts when available. Evidence collection is read-only during snapshot reservation so it cannot invalidate the snapshot CAS. SDK dispatch persists receipts before owned worktree cleanup.
