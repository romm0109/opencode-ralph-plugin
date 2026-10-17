# Package validation — native workflow, 2026-10-16

This records local macOS arm64 evidence for the 2026-10-16 PRD. It is not cross-platform or human-visible acceptance. The older credentialed trial is explicitly historical in [live-opencode-trial.md](live-opencode-trial.md).

Use standalone Bun 1.4.3 (`c6da4a4d3`), the lockfile and pinned OpenCode CLI/client/plugin/schema 2.0.29. TypeScript is 5.9.3, Biome 2.4.6 and Playwright 1.56.1. Run commands one at a time in the same checkout:

```sh
bun --version
bun run typecheck
bun run lint
bun test --timeout 30000 tests/integration/15-package.test.ts
bun run test:status
bun run test
bun run build
bun run test:browser
bun run test:package
bun run test:e2e
bun run test:smoke
OPENCODE_SMOKE=1 bun test --timeout 180000 tests/smoke/opencode.test.ts
```

## Current production fixes and retest (2026-10-16)

The installed-host opening-form failure recorded below is resolved. The plugin
preserves host location spelling for same-checkout sessions; canonical aliases had
selected a different form service. The final real installed OpenCode smoke passed 56 assertions (two tests, one
explicit credentialed-probe skip), including opening/scope forms, same-session PRD delivery and a completed
discovery receipt (`/tmp/ralph-final-release-20261016/09.log`).

A credentialed native counter-reset trial also exposed the plugin context's missing
session/inbox list APIs. Stable session IDs plus metadata/workspace validation and
the host's stable prompt-ID reconciliation now support those limited capabilities.
Recovery retained the accepted PRD and opened one planner on attempt 1; real execution
then integrated the issue on its first attempt. The current trial and verification
results are recorded in [live-opencode-trial.md](live-opencode-trial.md). Agent-operated
forms are not human-visible acceptance. Human UI and native Linux/Windows evidence
remain separate requirements. The iteration tables and JSON revalidation records
below retain the earlier failing receipts; they predate these fixes.

## Final sequential local validation

All eleven final commands passed on macOS arm64 with unchanged Bun 1.4.3 and pinned
OpenCode 2.0.29. `bun run test:status` passed 15 tests; `bun run test` passed 296
with one separately gated skip and 2,034 assertions. All seven browser tests,
package validation, the end-to-end package test, typecheck, lint, build, the opted-in
real-host smoke and `pack:local` passed. Exact receipts and log hashes are in
`docs/live-opencode-evidence.json` → `nativeWorkflowRetest20261016`.

The removal trial additionally reproduced false preview invalidation from read-only
progress cursor writes. Only regular known-run cursor files and their UUID-v4
atomic-write temporaries are excluded from fingerprint churn; unknown files and
workflow changes remain guarded and the observer data is still removed.

The retry regression now asserts the injected timer fires before awaiting integration
under its unchanged outer deadline. A separate two-pass real-Git scope-change test
has an explicit 90-second harness budget after observed 30-second harness timeouts.
Assertions, product deadlines, dependencies and approved command configurations
remain unchanged. Failed/interrupted receipts remain retained, not counted as passes.

## Iteration 2 revalidation (2026-10-16)

All twelve listed commands were rerun sequentially after predecessor iteration 2, with unchanged Bun 1.4.3, pinned OpenCode 2.0.29, fixtures and runtime code. Typecheck, lint, focused package integration (3 tests), status (15 tests), full integration (293 passed, 1 gated skip, 2,018 assertions), build, browser (7 tests), package, end-to-end and default smoke passed. The default smoke had three explicit opt-in skips.

The opted-in smoke **failed again**: fresh lockfile installation passed, the credentialed provider test was skipped, and the installed host had no opening form within 15 seconds despite a saved pending feature request and zero pending permissions (44 assertions before failure). Run `feature-4d637529-5ad6-485e-8766-c23e1a00b784`, interview `ses_ebbcd5449ffeyypnbhJaP34jHo`. Native answers and same-session PRD assertions were not reached. No production fix or timeout change is claimed.

The latest command exits, durations, log hashes, source receipts and two-consumer archive identity are under `automated.revalidation` in [live-opencode-evidence.json](live-opencode-evidence.json). Logs: `/tmp/ralph-native-release-iteration2-20261016/00.log` through `11.log`. The tested archive SHA-256 was `a1af7a5f4e502dc0d2f4adbb513baccf7bd7e9e73320049c327493b193825b4e`; it predates this documentation-only evidence refresh and was removed by the harness. Earlier evidence remains retained separately.

Human participation was requested; no human answers or acceptance were recorded. Desktop app inventory does not establish a UI trial. Human-visible forms/navigation/progress/shutdown, the failing installed-host native input boundary, and native Linux/Windows evidence remain release blockers.

## Installed fixture scope

`test:package`, the package integration test and `test:e2e` each build/pack locally and install the tarball in two independent committed Git repositories with spaces in their paths. The consumers load installed plugin exports, dashboard HTML/JS and all eight bundled skills. Planning skill size checks protect the full snapshots; runtime imports do not resolve author-machine skills. Separate canonical state, command hashes, dashboard ports and owned process cleanup are asserted.

