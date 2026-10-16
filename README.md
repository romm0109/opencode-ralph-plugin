# Ralph for OpenCode

A locally installable OpenCode plugin with durable session jobs, independent code and functional review, bounded review repairs, a read-only dashboard, and interruption recovery. Exact tested dependencies and platform results are in [compatibility](docs/opencode-compatibility.md).

Ralph feature questions and scope authorization use OpenCode’s native question forms. `/ralph-orchestrator` opens a fresh interview with the full grill-me skill; approval injects the full create-prd skill into that session. Accepted PRD completion opens a fresh issue-planning session with the full adapted to-issues skill. Valid issue completion starts execution automatically. Independent workers and reviewers retain their sessions and Git worktrees; progress and results appear in the issue-planning chat. Installed-host and native platform evidence for this stage workflow is tracked separately in [package validation](docs/package-validation.md).

## Build and install locally

Use Git and the Bun version in `.bun-version` (also pinned in `package.json`). From this source directory:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run pack:local
```

Copy `opencode-ralph-plugin-0.2.0.tgz` to each target repository, then run there:

```sh
bun add ./opencode-ralph-plugin-0.2.0.tgz
bun -e 'console.log(require("node:url").pathToFileURL(require("node:fs").realpathSync("node_modules/opencode-ralph-plugin")).href)'
```

Add the generated, encoded URL to the repository's `opencode.json`, preserving any existing settings:

```json
{
  "plugins": ["REPLACE_WITH_GENERATED_PACKAGE_DIRECTORY_URL"]
}
```

Use the **entire** URL printed by the command. It points to the package directory, where OpenCode resolves `server.js` and `tui.js`; do not point it to `dist/plugin.js`. This handles Windows drives and spaces. The example uses single quotes around JavaScript for PowerShell and POSIX shells; native Windows results are pending CI. A relative tarball dependency is recommended; Bun 1.4.3 failed to install the tested percent-encoded absolute `file:` tarball URL with spaces. Each target must be a Git repository. The repository root need not have a commit just to load the plugin; feature/review operations need committed inputs.

Keep standalone Bun on PATH: compiled OpenCode cannot execute the owned wrapper scripts through its own executable.

Start OpenCode **2.0.29** in that repository (see compatibility for the local binary path). Restart OpenCode after changing plugin configuration. No registry publication is required or performed by these scripts.

## Commands and operation

- `/ralph-commands` asks the current assistant to search the project and show the proposed commands. Reply with your approval or changes in the same chat. After approval, `ralph_save_commands` validates and saves `.ralph/commands.json`, then finishes. Setup does not execute the commands; execution runs its own baseline checks.

- `/ralph-orchestrator [feature]` directly opens and focuses a fresh interview. Its native opening question always asks what to build, showing supplied text for confirmation. The interviewer explores the repository and asks recommended native questions. `ralph_complete_interview` presents an ASD-STE100-guided explanation, scope, criteria, branch and exact HEAD. One native approval authorizes PRD creation, issue planning and implementation within that scope. `ralph_write_planning_file` confines authoring to run artifacts; `ralph_complete_prd` validates the PRD and opens the fresh planner; `ralph_complete_issues` validates the graph/files and starts baseline and execution without another approval. Prose cannot advance stages.

- `/ralph-status [run-id]` reads durable status and the dashboard URL. With no argument it selects the latest run.
- `/ralph-pause [run-id]` records pause intent and freezes new dispatch while active work settles.
- `/ralph-resume [run-id]` resumes supported saved planning, baseline, execution or review after explicit recovery checks. Before PRD acceptance it offers fresh discovery or retention; accepted stages retain artifacts, owners and remaining attempts. Unknown ownership or changed artifacts block resume. `--base <commit>` requests renewed explanation approval for the checked-out starting commit; `--review` retries an eligible unverified report within its remaining review budget. Changed HEAD or commands require renewed explanation approval. Unsupported saved protocols require a fresh workflow; they never execute or migrate and their artifacts remain available.
- `/ralph-stop [run-id]` cancels correlated sessions and cleans up owned processes. Stale completions cannot advance the run.
- `/ralph-remove` previews removal of this checkout's `.ralph` and the repository's saved Ralph workflow state, then waits for approval in chat. It preserves project code, Git history, feature branches and worktrees. Active/unsettled work blocks removal; stop it first. Shared state removal affects linked worktrees. The global plugin stays installed for other projects and future setup.

For an existing run, `/ralph-status` adds `issueSummary` with eight numeric counts:
`total`, `pending`, `ready`, `running`, `integration_queued`, `integrated`, `blocked`
and `failed`. Only the selected run's `execution.issues` contributes: total is its
array length, and repeated statuses count individually. Other runs, planning issues
and issue attempts are excluded. Missing execution or an empty issues array yields
eight zeros. Explicit lookup and latest-run selection are unchanged, as are all
existing fields and no-run responses (which have no summary). Implementation:
`src/commands/router.ts`; public dispatch coverage: `tests/integration/01-plugin.test.ts`.

The dashboard URL includes an access token in its fragment. Open it locally; treat it as private. The listener uses loopback with an automatically allocated port, so independent repositories can run together. The browser is read-only; commands and approvals belong in OpenCode. State and write locks live under the repository's canonical Git common directory, `ralph/runs`, and are shared by linked worktrees. Independent repositories use independent stores. The plugin stays attached to the OpenCode server lifecycle; shutdown stops owned work and the dashboard. Restart reconciles facts and waits for explicit resume.

Setup prompts the current assistant; orchestrator and resume commands drive the native stage workflow directly. Feature questions wait for correlated native human answers. Workers and reviewers remain independent sessions. Keep approved project configuration committed and unrelated changes out of the checkout before scope authorization. Ralph tracks its own generated planning artifacts for preflight; there is no separate execution approval or requirement to commit those artifacts.

The v2 package ships server and TUI entry points. Status/control slash commands execute directly, emit a status notification, and queue their exact output as a synthetic inbox item without waking the model. `/ralph-commands` prompts the current model session to discover commands, ask for approval and use its save tool. The TUI follows the fresh interview and issue sessions and displays Ralph status notifications; the dashboard and persisted store remain authoritative.

The public `adapter`, `store`, `commands`, `types`, `review/*`, `reporting/completion` and `process` exports support typed host integration. The command router starts the same native stage workflow as slash commands. `continuePlanning` advances authorized native stages; `scheduleIssues` and `executeIssue` operate on the accepted DAG; `answerExecutorQuestion` validates correlated host-provided human answers. `reviewFeature` coordinates independent reviewers and the final report. Low-level `runJob` supports correlated session jobs. Tests and fixtures are excluded from runtime exports.

Code and functional reviewers load their bundled `skills/code-review` and `skills/functional-review` resources. Code-review options accept a `{ providerID, modelID }` model; functional review accepts its own model through `functionalOptions`. Executor jobs carry the same optional model field. Model/tool availability and OpenCode permissions remain host-owned; no permission is auto-approved. Command configuration validates lifecycle ordering, platform coverage (or explicit unsupported reasons), paths, timeouts, argument arrays, explicit shells and environment references. Role models and replacement skill paths are read from optional `.ralph/project.json` and captured with hashes on each run.

## Interview settings

Project replacements resolve relative to the workspace root. Omit `skillPaths.interview`
to use the original bundled grill-me guidance. Omit `models.interview` to capture the main
session's selected model; an unavailable selection produces an actionable error.

```json
{
  "schemaVersion": 1,
  "models": { "interview": { "providerID": "your-provider", "modelID": "your-model" } },
  "skillPaths": { "interview": "skills/my-interview.md" },
  "concurrency": 2,
  "timeoutMs": 300000,
  "agentTimeoutMs": 1800000
}
```

Runs record model selections, skill paths and content hashes, the verified command hash,
and timeout/concurrency defaults. Agent timeouts interrupt planning and retain the lock
and evidence. Human answers do not time out. `agentTimeoutMs` separately controls executor and merger deadlines (default thirty minutes), and is recorded on the run and each issue attempt. One canonical repository lock includes
planning; explanation approval retains it through execution. Terminal coordinated review releases the matching lock. Interrupted locks require reconciliation and explicit resume.

## Concurrent execution resources

Ready issues are selected in approved graph order. A submission waits in the integration
queue; children start only after all parents integrate, including qualified integration
with omitted checks. `/ralph-status` and durable events expose ready, pending, running,
integration_queued, integrated, failed and blocked states plus queue order. The executor
slot ends after submission cleanup; merger/validation work uses a separate serial queue.

`/ralph-commands` may propose resource allocation in the exact approved configuration:

```json
{
  "resources": {
    "RALPH_PORT": "port",
    "RALPH_NAMESPACE": "namespace",
    "RALPH_DIRECTORY": "directory"
  },
  "exclusiveResources": ["shared-test-database"]
}
```

Command `env` mappings reference these source names, for example
`{"PORT":"RALPH_PORT","APP_NAMESPACE":"RALPH_NAMESPACE","APP_DATA":"RALPH_DIRECTORY"}`.
Ports, namespaces and directories are allocated per lifecycle/job. Executor prompts
receive the allocation; candidates receive fresh allocations. The runner executes only
approved commands, using main-session permission before an executor session exists.
Shared resource names serialize use within the repository. Startup without allocated
ports also serializes use. Missing required references block setup; commands are never
invented or rewritten to obtain isolation. Owned cleanup releases only that lifecycle's
resources; cleanup failures retain ownership and diagnostics.

## Executor questions

An executor may return `{"kind":"needs_input","question":"...","recommendedAnswer":"...","affectedRequirement":"..."}`. Ralph persists the question on its run/issue/attempt and publishes it through the main-session adapter. The issue and descendants wait while independent issues continue. Human waiting consumes no executor capacity, agent deadline or retry. A correlated clarification resumes the same worktree and attempt with a new job identity and the remaining active-time budget.

Hosts answer through the adapter’s authenticated `UserInputResult` contract. The production plugin invokes native forms and binds answers to their request, session, revision and real human result. Stale requests, changed revisions, duplicate messages and unrelated sessions are rejected. Ordinary chat messages do not authorize feature execution.

For scope changes, use `ralph_request_product_decision` from the owning stage. Revised explanations require a newly displayed native scope authorization and invalidate dependent planning outputs. Executors that discover changed requirements return a correlated scope proposal with a revised explanation; accepted artifacts must be regenerated under renewed authorization. Integrated evidence is retained. There is no second graph or execution approval and no browser mutation endpoint.

## Validation semantics

Three **total issue attempts** include the first submission and two retries; an expected failing TDD red test does not consume an attempt. Three **total review rounds** apply to the final dual review; each generated repair task has its own three-attempt limit. Functional infrastructure retries have a separate three-attempt budget. Issue repair limits are enforced through the public single-issue entrypoint; the dependency scheduler preserves independent progress when an issue exhausts its budget.

The validation policy skips only timed-out validation checks for the current run, never setup/readiness timeouts, permission denials, cancellations or completed failures. Those omissions must remain in the report and must not rewrite approved commands. The baseline runs on an isolated clean checkout before implementation. Check timeouts are run-local omissions; setup failures and timeouts block readiness. Retain failed worktrees and their evidence for diagnosis; clean successful worktrees only after validated integration. Recovery does not silently discard retained resources.

A completed agent job is not proof of a verified feature. Reports distinguish `verified`, `incomplete-validation` (including skipped checks), `unverified` (missing review evidence) and `unresolved` (blocking issues/findings). Inspect the report's commit, checks, unavailable review and cleanup/resource fields. No workflow script publishes, pushes, creates a PR or merges into a target branch.

## Reproduce the package demonstration

```sh
bun test tests/integration/15-package.test.ts
bun run test:package
bun test tests/e2e/full-workflow.test.ts
bun run test:browser
bun run test:smoke
```

The package probe builds a clean distribution, packs it, installs it into two committed temporary repositories with spaces in their paths, and loads the installed plugin. It checks bundled skills/dashboard assets, separate stores, concurrent ports, argv preservation, readiness, cleanup and controls. Its deterministic workflow uses native stage services and completion tools, real Git/TDD/integration, independent reviewers, and a real timeout omission. Human answers and agent outputs are fixture supplied; these verdicts do not prove live native UI behavior. Temporary repositories are removed; `test:package` prints outcomes and blockers. Set `PACKAGE_EVIDENCE_PATH` to retain JSON evidence.

For the real installed OpenCode server probe, enable `OPENCODE_SMOKE=1` (PowerShell: `$env:OPENCODE_SMOKE='1'`) before `bun run test:smoke`. It uses a local deterministic model. The separate credentialed session probe requires `OPENCODE_LIVE_SMOKE=1`, `OPENCODE_SMOKE_URL` and `OPENCODE_SMOKE_MODEL=provider/model`; without them it reports SKIPPED. The credentialed probe covers a model session, not the complete workflow; native interactive rendering and full live-workflow evidence remain separate verification requirements. A v2 server also requires authentication: set `OPENCODE_SMOKE_PASSWORD` for the live probe. Credentials remain in the configured server; do not copy them into fixtures or package assets.

See [troubleshooting](docs/troubleshooting.md). CI runs the required suites on macOS, Ubuntu and native Windows and retains per-platform package evidence. A green fixture demo does not remove the production-host or unrun-platform blockers.

For a focused public status behavior loop, run `bun run test:status`. This selects integration tests whose names contain `status`; the full `bun run test` suite remains required for final validation.

Feature input uses native question forms; enable the host question tool. Setup and previewed project removal retain their ordinary-chat approval workflows. `ralph_workflow` and `/ralph-answer` are absent.

For a terminal `unverified` report caused by missing observations, `/ralph-resume <run-id> --review` retries review of the same clean feature commit within the existing three-round budget. Prior verdicts and issue attempts remain retained.

PRD and issue authoring each have three total attempts. Invalid completion arguments can be corrected in the current attempt; settled prose, failure or active-time timeout consumes one. Native questions and pause suspend authoring deadlines. Exhaustion requires an explicit native recovery choice to reset the budget or stop. PRD retries retain the interview session; issue retries use fresh reconciled sessions. Restarted discovery begins with a fresh session and opening question, preserving previous drafts and history.
