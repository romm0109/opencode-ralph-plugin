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
- Sessions created in the host checkout retain the host's exact location spelling.
  OpenCode scopes tools/forms by that spelling: canonicalizing `/var` to `/private/var`
  can put a native question in a different form service from its session. Real-path
  comparison still identifies the checkout; other worktree locations remain separate.
- Grilling reuses the same session. The interviewer asks each substantive question
  with OpenCode's own `question` tool, recommended option first. JSON questions for
  Ralph to ask remain only a fallback when that tool is unavailable.
- Native question delivery (live OpenCode 2.0.29 finding): the TUI shows forms that
  Ralph creates itself only while a slash command runs. Forms created later, from a
  stage tool or background work, never reach the session's form list. Ralph therefore
  relays those questions through the agent's own `question` call: a stage tool that
  needs an answer returns `awaiting-human` (with the full proposal in `show`); other
  sessions get a short relay prompt. The `execute.before` hook replaces the call's
  input with Ralph's exact question; `execute.after` reads the human answer from the
  host result. The model cannot change the wording or invent the answer. Forms are
  short because OpenCode forms do not scroll: long context goes to `details`, shown
  in chat first. Ralph also asks the TUI to reload a session's forms on `form.created`.
- Interview turn deadlines count only time without a pending native question, so
  slow human answers cannot time out the interviewer. Read, glob, grep, and list remain available; project writes, shell,
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
- A repeated `ralph_complete_interview` call re-shows the same recorded approval
  request (same id and revision); a plugin reload loses the in-memory question.
- Ralph's own progress posts (`msg_ralph-progress-*`) during an agent turn do not make
  that turn's result ambiguous. Progress is readable text with a one-line headline
  that also titles the collapsed chat entry and the short toast; it is never raw JSON.
- Native scope approval settles the matching active discovery job before same-session
  PRD delivery. Progress and downstream prompts must not turn a successful interview
  into a generic "another input before result collection" failure.
- Progress observers whose owned worktree has been removed stop that observation
  quietly. Cleanup must not generate repeated missing-location delivery errors;
  other filesystem errors still propagate.

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
  session reuse, location spelling, restrictions, provenance, and blockers in temporary Git repositories.
- `tests/smoke/opencode.test.ts` — installed real OpenCode opening/scope forms and
  same-session PRD handoff, including macOS temporary-directory aliases.
- `tests/integration/native-host-capabilities.test.ts` — PRD-to-issues reconciliation
  with the actual plugin session capability subset (no session/inbox list APIs).
- `src/opencode/progress.ts`, `tests/integration/progress-location.test.ts` — quiet
  observation after successful owned-worktree removal, with other errors preserved.
- `tests/integration/tui-input.test.ts` — fake TUI location scoping, deduplication,
  router fallback, and form reload for Ralph questions.
- `src/plugin.ts` (`relayUserInput`, `relayingTool`, tool hooks), `src/opencode/native-input.ts`
  — question relay; `tests/helpers/fake-opencode.ts` plays the agent's question call.
- `tests/integration/03-interview.test.ts` ("rides its next question call", "waiting for a
  human answer") and `04-planning.test.ts` — relay content/provenance and deadlines.
- `tests/integration/01-plugin.test.ts`, `10-dashboard.test.ts` — own progress during a
  turn and readable progress text.

## Related
- [Project commands](project-commands.md)
- [Workflow recovery](workflow-recovery.md)

## Notes
Router, slash and control entrypoints share native stage startup/recovery. The old workflow tool, feature receipts and native-question suppression are removed.
Fake-host tests establish contracts, not real native form rendering or installed TUI
behavior. A 2026-10-16 live TUI trial confirmed opening, grilling and scope-approval
forms render with the relay; it stopped at PRD authoring when the model usage limit was
reached. Cross-platform evidence belongs to issue 25.

## Last updated
2026-10-16
