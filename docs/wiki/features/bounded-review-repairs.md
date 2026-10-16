# Bounded review and repair

## Summary
The public `reviewFeature` command boundary joins code and functional review on one pinned commit. It persists review history and a final report for OpenCode status and the read-only dashboard.

## Key behavior
- Both reviewers settle before repairs start. Rejected reviewers retain any already persisted findings.
- Three total review rounds, three attempts per repair, and three feature-wide functional infrastructure failures are separate budgets. Expected TDD red runs stay inside an executor attempt.
- Equivalent criterion/repair pairs become one repair task with both sources, requirements context and evidence. The approved issue graph is unchanged.
- Approved runs default to the existing executor slots, TDD submission parser, serial merger queue and approved candidate checks. Each attempt has a fresh owned branch/worktree and durable intent. Injected pipelines remain supported for hosts and fixtures.
- Permission denial or unconfirmed cancellation stops automatic repairs with retained evidence; it does not allocate phantom retries.
- One clarification exchange per originating finding per round; withdrawal requires reviewer evidence and justification. Missing evidence retains the blocker. Disputes grant no extra round.
- Confirmed blockers take precedence over unavailable review. Missing review is unverified; missing or skipped validation is incomplete-validation. Intermediate skipped checks remain disclosed after later passing checks.
- Terminal reports persist before the coordinator releases the matching active-run lock; another run’s lock is preserved. Concurrent owners and stale reviewer completions cannot finalize a workflow. Interrupted operations require explicit recovery.
- Feature branches, failed repair worktrees, reviewer worktrees and logs remain available. Successful executor/candidate worktrees use normal cleanup, and reports exclude those cleaned paths. Attempt counts aggregate retries by issue without double counting repair jobs. The coordinator does not push, open PRs or merge a target branch.

## Code references
- `src/review/coordinator.ts` — round orchestration and bounded attempt intents.
- `src/review/repairs.ts` — production pipeline, deduplication and evidence-based reviewer clarification.
- `src/review/repair-context.ts` — authorized repair issue lookup outside the approved graph.
- `src/execution/execute-issue.ts`, `src/execution/integrate-issue.ts` — shared TDD/merger path for planned issues and dedicated repairs.
- `src/state/active-run.ts` — owner-checked terminal lock release with durable operation intent.
- `src/reporting/completion.ts` — evidence-based final outcomes.
- `src/state/run-store.ts` — persisted workflow and owner/revision guards.
- `src/dashboard/projections.ts`, `src/dashboard/web/App.tsx` — sanitized review/report visibility.
- `tests/integration/13-review-loop.test.ts`, `tests/browser/review-report.test.ts` — termination paths and report consistency.

## Related
- [Independent code review](independent-code-review.md)
- [Functional review](functional-review.md)
- [Read-only dashboard](read-only-dashboard.md)

## Notes
`reviewFeature` needs approved functional environment/surface/tool options from its host. The scheduler’s existing automatic handoff starts code review; full dual coordination remains an explicit public router call. Missing applicable review stays unverified. Reviewer clarification uses a new read-only session in the originating role with the original review and counterexample context, because the verified adapter creates sessions per dispatch. Live-provider and native Linux/Windows checks remain unrun.

## Last updated
2026-10-15

## Explicit evidence retry

`/ralph-resume <run-id> --review` can retry a terminal unverified report on its unchanged, clean feature commit. It consumes the next of three review rounds, retains prior verdicts and all issue/validation budgets, and requires completed cleanup, current approved commands and repository ownership. A new workflow owner prevents stale finalizers from publishing or releasing its lock. Sources: `src/review/retry.ts`, `src/state/run-store.ts`, `tests/integration/review-retry.test.ts`.
