# Ralph Orchestrator — Product Requirements Document

**Status:** Draft for review; requirements, not an implementation-completion report  
**Date:** 2026-10-16  
**Product:** Reusable OpenCode plugin with deterministic stage control  
**Source:** Repository inspection and the feature interview in this conversation  
**Revision:** Replaces the previous workflow requirements. No backward compatibility.

## 1. Executive Summary

Ralph turns a feature request into a reviewed implementation. The plugin directly handles `/ralph-orchestrator`, opens a fresh interview session, and supplies the full grill-me skill with instructions for that stage only. The interviewer first asks what feature the user wants to build, explores the repository, and asks recommended questions through OpenCode's native question tool. When the relevant decisions are resolved, it explains the feature using ASD-STE100 writing instructions and requests approval to advance.

That approval authorizes PRD creation, issue planning, and execution within the agreed scope from a displayed, pinned starting commit. The plugin injects the full create-prd skill into the same interview session. Valid PRD completion opens a fresh session containing the full adapted to-issues skill and explicit approved artifacts. Valid issue completion starts execution automatically. There is no issue-breakdown review or second execution-approval gate. Each planning stage must call a completion tool; the plugin validates artifacts and owns every transition.

This change replaces startup, interview, planning, and their integration with execution. It retains the existing isolated workers, dependency scheduling, sequential candidate integration, approved checks, TDD, independent reviewers, and read-only dashboard. The user follows the active stage in OpenCode and sees progress and final results there. Existing workflow protocols and saved runs are not supported or migrated.

## 2. Mission

Make feature development deterministic in its control flow and clear in its human decisions.

- Let plugin code control startup, approvals, handoffs, and execution eligibility.
- Give each agent only its current stage responsibilities.
- Resolve product decisions with the user and repository facts through exploration.
- Bind automatic execution to explicit scope approval and validated artifacts.
- Preserve bounded execution, evidence, and honest recovery and reporting.

## 3. Target Users

### Primary user

A developer who uses OpenCode and Git, understands project checks, and wants to describe a feature without manually launching each planning stage. The user makes product decisions during discovery and authorizes implementation through the explanation approval.

### Secondary user

A maintainer who installs Ralph in several repositories and needs reusable skills, project-specific command configuration, consistent worker behavior, and visible failure recovery.

### Needs and pain points

The current command delegates startup to an assistant through a workflow prompt. Its chat-reply protocol disables the native question tool while waiting, exposes downstream orchestration instructions, and can report inactive-run resume failures as revision conflicts. The bundled planning skills are shortened versions of the user's actual skills. The new flow must remove these mismatches without redesigning the execution engine.

## 4. MVP Scope

### Core functionality

- ✅ Direct, deterministic slash-command startup after approved project setup.
- ✅ Fresh interview session and a mandatory opening feature question.
- ✅ Native question forms for interview input, approvals, product decisions, and recovery choices.
- ✅ Full grill-me and create-prd skills; full to-issues skill adapted to the agreed workflow.
- ✅ ASD-STE100 feature explanation, approved before PRD authoring.
- ✅ PRD authoring in the interview session; issue planning in a fresh session.
- ✅ Validated completion-tool handoffs and automatic execution after issues.
- ✅ Renewed explanation approval when product scope changes.

### Technical and integration scope

- ✅ Durable stage/session identity, artifact revisions, attempts, and approval provenance.
- ✅ Follow the active stage in the OpenCode interface; show execution progress and results in the issue-planning chat.
- ✅ Stage-specific tool access and planning-artifact write boundaries.
- ✅ Three total attempts for each PRD or issue-planning stage before intervention.
- ✅ Restart interrupted grilling; recover later stages from saved artifacts.
- ✅ Preserve existing execution, review, dashboard, and project-command behavior except where the new flow requires integration changes.

### Distribution and platform scope

- ✅ Reusable installed plugin with bundled skills and pinned OpenCode dependencies.
- ✅ Existing macOS, Linux, and native Windows product support remains required.
- ✅ One active feature workflow per repository, including linked worktrees.

### Out of scope

