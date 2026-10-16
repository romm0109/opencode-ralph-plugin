# Plugin and durable session results

## Summary

Issue 1 provides an installable strict TypeScript plugin, `/ralph-status`, a typed session adapter and a repository-wide durable journal. It supplies the minimal entrypoints/fixtures for later orchestration slices.

## Key behavior

- OpenCode 2.0.29 loads default server/TUI definitions. Status/control commands register with `command.transform`, run directly and queue exact output without waking a model; the TUI subscribes to scoped status RPC. The store remains authoritative.
- `createCommandRouter(store, adapter).runJob` creates/reuses a run and dispatches a job. Status exposes persisted phase, result and errors after reopening.
- Setup prompts the current assistant to discover, approve and save commands. Orchestrator and feature resume directly invoke native stage services. Fresh interview/issue sessions are focused through the TUI; execution progress targets the issue chat. See [workflow controls](workflow-recovery.md).
- Feature input and scope authorization use correlated native question results. Only previewed removal captures ordinary-chat receipts; setup retains its approved save boundary. Synthetic messages and worker output cannot approve a feature.
- Missing exploratory read paths are recoverable; permission denials, invalid tools and code-mode failures remain failures.
- The adapter maps v2 location/model fields, queues a prompt, waits for execution and checks messages behind the same receipt ID. A successful idle record alone is insufficient. Earlier failed/denied tools, including caught code-mode failures, prevent success.
- Review sessions expose permission-preserving observation aliases, filter all other tools and reject unapproved executions. Normal session tools are unaffected. Location-scoped RPC supplies external catalog/preparation access.
- Observation aliases bootstrap separately in each location; native plugin contexts cannot prepare another location through RPC. Captured functional observation tool names are selected from that location’s durable read-only job intent. Permissions and per-session restrictions remain unchanged.
- Linked v2 locations recover their shared repository once; closing one location does not stop the others. Final cleanup retains explicit restart/resume semantics.
- Fresh installation must work without a prebuilt archive or warm package cache. The gated smoke checks manifest/lockfile installation with an empty cache; never add the package as its own local tarball dependency.
- Command transforms can be visible before active plugin inventory; smoke checks wait separately before asserting packaged server/TUI features.
- Journal reads cache verified data by file identity, size and nanosecond modification/change times. Growth replays only a content-verified unchanged prefix; replacements, truncations and rewrites replay fully. Public reads clone results to preserve caller isolation. This prevents large lifecycle journals from dominating status polling and service execution.
- Git common-directory realpath identifies canonical storage across linked worktrees. Ordered JSONL events are authoritative; snapshots use atomic rename. Duplicate/stale completions do not update state.
- Background shell receipts are not completion. Collection waits for the exact shell IDs and an idle turn after their completion; recovery reports them busy meanwhile. Owned agent shell tools run foreground so their lifetime remains within the attempt; unrelated sessions retain normal shell behavior.
- Cancellation is durable before abort. Abort intent/result and errors survive reopening. A late-created session is aborted without prompting. Dispatch checks cancellation both before and after prompt delivery, interrupting a prompt that races the first abort. Production session inspection uses the final idle context record when the native host lacks the public active-session API.

## Code references

- `src/plugin.ts` — v2 setup/cleanup, command/tool/event registrations and repository leases.
- `src/opencode/adapter.ts`, `src/opencode/native-input.ts` — SDK boundary, native answers, and typed failure policy.
- `src/opencode/bridge.ts`, `src/tui.ts`, `server.js`, `tui.js` — location-scoped RPC and packaged server/TUI entry points.
- `src/core/types.ts` — job/run/event/operation identity contracts.
- `src/state/run-store.ts` — shared repository identity, journal, snapshots, writer lock.
- `src/commands/router.ts` — public job and status entrypoints.
- `tests/integration/01-plugin.test.ts` — durable results, permissions, races, worktrees, recovery.
- `tests/helpers/project.ts`, `tests/helpers/fake-opencode.ts` — real Git fixtures and controlled SDK transport.
- `tests/smoke/opencode.test.ts` — gated installed-package real server demonstration; separate gated live-provider check.

## Related

- [Compatibility signatures and installation](../../opencode-compatibility.md)
- [Unverified boundaries](../open-questions.md)

## Notes

OpenCode CLI/plugin/client/schema 2.0.29 and Bun 1.4.3 are the verified local combination. Native host question forms now supply correlated answers and approvals; assistant text never settles a gate. Historical macOS trials exercised earlier terminal interactions. Current stage-flow installed-host and native Linux/Windows evidence remain separate; fake-host contracts do not establish UI rendering.

## Last updated

2026-10-16

## Native terminal answers and test receipts

- `/ralph-answer`, the workflow transport and feature chat receipts are removed. Native form results validate request/session/revision provenance. Only previewed removal retains chat receipt authorization. Workers cannot use administrative tools.
- Completed executor jobs retain bounded, correlated native tool receipts before worktree cleanup. Review snapshots receive submission TDD plus native red/green observations and previous attempt receipts. Missing history is disclosed; assistant claims alone do not become host evidence.
- Sources: `src/commands/removal-approval.ts`, `src/plugin.ts`, `src/tui.ts`, `tests/integration/chat-workflow.test.ts`.

Journal read caches retain compressed historical snapshots and a SHA-256 prefix digest rather than the full Unicode journal string. Latest-run reads expand only the requested snapshot; list reads expand only the latest event per run. Metadata and prefix validation still invalidate rewrites/truncations, and callers receive independent clones. This bounds retained history memory across isolated location modules; explicit event-history calls still return complete snapshots.