The registered `/ralph-orchestrator` handler opens an interview with a mandatory native question-tool request. Deterministic answers return through the host tool boundary, using the pending request context. The fixture exercises a recommended grilling question, ASD-STE100 prompt instructions, scope/SHA approval, same-session PRD authoring, fresh issue planning and installed scoped-write/completion tools. It does not mutate accepted planning state. Setup files are explicitly committed before startup; no approval-gate commit conceals dirty user files.

Duplicate PRD/issue completion must not create another planner or executor. Issue completion starts real red/green worker tests, candidate Git integration, automatic independent reviews and a published final report. Reviewers observe the installed addition implementation in their worktrees. The passing consumer produces `verified`; the second changes an already approved environment reference after setup to trigger an actual validation timeout, producing `incomplete-validation`. No second execution gate or explicit second review is needed.

The installed real-host smoke uses pinned OpenCode and a deterministic HTTP model. The test answers native forms via `session.form.reply` and verifies same-session PRD approval. The earlier opening-form failure is retained below; the current retest above passes these assertions. It also covers actual denied permission, foreground command execution, cancellation, bounded server shutdown and persisted restart state. These are API/host observations, not human-visible TUI acceptance. Browser tests observe read-only planning, waiting/blockers, progress and validation omissions. Broader public-interface tests in `03-interview`, `04-planning`, `14-recovery`, `chat-workflow` and `tui-input` cover unavailable questions, stale replies, retry exhaustion and stop/restart.

All consumers are temporary and removed after the test. Their branch/remotes assertions prohibit target merge or push; no PR is created. The plugin lifecycle remains bound to OpenCode. Complete human observation of shutdown during the new flow remains on the live checklist.

## Historical iteration 2 evidence and release blockers

Exact command exits, durations, logs and package results are captured in [live-opencode-evidence.json](live-opencode-evidence.json). Logs are local artifacts under `/tmp/ralph-native-release-20261016`; consumer paths in package evidence are historical references to removed temporary repositories.

- Earlier pinned installed-host native opening form: FAIL (resolved by the retest above). With a real OpenCode 2.0.29 server, native startup persists `pending.kind=feature` but `session.form.list` remains empty through the bounded 15-second wait; permissions are empty. Temporary tracing reached `question.execute` in `src/opencode/native-input.ts`. Production tracing was removed. This transport gap blocks release; fixture-native success cannot qualify it.
- Human-visible new-protocol native form rendering, session switches and visible progress: pending. The historical 2026-10-15 verified run cannot satisfy this requirement.
- Native Linux and Windows: not run on this Mac; successful platform artifacts remain required.
- Credentialed provider smoke: separately gated; skipped unless endpoint/model/auth inputs are available. A local deterministic model does not certify provider behavior.

Missing evidence remains a release blocker. No unrun interactive or platform check is marked passed.

## Sequential command results

The machine-readable evidence retains the initial sequential run and final follow-up checks. All commands below ran in the earlier iteration; that iteration was blocked by the installed-host failure. Current host results are above; human UI and native platform requirements remain open.

| Command | Result |
| --- | --- |
| `bun --version` | 1.4.3 (`c6da4a4d3`) |
| `bun run typecheck` | PASS; final follow-up also passed |
| `bun run lint` | PASS; final follow-up also passed |
| `bun test --timeout 30000 tests/integration/15-package.test.ts` | PASS; final follow-up 3 tests, 15 assertions |
| `bun run test:status` | PASS; 15 tests, 74 assertions |
| `bun run test` | PASS; 293 passed, 1 gated agent-browser skip, 0 failed, 2,018 assertions |
| `bun run build` | PASS |
| `bun run test:browser` | PASS; 7 Chromium tests |
| `bun run test:package` | PASS; independent `verified` and `incomplete-validation` consumers; final repeat also passed |
| `bun run test:e2e` | PASS; both deterministic consumer workflows |
| `bun run test:smoke` | PASS; 1 package test, 3 explicit opt-in skips |
| `OPENCODE_SMOKE=1 bun test --timeout 180000 tests/smoke/opencode.test.ts` | FAIL; final repeat 1 passed, 1 credentialed skip, 1 failed, 44 assertions; native opening form absent |

The opted-in lockfile install passed. The real-host smoke reached the native startup regression after earlier tool/permission/restart checks. It did not reach native answer or PRD acceptance assertions. Repeated diagnostic attempts reproduced the absence of forms; they are not successful trials. Startup promise rejection is captured promptly so shutdown cannot replace the useful failure with a connection-reset error.

The tested final package SHA-256 is recorded under `automated.package.archiveSha256` in the JSON evidence. The test removes its tarball and consumers after validation; this is an identity receipt, not a retained release archive. Production tracing was restored byte-for-byte before the final opted-in check. No pinned dependency, approved command, production timeout or protocol was changed.