- ❌ Legacy workflow tools, ordinary-chat approval transport, old-state migration, or compatibility shims.
- ❌ A separate ASD-STE100 compliance checker or certification claim.
- ❌ User approval of issue granularity or a second approval immediately before execution.
- ❌ External issue trackers, automatic target-branch merge, push, deployment, or PR creation.
- ❌ Workflow execution independent of OpenCode's lifetime.
- ❌ A redesign of scheduling, integration, retry budgets, or final-review policy.

The check marks identify required scope; they do not claim that implementation is complete.

## 5. User Stories

1. **As a developer, I want the plugin to start the interview directly, so that startup does not depend on an assistant choosing a tool.** Invoking `/ralph-orchestrator` opens a fresh interview and its opening question without showing an orchestration prompt.
2. **As a feature owner, I want focused grilling with recommended answers, so that I resolve requirements before authorizing work.** For a password-reset feature, the agent reads existing authentication code and asks about unresolved expiry and error behavior.
3. **As a feature owner, I want a clear explanation and one scope approval, so that I know what automatic planning and execution will build.** The approval shows the explanation, criteria, and exact starting commit and states its authorization clearly.
4. **As a developer, I want each planning stage to receive the intended full skill, so that PRDs and issues retain the detail of my existing workflows.** The PRD uses the full template, while issue files contain concrete code and test references.
5. **As a developer, I want validated handoffs, so that agent prose cannot accidentally start the next stage.** Repeating a PRD completion call cannot create two planner sessions.
6. **As a feature owner, I want new product decisions brought back to me, so that automatic execution stays within approved scope.** A planner that discovers an unspecified retention requirement asks through the question tool and obtains revised approval if scope changes.
7. **As a developer, I want explicit recovery choices, so that interrupted work does not silently restart or use a different interview context.** Interrupted grilling restarts in a fresh context; a completed PRD can support later-stage recovery.
8. **As a maintainer, I want existing worker and review guarantees preserved, so that the new planning experience does not weaken implementation checks.** Candidates still pass approved checks before integration, and both final reviewers inspect the same stable commit.

## 6. Core Architecture & Patterns

### 6.1 Deterministic state machine

The normal flow is:

`configured → interview → explanation approval → PRD authoring → issue planning → preflight/baseline → execution → final review → result`

The plugin owns state transitions. Agents perform discovery, writing, implementation, and review within their stage. An agent's final message or a successful tool invocation alone is not proof that artifacts, Git operations, or checks are valid. Waiting, paused, interrupted, failed, and blocked conditions are distinct from completed stages.

### 6.2 Session boundaries

| Stage | Context and visible session |
| --- | --- |
| Interview | Fresh session; full grill-me skill and interview-only instructions; no injected downstream workflow instructions |
| PRD | Same session after approval; inject full create-prd skill, stage instructions, approved explanation, and pinned commit |
| Issues | Fresh session; full adapted to-issues skill, exact PRD, approved explanation, project references, and explicit stage contract |
| Execution and review | Existing independent worker/reviewer sessions; progress and final report appear in the issue-planning chat |

Use OpenCode session navigation to follow the interview and issue stages. Session switches must not create duplicate work. Context isolation means that Ralph does not inject later-stage instructions into grilling; repository exploration may still encounter documentation that mentions those stages.

### 6.3 Responsibilities

| Component | Responsibility |
| --- | --- |
| Command handler | Validate setup and ownership, then initiate the correct workflow action directly |
| Orchestrator | Durable stage transitions, authorization, attempts, handoffs, and recovery |
| OpenCode adapter and TUI | Sessions, native questions, navigation, permissions, progress, and lifecycle |
| Planning agents | Explore code and write only their permitted planning artifacts |
| Completion tools | Validate stage identity and artifact content, record completion, and trigger one transition |
| Existing execution services | Workers, candidate integration, approved commands, review, cleanup, and reporting |

### 6.4 Artifacts and durable records

Keep existing per-feature artifact conventions under `.ralph/features/<run-id>/`: a PRD, local Markdown issues, and a machine-readable dependency graph. Keep canonical runtime state and repository ownership shared through the Git common directory. Never replace the repository's own root PRD as a side effect of a feature agent authoring a feature PRD.

