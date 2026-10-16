# Feature planning

## Summary
Native interviews complete through `ralph_complete_interview`. The plugin displays the explanation, scope, criteria, branch, full resolved HEAD SHA and command revision/hash in a native question. The affirmative option explicitly authorizes PRD creation, issue planning and automatic implementation within that scope. After the actual matching human response, the full create-prd snapshot enters the same session so it can author a feature PRD without editing project code.

PRD authoring now completes through `ralph_complete_prd`. It validates the written full-template draft and exact approved explanation reference, snapshots accepted bytes/hash, publishes an immutable revision, then creates and focuses one fresh issue-planning session. The planner receives explicit artifact and authorization context instead of inheriting the interview conversation.

## Key behavior
- Completion derives session identity from the host and checks the run owner, attempt and active control state. Arguments cannot carry an approval. Native results must match request, revision, session and unique human message identity; commit/configuration changes prevent approval.
- Repeated pending proposals report their recorded request. Accepted duplicates cannot replace the explanation or reopen approval. Rejection returns to grilling; changed scope revokes authorization and dependent artifacts and requires a newly displayed revision.
- PRD instructions include all 15 source template sections, the approved explanation, draft directory and an explicit `ralph_complete_prd` finish instruction. Delivery intent and a stable host message ID are persisted before queueing an inbox prompt. Queue acknowledgement does not wait for another child turn; failed delivery can retry without another approval.
- In the PRD stage, `ralph_write_planning_file` accepts only stage-relative `PRD.md` in `.ralph/features/<run-id>/prd-draft-<attempt>/`. It checks authorization and ownership, rejects symlink ancestors/targets and writes atomically. Root PRDs, source paths, traversal, absolute paths, other runs and accepted revisions are outside its boundary.
- Interview/PRD sessions can observe repository files and ask native questions. Catalog filtering and execution checks deny generic shell, write/edit, delegation, code mode and review aliases. Only the PRD stage gains the scoped writer. Existing reviewer and administrative restrictions remain separate.

- PRD completion requires the owning session/attempt and active authorization, full nonempty required sections, and the supplied explanation revision/hash reference. API Specification and Appendix are optional. Invalid drafts return actionable correctable outcomes without a planner. Traversal and symlink sources are rejected.
- Acceptance intent stores exact bytes before publication. A persisted handoff stores PRD input revision, full adapted skill/prompt and stable message identity before host effects. Creation is correlated by runId/jobId/attempt, reconciled through paginated session metadata, and uses a stable host session ID. Ownership attaches before prompt delivery. Lost prompt receipts reconcile inbox/history; lost focus receipts use TUI event deduplication. Successful repeated calls return the recorded result without new prompts or focus.
- The fresh owner can write only `graph.json` and safe `issues/<number>-<slug>.md` files under `issues-draft-<attempt>`. The former owner cannot replace accepted PRD bytes. Generic writes, shell and delegation remain denied at execution. The full to-issues adaptation preserves exploration, vertical slices, concrete patterns/tasks/test guidance and local Markdown; it removes tracker setup and breakdown approval.
- Graph validation requires nonempty What to build, Context: files to read before implementing, Patterns to follow, Step-by-step tasks, Acceptance criteria, Validation commands and Blocked by sections, plus existing strict graph identity/dependency/cycle checks. Historical test fixtures now use that template too.
- `ralph_complete_issues` validates the owning stage, accepted PRD, unchanged commit/configuration and graph/files. It publishes immutable accepted artifacts and records execution eligibility under the existing scope authorization before starting preflight and scheduling automatically. Duplicate accepted calls return the recorded result without redispatch; prose never starts execution.
- PRD and issue authoring each allow three total attempts. Correctable completion errors stay in the current attempt; settled prose, failure or active-time timeout consumes one. Native questions and pause suspend deadlines. Exhaustion requires an explicit native reset-or-stop choice. Pre-PRD recovery restarts discovery fresh; accepted-stage recovery preserves exact artifacts and remaining budgets.

## Code references
- `src/planning/completion.ts` — proposal validation, ownership, native authorization and validated PRD/issue completion with automatic execution.
- `src/planning/generation.ts`, `src/commands/resume.ts` — authoring budgets, native exhaustion choices and saved-stage recovery.
- `src/execution/preflight.ts`, `src/core/orchestrator.ts` — accepted artifact/authorization checks, isolated baseline and automatic scheduling.
- `src/planning/interview.ts`, `src/planning/types.ts` — human result binding and durable authorization context.
- `src/planning/prd.ts`, `src/opencode/adapter.ts` — same-session prompt delivery intent/queue and refusal to dispatch native PRDs as new jobs.
- `src/planning/artifact-writer.ts`, `src/plugin.ts` — scoped atomic writes, tool registration, catalog and execution boundaries.
- `src/state/run-store.ts` — revision guards and invalidation of scope-dependent authorization/output.
- `skills/create-prd/SKILL.md`, `src/agents/skills.ts` — full packaged template, overrides and mandatory local stage contract.
- `tests/integration/03-interview.test.ts` — fake-host native approval, same-session template, rejection, stale/foreign results, repeated calls, denied delivery retry, writer and permission boundaries in real temporary Git projects.
- `tests/integration/04-planning.test.ts` — native completion, exact accepted bytes/context, duplicate calls, invalid drafts/owners, symlinks, planner permissions and lost creation/prompt/focus receipts in real temporary Git projects; historical graph regressions use the full issue template.
- `src/planning/issues.ts`, `src/planning/generation.ts` — durable fresh-session handoff and recoverable immutable publication.
- `src/planning/graph.ts`, `skills/to-issues/SKILL.md` — required issue content and full adapted local planning skill.
- `src/opencode/bridge.ts`, `src/tui.ts`, `tests/integration/tui-input.test.ts` — issue-stage focus events and location-scoped duplicate navigation suppression.

## Related
- [Execution baseline](execution-baseline.md)
- [Feature interview](feature-interview.md)
- [Workflow recovery](workflow-recovery.md)

## Notes
Fake-host tests verify native completion, automatic execution, retry/recovery contracts and prompt payloads; they are not evidence of real native UI rendering. Installed-host and cross-platform evidence belongs to issue 25.

Legacy JSON generators, graph approval handlers and chat transport have been removed. All feature command entrypoints use native stage services. Unsupported saved workflows cannot resume or migrate; their artifacts remain intact.

## Last updated
2026-10-16
