# 16. Start a fresh native feature interview directly from the command

**Type:** AFK  
**User stories:** PRD §5 stories 1, 2, 4  
**Requirements:** PRD §§6.1–6.4, 7.1–7.2, 8–9

## What to build

Make `/ralph-orchestrator` directly validate approved setup, acquire repository ownership, create a fresh interview session, and deliver the mandatory first native question. Supply the full grill-me snapshot and interview-only instructions; a supplied command description is shown for confirmation rather than skipping this question. Keep subsequent grilling in this same session with repository observations, native questions, and recommended answers. Add the minimum durable stage ownership and session navigation needed for this complete command-to-interview path. Explanation approval and PRD injection belong to issue 17; do not start them implicitly.

## Repository rules and implementation approach

- Source of truth: root `PRD.md` (2026-10-16 revision), especially the sections cited below.
- Follow root `AGENTS.md`. No `CLAUDE.md` or `docs/adr/` exists in the inspected repository. Use standalone Bun **1.4.3** from `.bun-version`, with the pinned OpenCode **2.0.29** dependencies; do not upgrade them for this feature.
- Use behavior-focused public-interface TDD for meaningful behavior changes. Exercise real temporary Git projects where ownership, artifact or preflight behavior matters. Do not weaken assertions merely to retain old protocol fixtures.
- No backward compatibility, old-state migration or legacy fallback. New-flow recovery is still required. Preserve unrelated setup, removal, execution and reviewer guarantees.
- Run build, browser, package and test commands **sequentially within one checkout**. Include both `bun run test:status` and `bun run test`; the full suite remains mandatory for candidate integration and final validation. Never alter approved commands during a run.
- Baseline file references below were inspected when these tickets were written; predecessor work may move lines or introduce the explicitly named new modules. Follow the referenced symbol if line positions shift.


## Context: files to read before implementing

- `src/plugin.ts` (lines 247–315) — command registration currently injects chatWorkflowPrompt rather than starting a run.
- `src/plugin.ts` (lines 459–542) — context and execute.before currently suppress native questions and enforce read-only observations.
- `src/planning/interview.ts` (lines 1–205) — existing request/answer provenance and interview loop.
- `src/planning/interview.ts` (lines 318–390) — setup, model capture, repository lock, and initial planning creation.
- `src/planning/types.ts` (lines 1–84) — planning phases, transcript, model/skill capture, and pending request.
- `src/opencode/native-input.ts` (lines 1–74) — native question execution and metadata parsing.
- `src/opencode/adapter.ts` (lines 431–484) — dispatchJob currently always creates a new session.
- `src/opencode/bridge.ts` (lines 1–22) — typed RPC/status event bridge.
- `src/tui.ts` (lines 1–31) — existing location-scoped event listener.
- `tests/helpers/fake-opencode.ts` (lines 259–327) — fake command/tool registration and hook capture.
- `tests/integration/03-interview.test.ts` (lines 1–155) — setup rejection and recommended-question fixture.

Also read root `PRD.md`, `AGENTS.md`, and all predecessor tickets named in **Blocked by**. Full source skill snapshots are under `/Users/rwmmtzqy/.agents/skills/` for authoring only; installed code must use package-local assets.

## Patterns to follow

Use `Plugin.define` and `ctx.command.transform` from the existing plugin, and `Rpc.define`/Zod for a location-scoped stage-session navigation event. Use `requestNativeInput` as the host boundary, extending structured question data instead of interpreting approval authority from prose. Preserve `openRunStore` Git-common-directory ownership and capture model/skill hashes before prompting. A stage session is a durable owner, not a fresh `dispatchJob` per interview question. Keep observation restrictions separate from final-review role restrictions.

**Tests and errors:** Mirror `createTestProject()` in `tests/helpers/project.ts:7` and `createFakePluginContext()` in `tests/helpers/fake-opencode.ts:259`. Use revision-checked store writes and actionable structured failure/tool outcomes. Do not catch permission denial or stale ownership and proceed as success.

## Step-by-step tasks

### UPDATE `src/planning/types.ts; src/core/types.ts; src/state/run-store.ts`