Persist stage identity, owning session, attempt, selected skill hashes, pending request identity, user-answer provenance, approved explanation revision, starting SHA, command configuration revision, artifact hashes, and handoff intent/result. Bind completion to exact artifact bytes. New workflow records must be distinguishable from unsupported old records; no old schema needs conversion.

## 7. Tools and Feature Specifications

### 7.1 Project setup and direct startup

`/ralph-commands` continues to explore the project, propose commands, obtain approval, and validate and save configuration without executing it. Missing approved setup prevents interview startup and gives an actionable direction to run setup.

For this repository, proposals must include both `bun run test:status` and `bun run test`. The focused command supports quick public-interface TDD cycles. The full integration suite remains mandatory for candidate integration and final validation. Never change approved commands during a feature run.

`/ralph-orchestrator` must not inject a prompt asking the current assistant to choose start/resume tools. With valid setup and no active run, it creates and focuses the interview session directly. If a supported run owns the repository, show its phase and use the native question tool for applicable recovery or stop-and-restart choices. Starting fresh requires settled cancellation and ownership cleanup; preserve prior artifacts and work.

### 7.2 Grilling, explanation, and approval

Always begin with a native question asking what feature to build. If the slash command included a description, show it for confirmation rather than skipping the question. Use the full grill-me skill: explore discoverable facts, resolve dependent decisions, and provide a recommended answer for each substantive interview question.

Stop grilling when scope, acceptance criteria, constraints, and failure behavior are resolved. Explain the agreed feature using ASD-STE100 writing rules and vocabulary conventions as instructions. This replaces the old informal simplified-English requirement. There is no separate compliance-validation stage and no claim of certification.

Present the explanation, scope, observable criteria, current branch, and full resolved HEAD SHA. Ask through the native question tool whether the user approves advancing through PRD creation, issue planning, and implementation within that scope. The affirmative option must make this authorization clear. Approval is bound to this displayed revision, commit, configuration, and actual human response. Rejection or requested changes return to grilling; a new revision needs new approval.

### 7.3 PRD authoring and issue planning

Approval deterministically injects the full create-prd skill and PRD-stage prompt into the interview session. Preserve its comprehensive section structure. Tell the agent to write the run-specific PRD and finish by calling the PRD completion tool. It may explore the repository and write its stage artifacts, but it may not implement project code or start other stages itself.

The completion tool validates the owning stage/session/attempt, required PRD structure, nonempty content, approved explanation reference, and permitted artifact paths. Missing product decisions require a native question; they must not be silently invented. Record the accepted PRD revision before starting the next stage.

Create and focus a fresh issue-planning session. Supply the exact PRD revision and content, approved explanation, pinned commit, project instructions, approved commands, and full adapted to-issues skill. Retain deep code exploration, thin vertical slices, concrete patterns, dependencies, and self-sufficient implementation/test guidance. Adapt the skill to local feature artifacts, omit its setup/issue-tracker prerequisites, and skip its user breakdown-review step.

The planner writes Markdown issues and a graph, then calls the issue completion tool. Validate unique IDs, safe file references, required content, PRD identity, missing dependencies, and cycles. Invalid submissions stay in the current stage and return actionable errors. Valid completion authorizes preflight and execution automatically under the existing explanation approval. Publish artifact references and an execution summary without asking for another approval.

### 7.4 Scope changes, authorization, and preflight

If authoring or planning discovers a new product decision, ask through the native question tool. If the answer changes scope, revise the explanation, present the resulting scope and criteria, and obtain renewed approval. Invalidate dependent planning outputs and regenerate them as needed. Technical choices within approved scope do not require a new gate.

Before execution, verify the approved explanation, accepted PRD and issue graph, pinned starting SHA, unchanged command configuration, and clean working checkout under existing preflight rules. A changed starting point pauses the workflow and requires the user to approve the revised starting point with the explanation. Do not silently use the newest HEAD.

Generated planning artifacts must be handled consistently with clean-checkout requirements: keep them in the managed artifact area and exclude only known run-owned generated files from dirtiness checks where necessary. Never discard or ignore unrelated user changes. Do not silently commit user files to satisfy preflight.

