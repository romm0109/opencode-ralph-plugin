# Project commands

## Summary
`/ralph-commands` prompts the current OpenCode assistant to inspect the repository,
show a readable proposal, and wait for the user's approval. After approval,
`ralph_save_commands` validates and atomically saves `.ralph/commands.json`, then finishes.
This replaces the hidden discovery session, custom setup dialog, tool restrictions,
and automatic verification that made setup slow and confusing.

## Key behavior
- Discovery uses normal assistant read/search tools in the current conversation.
  Ordinary chat approval is sufficient; setup does not require `/ralph-answer`,
  a content-hash reply, a custom question bridge, or a background job.
- The prompt requires exact commands, working directories and relevant environment,
  platform, timeout and resource requirements before approval. Revisions requested
  by the user require a new proposal. The assistant obtains approval; the save tool
  validates configuration rather than implementing a second approval protocol.
- The save tool reuses the strict command schema and lifecycle validation, rejects
  secret values, stale revisions, symlinked configuration directories and active
  feature runs. A short repository lock covers saving. Existing files remain intact
  on validation failure. Approved revisions are archived for execution pinning.
- Saving clears old verification and reports `configured`, never `verified`.
  Planning accepts configured commands. Execution still validates its approved
  baseline and candidates; saving does not run installs, tests or services.
- Supported platforms need checks or explicit unsupported reasons; startup needs
  readiness. IDs, phase ordering, paths, arguments, timeouts and environment
  references remain validated. The repository requires both `bun run test` and
  `bun run test:status`; build/test/package commands run sequentially.
- The older awaited programmatic `router.setupProject` API retains its discovery,
  correlated approval and verification for existing integrations. The native slash
  command no longer calls it. Feature questions and scope authorization use native forms;
  `/ralph-answer` and the old feature chat transport are removed.
- Execution requires host permission. Standalone Bun on PATH launches owned wrappers;
  `process.execPath` inside compiled OpenCode points to OpenCode. Process ownership,
  bounded/redacted output and cleanup remain enforced during execution.

## Code references
- `src/commands/save-commands.ts` — assistant prompt and validated save boundary.
- `src/plugin.ts` — native slash command, save tool and review-only tool restrictions.
- `src/config/commands.ts` — shared schema, lifecycle validation and revision hash.
- `src/commands/project-setup.ts` — configured/verified status and legacy setup API.
- `src/planning/interview.ts`, `src/execution/preflight.ts` — configured-command gate
  and baseline validation before execution.
- `src/tui.ts`, `src/commands/removal-approval.ts` — stage/status notifications and removal-owned approval receipts.
- `tests/integration/save-commands.test.ts` — save without execution, invalid/stale
  proposals, cancellation and active-run protection.
- `tests/integration/01-plugin.test.ts`, `tests/smoke/opencode.test.ts` — current
  assistant flow and real installed OpenCode search → chat approval → save.
- `tests/integration/02-project-commands.test.ts` — legacy lifecycle verification.

## Notes
Native Linux/Windows remain unverified locally. The main assistant follows the
approval instruction as in an ordinary tool-assisted chat; no hidden approval agent
or custom reply protocol is used for this command.

## Last updated
2026-10-15