- **IMPLEMENT:** Add a new-flow discriminator and durable interview owner/session/attempt plus typed native-question data (question kind, options/recommendation, request identity). Preserve atomic revision checks and existing execution records. Reject unsupported planning protocol records without migrating them.
- **PATTERN:** RunStore.recordPlanning at src/state/run-store.ts:483 and UserInputRequest at src/core/types.ts:187.
- **IMPORTS:** Import PlanningState as a type in domain records; reuse z from zod where request schemas are needed.
- **GOTCHA:** Do not globally bump dashboard or command configuration schemas merely to distinguish new planning runs.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `src/commands/orchestrator.ts; src/planning/interview.ts; src/opencode/adapter.ts; src/plugin.ts`

- **IMPLEMENT:** Start directly from the command, create/attach one fresh interview session, and reuse it for questions. Wire native input with the active host signal. Persist the opening request and always present the feature confirmation first. Missing setup, missing model, and missing question capability return actionable blockers. Replace feature question suppression for new stage sessions.
- **PATTERN:** startInterview in src/planning/interview.ts and createOpenCodeAdapter at src/opencode/adapter.ts:216.
- **IMPORTS:** Reuse startInterview, assertProjectConfigured, projectStatus, loadProjectConfig, loadRoleInstructions, requestNativeInput, and type OpenCodeAdapter; use randomUUID from node:crypto for request identities.
- **GOTCHA:** Do not block plugin initialization waiting for a question; normal question waiting is not a failed attempt, and final assistant prose is not stage completion.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `skills/grill-me/SKILL.md; src/agents/skills.ts; src/opencode/bridge.ts; src/tui.ts`

- **IMPLEMENT:** Bundle the full source grill-me skill plus a stage-only contract with ASD-STE100 explanation instructions. Emit a location-scoped stage-session event and focus it using the pinned TUI router/tab API. Keep future-stage skill text out of the initial session.
- **PATTERN:** Skill hashing at src/agents/skills.ts:1 and scoped TUI listener at src/tui.ts:5.
- **IMPORTS:** Use existing readFile/createHash skill-loading imports; add Zod schema fields through ralphBridge; use ctx.ui router/tabs from @opencode/plugin/tui context rather than private UI internals.
- **GOTCHA:** The full source is /Users/rwmmtzqy/.agents/skills/grill-me/SKILL.md, but distributed code must resolve its bundled copy using import.meta.url.
- **VALIDATE:** `bun run typecheck` and `bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/tui-input.test.ts`.

### UPDATE `docs/wiki/features/feature-interview.md` and behavior tests

- **IMPLEMENT:** Record the delivered behavior, its reason, and the actual code/test references in `docs/wiki/features/feature-interview.md`. Add or replace public-interface cases for every acceptance criterion below; keep historical behavior explicitly labeled where relevant.
- **PATTERN:** Existing compact feature wiki pages under `docs/wiki/features/`; mirror their summary/code/test structure without claiming unimplemented behavior.
- **IMPORTS:** Tests use `expect` and `test` from `bun:test` plus existing fake-host and real-Git helpers; docs require no production imports.
- **GOTCHA:** Do not describe a deterministic fixture or a source prompt assertion as proof of real native UI behavior.
- **VALIDATE:** Run the focused cases and required full checks below.

## Acceptance criteria

- [ ] The slash command creates a durable run and fresh session without a model calling ralph_workflow; no workflow prompt is delivered to the original chat.
- [ ] With and without supplied feature text, the first native question asks what to build; its response is persisted with host-derived identity.
- [ ] Subsequent questions remain in the interview session, include a recommendation, and permit repository observation tools.
- [ ] The initial injected context contains the full grill-me skill and no PRD/issue/execution instructions; ASD-STE100 is an instruction, not a separately certified result.
- [ ] Only the matching location follows the new session; duplicate events do not start work again.
- [ ] Missing setup or question capability blocks visibly; assistant text or an unsolicited answer cannot settle a pending request.
- [ ] Focused behavior tests, `bun run test:status`, and mandatory `bun run test` pass; the compact wiki reflects delivered behavior.

## Validation commands

Run one at a time with standalone Bun 1.4.3 on PATH:

```bash
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/03-interview.test.ts tests/integration/tui-input.test.ts
bun run test:status
bun run test
```

Installed-host and cross-platform evidence is completed by issue 25; this slice must still pass its public-interface tests and full integration suite.

## Blocked by

None — can start immediately.