Create the feature integration branch at the pinned starting commit. Run approved setup and baseline checks before scheduling issues. A completed failing check blocks execution and consumes no issue attempt. A timed-out validation check follows the existing run-local skip policy, including at baseline. Setup and readiness failures cannot be skipped into readiness.

### 7.5 Dependency scheduling and execution

Run up to two eligible issues concurrently by default. An issue is eligible only when every dependency has been integrated and passed all non-skipped checks. Agent completion alone does not satisfy a dependency.

Create each issue's branch and worktree from the latest integration commit when it starts. Executors receive the approved issue, PRD, relevant project instructions, configured model, and TDD instructions. Concurrent environments must have separate resources where isolation is required.

If an executor cannot resolve a requirement from the PRD or code, ask its question through the native question tool in the active workflow chat. Block that issue and its dependents while independent work continues. If the answer changes approved scope, revise the relevant artifacts and obtain renewed explanation approval before dependent implementation.

### 7.6 TDD requirements

Implement one behavior at a time: write a meaningful failing test through a public interface, observe the expected failure, implement the minimum change, then refactor while tests remain green. Do not write a batch of speculative tests before all implementation. Repair executors follow the same process, normally beginning with a regression test.

The approved issue plan supplies the intended behaviors and interface changes, avoiding a redundant approval at every TDD cycle. Record red/green evidence in execution logs. Expected red-stage failures do not consume issue repair attempts. Documentation or configuration changes with no meaningful automated behavior test may use a documented exception plus appropriate validation.

### 7.7 Integration and worktree lifecycle

A separate merge agent combines each completed submission with the latest integration branch in a temporary candidate worktree. Integration is sequential even when execution is parallel.

The merger may resolve mechanical conflicts. Conflicts requiring behavior or feature decisions return to the executor with context and consume the issue's attempt budget. The command runner validates the candidate commit using approved checks. Only then does the orchestrator advance the integration branch to that exact candidate. Never advance the feature branch first and rely on rollback after failed checks.

After successful integration and checks, remove the issue worktree. Retain its commit references, execution evidence, and logs. Preserve failed worktrees for diagnosis. Cleanup failure is reported and must not reverse an otherwise recorded integration or delete unrecognized user work.

### 7.8 Attempts, timeouts, and command skipping

| Event | Required behavior |
| --- | --- |
| Issue submission fails completed validation | Return check output to executor; allow three total issue attempts: initial attempt plus two repairs |
| Agent gets stuck or times out | Stop that attempt and retry from reconciled saved work; consumes the same three-attempt budget |
| Issue exhausts attempts | Block issue and dependents, continue independent work, request user intervention |
| Validation check times out | Terminate its owned process tree, skip that check ID for the remainder of the feature run, and record the omission |
| Every validation check is skipped | Continue execution and review; report missing automated validation and never label it fully verified |
| Setup or startup times out | Do not skip; retry within the affected task's attempt budget, then block affected work |
| Check exits nonzero | Treat as a failure, not as a timeout or a reason to disable it |

The skip list is run-local, applies to later issues and review validation, and never modifies approved JSON. Future features try the commands again. Skipping a validation command must not skip environment cleanup or secretly remove another check.

Implementation default: command timeouts are explicit in the approved JSON, with a suggested ten minutes for ordinary checks and configurable longer setup budgets. Agent attempts default to a configurable thirty-minute deadline. These durations were not prescribed by the user and must be visible in configuration.

### 7.9 Final reviewers and repair loop

After all issues integrate, run a code reviewer and a functional reviewer in separate sessions against the same feature commit. Keep that commit stable while both review it.

- The code reviewer checks correctness, security, regressions, and approved requirements.
- The functional reviewer derives a checklist from PRD and issue acceptance criteria. It uses agent-browser for relevant UI behavior and HTTP requests for relevant backend behavior against the local feature environment.
- Record evidence for each applicable criterion. A criterion that cannot be tested is unverified, not passed.
- Blocking findings are bugs, security issues, failing behavior, or unmet acceptance criteria. Optional style and refactoring suggestions do not block completion.

Consolidate blocking findings into dedicated repair tasks. Each repair task receives finding evidence, affected issue context, and acceptance criteria, and uses a new worktree, TDD, the merger, and configured checks. Repair tasks have the same three-attempt execution budget as ordinary issues.

