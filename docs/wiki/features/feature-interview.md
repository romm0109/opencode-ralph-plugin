# Native feature interview

## Summary
The installed `/ralph-orchestrator [description]` command directly validates approved
project setup, captures the selected model and skill hash, acquires ownership in the
Git common directory, and creates a fresh interview session. Startup does not ask
the original assistant to choose a workflow tool.

## Key behavior
- New command runs use `native-interview-v1` with a durable interview owner, session,
  and attempt. Revision-checked writes reject changed session ownership and protocol
  replacement. Existing unsupported planning owners block fresh startup without migration.
- The opening native question always asks what feature to build. Supplied text is a
  suggestion to confirm or revise, not a human answer. Its request is saved before
  display. Only correlated human answers enter the transcript; wrong-session,
  unsolicited, duplicate, stale, and assistant answers cannot settle the request.
- Grilling reuses the same session. Each structured substantive question includes a
  recommendation. Read, glob, grep, and list remain available; project writes, shell,
  delegation, and administrative tools are denied independently of review tool policy.
- The bundled grill-me file contains the full source snapshot. The loader adds an
  interview-only contract with ASD-STE100 writing guidance, without certification.
  Project overrides supplement the snapshot. Installed code resolves package-local assets.
- Location-scoped stage events focus the session using the public TUI tabs API, with
  router fallback. Duplicate events cause no second navigation or worker dispatch.
- Missing setup, model selection, or native question capability gives a visible startup
  blocker. Human question waits do not consume an agent attempt or use its timeout.
  Agent timeouts freeze late results and interrupt the run. Stop must settle ownership
  before fresh startup; ambiguous or unsupported ownership never silently resumes.
- `ralph_complete_interview` presents the explanation and pinned starting commit for
  native scope authorization. One matching human approval authorizes PRD creation,
  issue planning and implementation. The full create-prd skill enters this same
  session; accepted PRD completion opens a fresh issue session. Final prose alone
  cannot approve work or advance stages. See [Feature planning](feature-planning.md).

## Code references
- `src/plugin.ts`, `src/commands/orchestrator.ts` — direct installed command, host input,
  session tool policy, startup blockers.
- `src/planning/interview.ts`, `src/planning/types.ts`, `src/core/types.ts` — startup,
  durable owner, structured pending questions, answer provenance, and interview loop.
- `src/state/run-store.ts` — atomic revisions and immutable native ownership.
- `src/agents/skills.ts`, `skills/grill-me/SKILL.md` — snapshot and stage contract.
- `src/opencode/adapter.ts`, `src/opencode/native-input.ts` — session creation/reuse
  and structured native form metadata.
- `src/opencode/bridge.ts`, `src/tui.ts` — location-scoped session navigation.
- `tests/integration/03-interview.test.ts` — fake-host native startup, opening input,
  session reuse, restrictions, provenance, and blockers in temporary Git repositories.
- `tests/integration/tui-input.test.ts` — fake TUI location scoping, deduplication,
  and router fallback.

## Related
- [Project commands](project-commands.md)
- [Workflow recovery](workflow-recovery.md)

## Notes
Router, slash and control entrypoints share native stage startup/recovery. The old workflow tool, feature receipts and native-question suppression are removed.
Fake-host tests establish contracts, not real native form rendering or installed TUI
behavior. Installed-host and cross-platform evidence belongs to issue 25.

## Last updated
2026-10-16
