# Unverified boundaries

- Native Linux and Windows remain CI verification requirements. Local macOS evidence does not establish Windows process-tree behavior or filesystem-lock semantics.
- The new native workflow passes real-host form replies and same-session PRD handoff. Current forms were agent-operated; human-visible rendering/navigation remains unverified. `/ralph-answer` belongs to the historical protocol and is removed. Assistant text and synthetic messages cannot approve a gate.
- The production scheduler now coordinates both reviews and reporting. Command-only review uses approved check logs. HTTP review uses the configured local URL and host observation tools; UI/browser surface selection still requires explicit public review options. Missing applicable observations must remain unverified.
- The current credentialed counter-reset trial integrated on attempt 1. Both code reviews and behavior checks passed; two reports remain unverified because a no-push/no-main-merge criterion lacked supplied operation history. Provide trustworthy operation audit evidence before claiming that criterion passed. The earlier verified trial used the historical protocol; see `docs/live-opencode-trial.md`.
- Keep standalone Bun on PATH. The compiled OpenCode host executable cannot run arbitrary wrapper scripts; `src/process/runtime.ts` resolves Bun explicitly.
- Execution requires a clean committed starting checkout. Run-owned planning artifacts stay in the managed area and do not require user commits. The plugin does not commit unrelated user files automatically.
- Setup's repository lock is retained after abrupt interruption. Ownership-aware automatic reconciliation for that particular setup lock remains pending; do not remove an active lock.
- Recovery preserves attempts, approvals and accepted commits, and requires explicit resume. Interrupted or ambiguous review/environment operations still need reconciliation; unknown process ownership is never permission to kill a process.
- Direct commands publish location-scoped status and session results. Progress and terminal reports were observed through the real host API; human-visible new-protocol navigation and progress still require acceptance.
- The completed credentialed host did not exit after SIGTERM within more than 20 seconds and required exact-PID forced termination. Graceful host shutdown remains unverified; no active model jobs or trial services remain.

- Keep this repository outside iCloud-synced `~/Documents` (or exclude it). Rebuilding `dist/` there creates iCloud conflict folders such as `dist/agents 2` whose listing blocks forever; `bun test` and builds then hang or time out.
- The 2026-10-16 live TUI trial stopped after scope approval because the ChatGPT usage limit was reached. PRD authoring, issue planning, execution and final review still need a live rerun with the relay and reload fixes.

Last updated: 2026-10-16