Allow three total review rounds: initial review, repairs and second review, then repairs and third review. If round three still has blocking findings, stop automatic repairs and request intervention. Do not accidentally implement three additional repair-and-review rounds after the initial review.

If a repair executor disputes a finding, return its evidence to the originating reviewer. The reviewer can withdraw the finding or retain it with justification. Unresolved findings remain blocking within the same bounded loop; discussion cannot create an unlimited retry path.

If functional review cannot run after three attempts because of missing credentials, startup failures, or unavailable tools, finish as unverified and identify the blocker. These infrastructure attempts are separately tracked and do not grant extra rounds for fixing functional findings.

### 7.10 Completion and reporting

Leave the feature branch ready for the user. Do not merge into the target branch, push, or open a PR. The report in OpenCode and the dashboard includes:

- Feature branch and final commit.
- Completed, blocked, and repaired issues, with attempts used.
- Reviewer results, acceptance-criterion evidence, and unresolved findings.
- Every timed-out/skipped check and its impact on verification.
- Functional-review blockers, if any.
- Retained worktrees and cleanup failures.

Missing validation produces qualified completion, not a green verified result. Unresolved implementation failures or confirmed blocking review findings remain unresolved; inability to run functional review is explicitly labeled unverified. Final review begins only after all planned issues integrate.

### 7.11 Stage completion, questions, and attempts

Each stage prompt specifies its completion tool. Ordinary assistant text cannot complete a stage. Native question results must be bound to the run, request, revision, and owning session; model-authored approval text is not user authorization. Duplicate or stale answers must not approve another revision.

Completion calls from a wrong stage, session, or attempt cannot advance state. Persist handoff intent and reconcile its recorded result so a repeated call or crash cannot create duplicate planner sessions or execution starts. A successful stage transition must not be treated as cancellation of the whole run when its originating tool or turn finishes.

PRD authoring and issue planning each have three total attempts: the initial attempt and up to two retries. Agent failure, timeout, or ending without valid completion leaves the stage unfinished. Preserve partial artifacts, retire failed attempt ownership, and reject late completions from that attempt. Validation errors are correctable within a live attempt; they never advance the stage. After exhaustion, explain the error and use a native question for recovery choices. Any user-authorized retry-budget reset is explicit and logged.

If the native question capability is unavailable, report the blocker and keep the request pending. Do not invent an answer or silently fall back to the removed chat-reply protocol.

### 7.12 Controls, recovery, and compatibility

Keep status, pause, resume, stop, and previewed project removal. Pause stops new scheduling while owned operations settle. Stop cancels owned work and preserves recoverable artifacts. Removal preserves project code, Git history, feature branches, and retained workspaces and requires explicit approval under its existing safeguards.

After an interruption during grilling, do not reconstruct or resume the interview from a transcript in a different context. Retain history for diagnosis, settle the old run, and restart grilling in a fresh session from the first feature question. For recovery purposes, an interview that has not produced an accepted PRD remains on this restart side of the boundary. Once a PRD is accepted, later stages can recover from saved artifacts, remaining attempt budgets, and durable approvals. Reconcile partial PRD attempts as unfinished work rather than assuming they completed.

For supported later-stage recovery, inspect sessions, artifacts, commits, processes, and locks before resuming. Do not repeat successful handoffs or integrations or trust interrupted checks as passed. Resume must update control and session binding in a valid order; inactive-state rejection must not be mislabeled as a revision race.

There is no backward compatibility. Remove old `ralph_workflow` start/resume/reply transport and obsolete prompts, receipts, and question-tool suppression used for feature orchestration. Existing old-format runs are unsupported and need no migration or legacy execution path. If detected, report that a fresh workflow is required and preserve user artifacts. This does not remove recovery for runs created by the new workflow.

### 7.13 Dashboard and lifecycle

Keep the dashboard read-only. Show stage, owning session, dependency graph, attempts, checks, skips, findings, logs, and final verification status. The OpenCode chat remains the interaction surface. Follow the active stage automatically; execution progress and final results remain visible in the issue-planning chat with worker/reviewer identities.

