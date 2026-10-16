# Read-only execution dashboard

## Summary
The plugin starts an HTTP server on `127.0.0.1` with an ephemeral port. `/ralph-status` and its status tool return `dashboardUrl`, including when there is no run. Plugin disposal closes listeners and streams.

## Key behavior
- All API reads require a process-local bearer token. The page reads the URL fragment into memory and removes it; requests use headers. Cross-origin requests and unexpected Host headers are rejected. Only GET is accepted. Public static assets contain no run data or token.
- GET `/api/runs`, `/api/runs/:id`, `/api/runs/:id/issues`, `/api/runs/:id/events`, and `/api/runs/:id/logs/:logId` read the committed journal. The browser never approves, answers, pauses, retries, resumes or stops execution.
- SSE IDs are repository-wide sequences, which can have gaps within a run. `after` or `Last-Event-ID` replays subsequent events. An absent/unknown cursor returns the latest snapshot. The fetch client ignores duplicate events, reconnects from its last cursor and aborts its stream on browser offline signals.
- `RunRecord.execution` is optional evidence. `RunStore.recordExecution(runId, expectedRevision, evidence)` records it atomically as `execution.observed`; stale revisions are rejected. This method reports evidence and does not schedule or integrate work. Producers supply issue dependencies/status/blockers, queue order and checks with attempt, candidate SHA and command revision.
- A passed summary requires explicit `execution.verification: "passed"` and nonempty, all-passed check evidence. Empty checks are unavailable; skipped/waiting/running checks are incomplete. Agent completion cannot establish dependency integration or successful validation.
- DTOs omit prompts, workspace paths, raw SDK causes and model/environment configuration. Output is redacted when persisted and displayed, including known runtime secret values, explicit store/server redaction values, credential patterns and terminal controls.
- Known logs are immutable persisted job output identified by `jobId--attempt`, including historical attempts. No log path is opened. Pages contain at most 4096 characters from a 65536-character bounded window and report omitted output.

- Native planning snapshots include stage, owner session/attempt, retired ownership, attempt history and a bounded waiting/blocker reason. Writing, waiting, retrying, blocked and accepted/completed states remain separate from execution verification. Native questions and prompts are never copied into this projection.
- Plugin-owned observation replays committed run events into the current persisted stage chat, then the issue-planning chat throughout execution/review. Updates contain worker/reviewer identities, bounded result excerpts, approved command selections, checks, blockers and the qualified final report. Messages are capped at 16,000 characters; job excerpts at 2,000. Truncation points to persisted status/log evidence.
- Delivery uses `session.synthetic` with stable per-event IDs and `resume: false`; it never prompts, answers a form, calls a completion tool or schedules work. Ownership and canonical workspace are rechecked before delivery. Separate atomic checkpoints under the run store's `chat-progress/` preserve the visible session, event cursor and projected view without changing execution revisions. Failed deliveries retain their cursor for retry; persisted events keep their original order.
- TUI navigation checks the exact project location, accepts positive attempt numbers, ignores repeated session handoffs and rejects older run revisions. It focuses a tab or navigates to an existing session; no agent is created or resumed. Notifications start after host activation and the observer stops with plugin disposal.

## Code references
- `src/dashboard/server.ts` — security, journal reads, SSE and lifecycle.
- `src/dashboard/projections.ts` — shared DTOs and conservative evidence projection.
- `src/dashboard/web/App.tsx`, `api.ts` — read-only views, log paging and reconnect.
- `src/state/run-store.ts`, `src/core/types.ts` — optional persisted execution evidence contract.
- `src/state/sanitize.ts` — credential/control redaction.
- `src/plugin.ts`, `src/commands/router.ts` — lifecycle-owned observer, status stage projection, status URL and disposal.
- `src/opencode/progress.ts`, `adapter.ts`, `bridge.ts`, `src/tui.ts` — journal observation/checkpoints, ownership-checked synthetic delivery, revision-scoped navigation.
- `tests/integration/10-dashboard.test.ts`, `tests/browser/dashboard.test.ts` — HTTP security, replay, authored blocked-descendant evidence and scheduler-produced diamond progress with offline catch-up.
- `tests/integration/04-planning.test.ts` — real Git executor plus independent reviewers; fake-host plugin progress and final verified report in the issue session. `tests/integration/tui-input.test.ts` covers cross-location, replay and retry navigation without any execution API.
- `tests/helpers/dashboard-scheduler.ts` — Bun subprocess for the Node Playwright harness; uses the public scheduler/router, real Git integrations and the controllable SDK adapter.

## Notes
Run `bun run build` to include Vite assets in `dist/dashboard/public` for distribution. The exact dashboard integration test builds its own source assets; `bun run test:browser -- tests/browser/dashboard.test.ts` also builds assets. Install the browser first with `bunx --no-install playwright install chromium`.

Issue 8 now publishes revision-checked execution evidence through `recordExecution`. The scheduler browser regression holds B/C concurrently after A integrates, shows D pending until both integrate, completes all five issues while offline, and reconnects to the persisted current graph. It seeds a prior run-local validation timeout; actual omission propagation through integrations produces five skipped checks and incomplete verification. The separate authored-evidence browser scenario covers blocked descendants and queue changes. Native planning/browser and chat delivery assertions use deterministic fixtures and a fake host; they do not prove installed OpenCode UI behavior (issue 25 owns that evidence). Current adapter output is available at job termination, so intermediate agent log chunks are unavailable. No SDK streaming API was invented. Chromium and HTTP tests ran on macOS; Linux/Windows and credentialed live OpenCode behavior remain unverified locally.

## Related
- [Plugin and durable session results](plugin-session-results.md)

## Last updated
2026-10-16

Dashboard state requests read only the latest committed event. SSE catch-up and polling request events at or after the last cursor, preserving reconnect/reset behavior without expanding every historical snapshot on each heartbeat. Explicit log lookup can still read complete history. `RunStore.events` retains its full-history default for existing callers and validates optional sequence cursors.
