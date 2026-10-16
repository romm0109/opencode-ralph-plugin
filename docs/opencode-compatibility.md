# OpenCode compatibility

## Supported combination

This package targets **OpenCode 2.0.29**. Its server/TUI definitions and typed adapter use the v2 API; v1 hosts are no longer supported. Version 0.2.0 replaces the earlier 1.19.0 integration.

| Component | Exact version |
| --- | --- |
| `@opencode/cli` (development/test CLI) | 2.0.29 |
| `@opencode/plugin`, `@opencode/client`, `@opencode/schema` | 2.0.29 |
| Bun | 1.4.3 |
| TypeScript / Biome | 5.9.3 / 2.4.6 |

The real-server smoke probe builds, packs, installs and loads the package in an isolated Git repository. On macOS arm64 it exercises completed sessions, direct commands without model calls, event subscription, denied shell execution, linked-worktree observation restrictions, persistence, restart, explicit resume, interruption and status RPC. The deterministic local model proves the host boundary, not credentialed external-provider behavior. Native Linux/Windows results remain pending CI.

## Installation and entry points

Follow [README](../README.md). Configure `plugins` with the installed **package directory**, preferably a canonical, encoded file URL. Do not use the old `plugin` entry pointing to `dist/plugin.js`. OpenCode resolves `server.js` and `tui.js` from that directory; both have default definitions with `id: 'ralph'` and `setup(context)`. Package imports also expose `/server` and `/tui`.

Tests use `node_modules/@opencode/cli/bin/opencode.exe`, including on macOS/Linux. The manifest trusts this pinned CLI's postinstall script. Version changes require new runtime evidence, not just a dependency bump.

V2 activates external plugins asynchronously. Wait for command registration before dispatching external jobs; otherwise initial recovery may encounter newly recorded job intent. Local configuration changes require host activation/reload to complete.