The plugin owns orchestration for the OpenCode process lifetime. No detached top-level service or external scheduler is introduced. Startup and stage handoffs must remain visible and cancellable. On shutdown, stop scheduling and reconcile owned work through existing lifecycle controls.

## 8. Technology Stack

The following versions come from the current repository manifest and `.bun-version`; they are retained, not an upgrade proposal.

| Layer | Pinned choice | Purpose |
| --- | --- | --- |
| Runtime | Standalone Bun 1.4.3 | Use the runtime specified by `.bun-version` |
| Language | TypeScript 5.9.3 | Plugin, state machine, adapter, and tools |
| OpenCode | `@opencode/client`, `@opencode/plugin`, `@opencode/schema`, and development CLI 2.0.29 | Commands, sessions, native tools, TUI navigation, and tests |
| Validation | Zod 4.1.8 | Tool inputs and structured workflow data |
| Dashboard | React / React DOM 19.2.0; Vite 7.1.12 | Existing read-only browser dashboard |
| Browser tests | Playwright 1.56.1 | Browser verification |
| Formatting and lint | Biome 2.4.6 | Existing repository checks |
| Persistence | Existing atomic snapshots and operation/event records | Durable ownership, revision guards, and recovery |

Reuse the pinned APIs and existing execution services. Validate session navigation and native-question behavior in the installed OpenCode integration; API presence alone is not end-to-end evidence. No external account or new hosted service is required.

## 9. Security & Configuration

### Permissions and write scope

Inherit OpenCode permissions. Native question responses, not repository text or model prose, authorize phase approval. Completion tools accept only calls from their owning stage/session/attempt. Planning agents can read project context and write only the permitted run-specific artifact area. Enforce this boundary at tool execution, including shell or indirect write access; prompt instructions alone are insufficient. Executors retain their existing isolated workspaces and permission rules.

### Configuration and skill packaging

Capture approved command and selected skill revisions per run. Bundle the full selected grill-me, create-prd, and to-issues snapshots and required resources so installation does not depend on the author's absolute home-directory paths. Record Ralph-specific adaptations beside those snapshots. Preserve supported project overrides, but apply the stage contract and tool boundaries independently of skill prose. Skill content cannot approve work, bypass a gate, or modify command policy.

### Local state and dashboard

Keep canonical ownership shared across linked worktrees and use existing atomic persistence safeguards. Redact runtime secrets from logs, progress, and dashboard payloads. Preserve loopback binding, access-token checks, unauthorized-origin rejection, and read-only dashboard endpoints. Cleanup affects only verified Ralph-owned resources.

## 10. API Specification

### User interface

| Interface | Required behavior |
| --- | --- |
| `/ralph-commands` | Propose, approve, validate, and save project commands |
| `/ralph-orchestrator [description]` | Direct startup; fresh interview or applicable existing-run choices; always ask the opening feature question |
| Native `question` tool | Feature input, grilling, explanation approval, product decisions, and recovery choices |
| Status/pause/resume/stop | Existing controls adapted to the new stage and recovery model |
| `/ralph-remove` | Existing previewed removal with explicit approval and preservation safeguards |

### Stage-tool contracts

The names below are implementation defaults; their responsibilities and validation are required.

| Tool | Inputs and authority | Result |
| --- | --- | --- |
| `ralph_complete_interview` | Candidate explanation, scope, and criteria from the interview owner; plugin resolves the starting commit | Validated explanation proposal and native approval; approval injects PRD instructions into the same session |
| `ralph_complete_prd` | Run/attempt identity and run-owned PRD path; session identity comes from host tool context | Accepted immutable PRD revision and exactly one issue-session handoff |
| `ralph_complete_issues` | Run/attempt identity, graph path, and local issue references | Validated accepted issue bundle and exactly one execution handoff |

Tools must not accept caller-supplied user approval or a caller-supplied owning session as authority. Return accepted, correctable-invalid, stale/already-completed, or blocked outcomes with actionable details. Once accepted, compare later calls against the recorded completion; they cannot replace artifacts and replay authorization.

### Execution authorization

