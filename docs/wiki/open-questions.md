# Unverified boundaries

- Native Linux and Windows remain CI verification requirements. Local macOS evidence does not establish Windows process-tree behavior or filesystem-lock semantics.
- Native question forms now provide production answers and approvals. The real host form API and `/ralph-answer` native terminal dialog were exercised, including default Reject, structured reply and unchanged approved configuration. Assistant text and synthetic messages cannot approve a gate.
- The production scheduler now coordinates both reviews and reporting. Command-only review uses approved check logs. HTTP review uses the configured local URL and host observation tools; UI/browser surface selection still requires explicit public review options. Missing applicable observations must remain unverified.
- The credentialed macOS setup-to-feature trial reached verified dual review on the retained feature commit; see `docs/live-opencode-trial.md`. Deterministic fixtures and local-model smoke remain separately labeled. Native Linux/Windows and other provider/model combinations are not established by this trial.
- Keep standalone Bun on PATH. The compiled OpenCode host executable cannot run arbitrary wrapper scripts; `src/process/runtime.ts` resolves Bun explicitly.
- A clean committed source checkout is required for execution. Commit approved project configuration and planning artifacts before approving execution; the plugin does not commit user files automatically.
- Setup's repository lock is retained after abrupt interruption. Ownership-aware automatic reconciliation for that particular setup lock remains pending; do not remove an active lock.
- Recovery preserves attempts, approvals and accepted commits, and requires explicit resume. Interrupted or ambiguous review/environment operations still need reconciliation; unknown process ownership is never permission to kill a process.
- Direct commands queue exact results in the session inbox and publish location-scoped status notifications. Detailed progress remains available in the durable store and read-only dashboard; the live terminal trial verified status messages, question text and the answer dialog.

Last updated: 2026-10-15