Command registration can be visible before `plugin.list` publishes the active plugin. The installed-package probe also waits for that inventory entry before checking server/TUI features. This preserves the supported v2 mapping described in the [official plugin documentation](https://opencode.ai/v2/docs/build/plugins/); the ticket's proposed `@opencode-ai/plugin` import belongs to v1.

## Session adapter

`src/opencode/adapter.ts` accepts a narrow `AdapterHost`; `createAdapterClient` supplies it over the real v2 client and Ralph RPC. The plugin supplies the host's native session domain. V2 calls use flattened options and throw typed/transport failures rather than returning v1 `{ data, error, response }` envelopes.

```ts
const client = createAdapterClient(url, undefined, {
  Authorization: `Basic ${btoa('opencode:' + password)}`,
});
const session = await client.session.create({
  location: { directory }, title,
  model: { providerID, id: modelID },
});
const receipt = await client.session.prompt({ sessionID: session.id, text });
await client.session.wait({ sessionID: session.id });
const history = await client.session.context({ sessionID: session.id });
await client.session.interrupt({ sessionID: session.id });
await client.session.command({ sessionID: session.id, name: 'ralph-status', text: runId });
const commands = await client.command.list({ location: { directory } });
for await (const event of client.event.subscribe({ signal })) { /* v2 event.data */ }
```

Job intent is durable before session creation; the returned session ID is durable before prompting. Workspace selection occurs at session creation; subsequent calls target that session ID. Model fields map from Ralph's `{ providerID, modelID }` contract to v2 `{ providerID, id }`.

Prompt acknowledgment is not completion. The adapter waits, finds the delivered user message with the receipt's ID, and checks the subsequent turn. Success requires completed assistant text, `finish: 'stop'`, a successful idle record and no failed tools or session errors. Unexpected subsequent input makes correlation uncertain and returns missing output. Earlier failed/denied tools, including caught code-mode failures in tool metadata, cannot be erased by later assistant success.

Cancellation is recorded before interruption. The current operation journal uses the internal `session.abort` operation kind; v2 uses `session.interrupt` underneath. A late-created cancelled session is interrupted without prompting. Cancellation is checked again after prompt delivery so a prompt racing the first interrupt is interrupted again. Stale results cannot update superseded attempts.

## Commands, observations and notifications

Commands register with `context.command.transform`; tools register with `context.tool.transform`. Status/pause/resume/stop execute directly. The exact command output is queued as a synthetic inbox item with `resume: false`, and a status event notifies the TUI without waking the model. Pending output can be inspected with `client.session.inbox.list`; it is consumed on the next session execution. Status never depends on generated assistant text.

V2 does not expose the plugin tool catalog as a public client endpoint. `src/opencode/bridge.ts` defines location-scoped Ralph RPC for tool discovery, observation preparation and status notification. Review sessions expose only `ralph_review_*` aliases of permitted observation tools. Aliases retain each original tool's permission action and execution function. Context filtering hides mutation tools and code-mode `execute`; the execution hook also rejects unapproved calls. Normal sessions retain their original tools and hide the observation aliases. Host denials are never changed to allows and no permissions are automatically approved.

The TUI entry follows location-scoped stage-session events and shows informational status toasts; cleanup unsubscribes. Server-only consumers can subscribe to RPC events and use durable status/dashboard data. Feature answers use the host’s native question forms. Fake-host tests verify contracts and navigation deduplication; installed native rendering and cross-platform evidence for this stage flow remain separate.

## Recovery and remaining limits

The canonical Git common directory owns `<git-common-dir>/ralph/runs`. Its fsynced JSONL journal remains authoritative; snapshots use atomic rename and writers use ownership-verified locks. Linked worktrees share state. Multiple v2 locations in one server recover that state once and only the last location's cleanup stops shared work. A filesystem host lease coordinates isolated module graphs; another live server fails closed and a proven dead PID birth identity permits fresh recovery. Restart still requires explicit resume and never resets attempts or review budgets. Only native-interview-v1 feature records can resume. Earlier feature protocols are unsupported and never migrated; preserve their artifacts and settle ownership before starting a fresh workflow.

Ralph starts feature stages directly and uses native question forms for feature input and one scope authorization. The full grill-me skill runs in a fresh interview; create-prd runs in that session after approval; the full adapted to-issues skill runs in a fresh session. `ralph_complete_interview`, `ralph_complete_prd` and `ralph_complete_issues` validate owner/session/attempt and accepted artifacts. Issue completion starts execution automatically. Progress and results target the issue-planning chat. There is no chat reply transport or second execution approval. Setup saving and previewed removal retain ordinary-chat approvals.

PRD and issue authoring have three total attempts each; native question waits and pause suspend active-time deadlines. Exhaustion requires explicit native intervention. Recovery retains accepted bytes and remaining budgets; pre-PRD discovery restarts fresh. Fake-host integration tests establish these contracts, not live form rendering. Historical probes below describe earlier revisions; installed-host and cross-platform stage-flow evidence belongs to issue 25. Standalone Bun must remain on PATH because compiled OpenCode’s executable is not a general-purpose Bun runtime.

## Reproduce

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test:status
bun run test
OPENCODE_SMOKE=1 bun run test:smoke
bun run test:package
```

On PowerShell set `$env:OPENCODE_SMOKE='1'` before running the smoke suite. The local probe uses an isolated test-only Basic-auth password. The separate live probe requires `OPENCODE_LIVE_SMOKE=1`, `OPENCODE_SMOKE_URL`, `OPENCODE_SMOKE_MODEL=provider/model` and the server's `OPENCODE_SMOKE_PASSWORD`; without its opt-in/endpoint/model it is skipped. Do not put credentials in package resources or fixture data.

## Issue 1 verification — 2026-10-14

- macOS arm64, Bun 1.4.3: typecheck and lint passed; all 19 issue-1 integration tests passed.
- `OPENCODE_SMOKE=1 bun test tests/smoke/opencode.test.ts`: **2 passed, 1 skipped**. The fresh-source install uses only the manifest/lockfile and an empty package cache. The installed-package probe builds, packs and loads Ralph in real OpenCode 2.0.29, correlates its local model response through the public router/adapter, preserves permission denial, observes events and verifies status after host restart.
- Red/green evidence: the empty-cache install failed with `ENOENT extracting tarball from opencode-ralph-plugin` before removing the accidental self-dependency from the manifest and regenerating the lockfile. It then passed. A warm cache had concealed the missing archive. Package installation must not depend on a previously built copy of itself.
- The real probe initially failed on an unpublished plugin inventory entry; the probe now waits for active inventory independently of command registration, retaining its TUI assertion.
- Fresh-install checks are gated because they download dependencies; the deterministic issue-1 suite requires neither network model access nor paid calls. Credentialed external-provider execution was skipped. Linux and Windows have CI jobs but were not run here. Native human answers and the terminal answer dialog were subsequently verified in the separate live trial.

## Earlier packaged fixture verification — 2026-10-15

macOS arm64, Bun 1.4.3 and the pinned OpenCode 2.0.29 combination passed the installed host smoke (3 passed across the smoke suite, 1 credentialed-provider skip), complete deterministic two-consumer setup-to-report test, six Chromium checks, typecheck/lint and the integration suite (194 passed, 1 separately gated browser smoke skipped). The demo performs real Git/TDD/integration and a real timeout omission; human responses and agent prose are supplied at the public adapter boundary. Full results, reproducible commands and remaining production/native-platform blockers are recorded in [package validation](package-validation.md). No Linux, native Windows or credentialed full-workflow success is claimed by these local results.

Historical verification above predates the native stage flow. The current TUI follows stage sessions and shows scoped status; native question results settle feature requests. Worker/reviewer sessions and worktrees remain independent.

## Historical credentialed verification

The separate live macOS feature trial completed with verified code and functional review on the same frozen commit, native test receipts, no workflow validation skips and clean cleanup. See [live trial](live-opencode-trial.md) and [machine-readable evidence](live-opencode-evidence.json). Earlier fixture counts and provider skips above describe their specific runs.