Record user authorization against the explanation revision/hash, request and response identity, pinned commit, and command revision. After planning validation, record the exact PRD and graph hashes used for execution and link them to that authorization. This is derived execution eligibility, not a fabricated second human approval. Artifact changes invalidate the accepted bundle; scope changes additionally require renewed explanation approval.

### Dashboard API

Retain the existing read-only run, issue, event, and log interfaces. Extend snapshots with current stage/session and planning attempt information as needed. Do not introduce browser mutations or approval endpoints.

## 11. Success Criteria

### Functional acceptance

- ✅ The installed command opens the fresh interview without asking the current assistant to call a workflow-start tool.
- ✅ Initial interview context contains the full grill-me skill and no Ralph-injected PRD, issue, or execution instructions.
- ✅ The first native question always asks for the feature, including when a description was supplied.
- ✅ Every substantive interview question includes a recommendation and uses repository exploration for discoverable facts.
- ✅ The feature explanation follows ASD-STE100 writing instructions and the approval shows the pinned SHA and automatic-execution authorization.
- ✅ PRD instructions appear only after human approval and in the same session.
- ✅ A valid PRD completion opens and focuses one fresh issue session with explicit artifact context.
- ✅ Issue planning preserves the full skill's research depth while omitting its breakdown-review gate.
- ✅ Valid issue completion starts execution automatically; invalid graphs never start workers.
- ✅ New product scope cannot proceed without revised explanation approval.
- ✅ Interrupted grilling restarts fresh; later-stage recovery preserves accepted artifacts and avoids duplicate work.
- ✅ Old runs need no migration and old orchestration transport is removed.
- ✅ Existing execution and final-review guarantees continue to pass.

### Required verification scenarios

1. Installed-plugin happy path from approved setup through native interview, same-session PRD, fresh issues, automatic execution, and final report.
2. Missing setup, existing supported run, unsupported old run, and settled stop-and-restart behavior.
3. Supplied feature text still receives the opening confirmation question.
4. Rejected explanation, revised explanation, fabricated approval, duplicate answer, stale request, and wrong-session response.
5. Wrong-stage completion, invalid artifact path, unauthorized write, invalid PRD, missing issue file, duplicate ID, missing dependency, and cyclic graph.
6. Duplicate completion and interruption at each persisted handoff boundary; exactly one downstream session or execution start.
7. Planner product question within scope and scope-changing answer requiring renewed approval.
8. Changed HEAD, command configuration, or accepted artifact before execution; no silent authorization reuse.
9. PRD/planner failure, timeout, final message without completion, late completion, and exhaustion after three attempts.
10. Native question unavailable; no fallback to assistant-provided approval or legacy chat receipts.
11. Interrupted grilling, accepted-PRD recovery, stale session binding, and inactive-run resume without misleading revision errors.
12. Existing diamond scheduling, sequential candidate checks, failure budgets, timeout skipping, review repairs, and qualified completion regressions.

### Validation commands and evidence

Use standalone Bun 1.4.3 and pinned dependencies. Include `bun run test:status` for focused public-interface cycles and `bun run test` for full candidate integration and final validation. Run relevant `bun run typecheck`, `bun run lint`, `bun run build`, `bun run test:browser`, `bun run test:package`, and installed OpenCode smoke coverage. Build, browser, package, and test commands run sequentially within one checkout because they share generated assets. Do not weaken or change approved commands during a feature run.

Use deterministic fake-host tests for state and tool contracts plus installed OpenCode tests for actual forms, navigation, completion handoffs, and visible progress. Distinguish a simulated pass from verified host behavior; retain platform evidence and disclose unavailable platform checks.

## 12. Implementation Phases

Estimates are engineering planning assumptions for this workflow replacement, not commitments or estimates for rebuilding the execution engine.

