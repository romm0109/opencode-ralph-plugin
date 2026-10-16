# Product and executor questions

## Summary
PRD and issue authors use a stage-owned native product-decision tool. Executors persist `needs_input` on their current attempt and ask in the active workflow session. Human clarification can continue within approved scope; a proposed revised explanation always requires a distinct native scope approval before accepted artifacts can authorize execution.

## Key behavior
- `ralph_request_product_decision` validates stage/session/attempt, records the question and recommendation before delivery, and persists correlated native answers. Pending decisions and scope proposals block completion. Unavailable input retains the request; renewal retries reuse the recorded approval identity.
- Same-scope clarification keeps the current stage and authorization. Semantic discovery remains the agent's responsibility; the plugin does not claim to prove scope equivalence. Package-local authoring/executor instructions explain when to submit `revisedExplanation`.
- Revised explanations invalidate dependent PRD/graph acceptance and execution eligibility. History retains prior explanation, authorization, and accepted artifact references. Approved renewal queues explicit PRD inputs in the current session, then opens a fresh planner with decision and integration context. New immutable artifact revisions link execution eligibility to the renewed explanation approval without a second breakdown/execution gate.
- Resume detects changed HEAD or command configuration before execution and displays the full current SHA, branch, command hash/revision, explanation and criteria for renewed approval. Rejection leaves execution unauthorized. A requested SHA must be checked out; starting inputs cannot change after execution begins.
- Executor questions block the issue and descendants while independent work continues. Human waiting consumes neither deadline nor attempt. Same-scope answers resume the same attempt, worktree and budget with current approved inputs.
- Executor `revisedExplanation` proposals receive a native answer followed by separate explanation approval and planning regeneration. Responses require current request/job/attempt/operation/epoch and artifact revisions. Late and superseded submissions cannot authorize continuation.
- Superseded sessions must settle before approved-scope continuation. Baseline/candidate checks remain enforced. Already integrated commits and attempts are retained; revised planner instructions require follow-up issues for additional work instead of repeating integrated issues. Other pending executor questions receive new revision-bound identities.

## Code references
- `src/planning/questions.ts`, `src/plugin.ts`, `src/opencode/native-input.ts` — stage-owned native decision tool and host delivery.
- `src/planning/completion.ts`, `src/planning/types.ts`, `src/state/run-store.ts` — renewed authorization, history, invalidation and immutable regenerated artifacts.
- `src/commands/resume.ts`, `src/planning/prd.ts`, `src/planning/issues.ts` — pinned-input renewal and explicit revised stage prompts.
- `src/execution/questions.ts`, `src/core/orchestrator.ts` — executor answer correlation, scope proposal and continuation.
- `src/agents/results.ts`, `skills/tdd/SKILL.md` — executor question/proposal contract.
- `src/execution/execute-issue.ts`, `src/execution/attempts.ts`, `src/execution/scheduler.ts` — dependency blocking, independent scheduling and active-time budgets.
- `tests/integration/04-planning.test.ts` — fake native-host questions in real Git projects, clarification, scope invalidation/regeneration, changed-input rejection, stale answers and interrupted approval recovery.
- `tests/integration/09-questions.test.ts`, `tests/helpers/diamond.ts` — independent integration, superseded answers and preserved attempt budgets. The graph-proposal approval case is explicitly historical protocol coverage.

## Related
- [Concurrent execution](concurrent-execution.md)
- [Planning approval](feature-planning.md)

## Notes
The older graph-only `revise_scope` fixture remains historical coverage; native execution requires a revised explanation and regenerated accepted bundle. Fake-host tests establish public boundary behavior, not installed native UI evidence. Installed-host and cross-platform verification belongs to issue 25.

## Last updated
2026-10-16
