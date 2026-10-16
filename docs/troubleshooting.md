# Installation and operational troubleshooting

Use the exact dependency versions listed in [compatibility](opencode-compatibility.md) and Bun from the package manifest (`.bun-version` in a source checkout). Run the package probe from the source checkout: `bun run test:package`.

| Symptom | Check or action |
| --- | --- |
| Tarball install mentions a developer's home directory | Rebuild the current manifest; it no longer contains a self-dependency. Copy the archive into the consumer and install `./opencode-ralph-plugin-0.2.0.tgz`. Avoid percent-encoded absolute tarball URLs with Bun 1.4.3. |
| Plugin fails to load on a path with spaces or Windows | Generate the canonical package-directory URL with `realpathSync` and `pathToFileURL` using the README command. Use the encoded URL for plugin loading; do not hand-build drive-letter file URLs. |
| Slash command missing | Restart the pinned OpenCode server in the correct repository and inspect `plugins` in its local `opencode.json`. V2 activates external plugins asynchronously; allow activation to finish. All seven Ralph commands are registered. Setup uses the current chat; orchestrator opens a fresh interview session and native question. |
| Wrapper prints the OpenCode version or exits before result collection | Rebuild this version and keep standalone Bun on PATH. Wrappers must launch Bun rather than the compiled host executable. |
| Proposal rejects an empty unsupportedPlatforms map | Rebuild this version; the platform-exclusion map is partial. |
| Global OpenCode behaves differently | Use OpenCode 2.0.29. This package uses the v2 plugin contract; v1 is no longer supported. |
| Local test CLI says postinstall was not run | Run `bun pm trust @opencode/cli`; the manifest trusts only this pinned CLI install script. |
| HTTP SDK returns 401 | Pass the v2 server Basic-auth header to `createAdapterClient(url, fetch, headers)`. The smoke test uses an isolated test-only password. |
| Dashboard inaccessible | Get a fresh URL from `/ralph-status`. Use its loopback host and fragment token. Tokens are process-scoped and change on server restart. The listener stops when the plugin is disposed. |
| Dashboard returns 401/403/405 | Authentication is required for API reads. Cross-origin and mutation requests are rejected. Use OpenCode for controls. |
| Reopened workflow does not continue | Recovery intentionally waits for `/ralph-resume`. Read the recovery facts first; resolve blocked/conflicting Git, session or ownership evidence. Attempts and revision budgets do not reset. |
| Opening an executor worktree cancels its parent run | Use this version: repository host ownership is shared through the Git common directory across isolated plugin locations. |
| Another live OpenCode host owns this repository | Close that repository in the other host before activating Ralph here. A live owner is never stolen; stale birth identities recover on the next activation. |
| Writer lock or process ownership cannot be inspected | Do not delete state or kill arbitrary PIDs. Recovery only reclaims provably dead local owners. Native Windows requires PowerShell/CIM and `taskkill.exe`; POSIX requires `ps` and process-group signals. Unknown ownership is a visible blocker. Network-filesystem lock atomicity is not promised. |
| Completion says incomplete/unverified | Read skipped checks, unavailable criteria/review, failed cleanup and retained resources in the report. A successful assistant response does not validate checks. |
| Failed worktree remains | Keep it with its evidence for diagnosis. Do not remove a worktree referenced by an active operation. Successful issue cleanup is owned by integration, not package installation. |
| Live smoke is skipped | The credentialed probe requires opt-in, endpoint, model and v2 server authentication documented in README. A deterministic local model or fake adapter cannot prove provider compatibility. |
| Linux or Windows result is unavailable | Run the corresponding native CI matrix job. Missing or failed supported-platform evidence remains a release blocker. macOS results cannot certify Windows cleanup behavior. |

No install or release script pushes, publishes, creates a PR or merges a feature into its target. The two-repository demonstration uses local temporary Git branches only. Runtime state is under the Git common directory; logs, repositories, test fixtures and secrets are excluded from the package's allowlisted contents. The build removes stale `dist` output before compilation.

### A Ralph question appears without a terminal answer control

Feature questions and scope approval use the host’s native question tool. Enable it and inspect `/ralph-status` for the pending request and owning stage. `/ralph-orchestrator` opens a fresh interview; accepted PRD completion opens a fresh planner. Execution progress and the report appear in the planner chat. Ordinary chat replies cannot approve a feature. Setup saving and removal still use chat approval. `ralph_workflow` and `/ralph-answer` are removed.

Authoring has three total attempts per PRD/issue stage. Pending native questions and pause suspend the deadline. Exhaustion asks natively whether to reset the budget or stop. Before accepted PRD recovery offers fresh discovery; later recovery preserves accepted bytes and remaining budgets. Unsupported saved protocols require a fresh workflow with preserved artifacts, never migration. Changed starting commit or commands require renewed explanation approval, not graph approval.

### Review cannot verify historical TDD

New executor jobs retain native test-tool receipts for final review. A terminal `unverified` report may be retried explicitly with `/ralph-resume <run-id> --review` when the feature commit and approved commands are unchanged and cleanup completed. This consumes another review round and preserves the original report in the journal. Missing history remains missing evidence, never an inferred pass.

### Correct directory, but Ralph commands are still missing

Restarting the OpenCode terminal UI can reconnect to the same long-running background service. After changing a local plugin path, that service can report the new configuration while retaining an active plugin from the old path and exposing no Ralph commands. Compare the authenticated native `plugin.list({location})` source with the configured package path and inspect `command.list({location})` for the exact repository.

Refreshing the idle repository location with the authenticated SDK’s `client.debug.location.evict({location: {directory}})` forces that location to load the current package. Wait for its active plugin and command inventory afterward. This refreshes the selected repository rather than terminating the shared service and other projects. A live reproduction on the ordinary user service loaded the old `node_modules/opencode-ralph-plugin` copy despite the new global config; after refresh, all six commands appeared in the API and in plain `opencode` slash autocomplete.

### Discovery reports a missing guessed search directory

Do not create `src/project` to satisfy a discovery guess. Current command discovery tolerates missing read-only search paths and can continue to a valid proposal. Permission denials and other tool failures still block. The current assistant can correct an exploratory search and continue. `/ralph-commands` uses normal chat approval and the validated save tool; it no longer depends on a separate discovery session.

### Remove Ralph from a project
Run `/ralph-remove`, review the exact deletion preview, and approve in chat. It removes `.ralph` and saved workflow state for the repository, preserving code, Git history, feature branches and workspaces. Linked worktrees share that saved state. Active workers or unsettled cleanup block deletion; use `/ralph-stop` and resolve the listed facts before requesting a new preview. The globally installed plugin and active host bookkeeping are retained.