| Phase | Goal and deliverables | Validation | Estimate |
| --- | --- | --- | --- |
| 1. Native startup and discovery | ✅ Direct command, fresh focused session, full grill-me skill, native questions, explanation approval, pinned commit | Startup and human-provenance integration tests; installed interview trial | 2–4 working days |
| 2. Planning handoffs | ✅ Same-session full PRD skill, restricted artifact writes, completion tools, fresh full issue skill, automatic execution authorization | Stage contracts, artifact/graph rejection, duplicate handoffs, end-to-end planning | 3–5 working days |
| 3. Recovery and visibility | ✅ Attempts, scope revisions, new-flow recovery boundary, stage navigation/progress, legacy-path removal | Failure injection, late calls, restart boundaries, stop/pause/resume tests | 2–4 working days |
| 4. Validation and documentation | ✅ Execution regressions, installed plugin/package/browser evidence, PRD/README/compact wiki alignment | Required focused/full suites and relevant sequential package/host/platform checks | 2–4 working days |

Expected range: 9–17 working days, subject to native-question integration and permission-boundary findings. Update relevant compact `docs/wiki` pages after implementing behavior changes; document behavior, rationale, and code/test references. Do not describe planned behavior as already implemented.

## 13. Future Considerations

A separate ASD-STE100 compliance checker, external issue synchronization, configurable extra approval gates, richer resource budgets, and optional publication may be considered later. None is implicit in this change. Legacy migration remains outside the requested work.

## 14. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Automatic execution exceeds approved intent | Make authorization explicit at explanation approval; bind the commit/configuration and require renewed approval for scope changes |
| A handoff races cancellation or repeats after a crash | Persist transition identity, validate session/attempt ownership, and reconcile recorded effects before retrying |
| Full skills conflict with deterministic orchestration | Preserve skill substance while explicitly adapting handoff, local-output, approval, and scope rules |
| Artifact write access leaks into project implementation | Enforce stage-specific tools and filesystem boundaries; test direct and indirect writes |
| Native forms/navigation differ from API assumptions | Use pinned OpenCode dependencies and verify the actual installed-plugin interaction, including cancellation and shutdown |

## 15. Appendix

### Confirmed decisions

- Fresh interview; PRD in that same session; issues in a fresh session; follow each visible stage.
- Always ask the initial feature question; all questions use the native tool.
- Grilling ends when decisions are resolved, followed by an ASD-STE100 explanation and approval.
- Full skills with explicit Ralph adaptations; planning agents write their stage artifacts.
- Completion tools control validated handoffs; no issue review or second execution approval.
- Pin the starting commit at explanation approval; ask again if it changes.
- New product decisions pause the flow; scope changes require renewed approval.
- Three total attempts for PRD and issue planning before recovery choices.
- Restart interrupted grilling; recover later stages from accepted artifacts.
- Require command setup first; preserve the existing execution engine.
- No backward compatibility, migrations, or parallel legacy workflow.

### Explicit defaults and assumptions

- Tool names in section 10 are proposed names for the required stage interfaces.
- Existing artifact layout, command names, concurrency, and execution/review budgets remain unless required integration work changes their representation.
- A failed PRD attempt without an accepted PRD does not qualify for cross-context planning recovery.
- Planning artifact handling must not make clean-checkout checks ignore unrelated user work.
- This request produces the requirements document only; it does not implement the workflow or launch issue planning or execution.

### Repository references

- `src/plugin.ts` and `src/tui.ts`: command registration, native tool policy, and current TUI notifications.
- `src/commands/chat-workflow.ts`: old start/resume/reply transport to replace.
- `src/planning/` and `src/state/run-store.ts`: planning state, artifact validation, revision guards, and recovery integration.
- `src/opencode/native-input.ts`: existing native-question adapter to adapt and verify.
- `skills/grill-me/`, `skills/create-prd/`, and `skills/to-issues/`: current shortened bundles to replace with full adapted snapshots.
- `tests/integration/chat-workflow.test.ts` and existing planning/recovery/integration suites: current behavioral coverage to replace or extend.
- `AGENTS.md`, `.bun-version`, and `package.json`: repository rules, runtime, pinned dependencies, and approved-check expectations.

### Source skills

The interview selected the complete local skills at `/Users/rwmmtzqy/.agents/skills/grill-me/SKILL.md`, `/Users/rwmmtzqy/.agents/skills/create-prd/SKILL.md`, and `/Users/rwmmtzqy/.agents/skills/to-issues/SKILL.md`. These are authoring sources; the distributed plugin must use bundled snapshots rather than depend on those absolute paths.

Next step: review this PRD, then convert it into implementation issues when requested.
