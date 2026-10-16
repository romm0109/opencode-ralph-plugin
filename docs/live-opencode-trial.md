# Native workflow acceptance — 2026-10-16

The current protocol is `native-interview-v1` from the 2026-10-16 PRD. Automated installed tests and a real OpenCode server with a deterministic local model are separate evidence classes. Neither establishes human-visible form rendering, session navigation or provider reliability.

Current sequential validation results are recorded in [package-validation.md](package-validation.md) and [live-opencode-evidence.json](live-opencode-evidence.json). The 2026-10-15 trial below is historical evidence for the replaced protocol only. Its verified commit and screenshots must not be presented as acceptance of the new flow.

## Current installed-host blocker

The 2026-10-16 automated trial with the pinned real OpenCode host fails before opening-form answers: state contains the opening feature request and its interview owner, but `session.form.list` is empty and no permission is pending. Temporary tracing reached `question.execute` in `src/opencode/native-input.ts`; no native form was observed. The smoke now reports that failure directly instead of letting a cleanup-time command connection reset mask it. This is a release blocker, not human acceptance. Same-session PRD assertions in that smoke remain unverified; the two packed deterministic hosts pass separately.

## Iteration 2 recheck (2026-10-16)

The complete prescribed command sequence was rerun on macOS arm64 with Bun 1.4.3 and OpenCode 2.0.29. Automated fixture suites pass; the opted-in real host again fails before the first native answer: pending feature request, no form after 15 seconds, zero pending permissions. New run: `feature-4d637529-5ad6-485e-8766-c23e1a00b784`; interview session: `ses_ebbcd5449ffeyypnbhJaP34jHo`. Failure log: `/tmp/ralph-native-release-iteration2-20261016/11.log`. Exact results are under `automated.revalidation` in the JSON evidence.

Human participation was requested again, but no human answers or acceptance were recorded. An available desktop app inventory is not evidence of rendered forms, automatic focus, progress or shutdown. The checklist remains pending, and native Linux/Windows evidence is still missing. No runtime, fixture, dependency or approved-command changes were made during this revalidation.

## Human-visible installed trial checklist (pending)

Use a packed installation outside the source checkout, a committed temporary repository and OpenCode 2.0.29 with Bun 1.4.3. Retain the exact archive hash, dependency versions, OS/architecture, starting SHA, native session IDs, form IDs, journal/artifact paths and screenshots or transcript references. A human must answer forms and observe navigation; an API response alone is insufficient.

- [ ] Approve project commands. Record the unchanged configuration revision/hash.
- [ ] Invoke `/ralph-orchestrator` without `ralph_workflow`; see a fresh interview and mandatory opening form, including confirmation when a feature description was supplied.
- [ ] Answer a recommended grilling question; inspect the explanation, scope, criteria, branch and full SHA before approving automatic PRD, issues and implementation.
- [ ] See the full create-prd stage in the same interview session, then automatic focus on a fresh issue-planning session containing exact accepted artifacts.
- [ ] Observe one automatic execution start, worker/check/integration progress and independent final reviews. Check the final qualified result in the issue chat and read-only dashboard.
- [ ] Exercise rejected permission, unavailable/cancelled native input and bounded recovery without treating failure as success or resetting attempts.
- [ ] Stop/restart and close OpenCode during owned work. Verify no worker/service continues after host exit; retain cancellation/cleanup evidence.
- [ ] Confirm target branch remains unchanged and no push, target merge or PR occurred.

No human-visible trial of this protocol has been recorded in this task. Linux and native Windows trials/CI artifacts are also unavailable locally. These remain release blockers. Credentialed model smoke is separately opt-in and is not counted when skipped.

---

# Historical trial: previous protocol (2026-10-15)

# Live OpenCode trial

Date: 2026-10-15. Platform: macOS arm64. Runtime: standalone Bun 1.4.3 and compiled OpenCode 2.0.29.

The source checkout initially had an unborn `main` branch and all project files were untracked. The trial uses a committed temporary copy under `/private/tmp/ralph-live-trial/repo`; it preserves the original checkout. Plugin builds are copied into immutable package directories before starting OpenCode. Rebuilding a package loaded directly from the source directory triggers host reload and interrupts owned work.

## Reproduced failures and fixes

- The free-model endpoint rejected requests with provider-auth HTTP 403. The trial uses the existing working OpenAI login and an explicitly selected model; no credentials are copied into the repository.
- Production answers always returned unsupported. The plugin now invokes OpenCode's native question tool and reads structured answers correlated to each pending request/session/revision.
- Zod's exhaustive enum record rejected an empty `unsupportedPlatforms` object. Platform exclusions now use a partial record.
- Missing exploratory read paths discarded an otherwise completed model result. Missing-file reads are recoverable; permission denials and invalid/failed code-mode calls still block success.
- Inside compiled OpenCode, `process.execPath` identifies OpenCode. Wrapper launches incorrectly invoked OpenCode and printed its version. Both ownership paths now resolve standalone Bun on PATH.
- Long slash commands held HTTP requests open through human waiting and complete validation suites. They now acknowledge immediately and publish eventual results while remaining attached to the host lifecycle. A live setup command acknowledged in 26 ms.
- A non-secret environment opt-in with value `1` caused secret scanning to reject ordinary configuration content. Short non-secret references no longer become redaction patterns; actual secret references remain protected.
- Baseline validation omitted the approving main session when requesting command permission. Preflight now supplies that permission owner.
- Resume changed a flag without restarting phase work. Native resume now continues the saved workflow; guarded starting-commit selection requires renewed approval before any issue attempt.
- Production execution stopped at code review. The plugin now hands the frozen commit to the existing dual-review/repair/report coordinator. Command-only functional review uses approved check logs and requires no invented web server.
- Baseline reproduced an executor-admission race: asynchronous state reads could let C take B's ordered slot, eventually timing out a held fixture. A delayed-read regression reproduced it deterministically; admission tickets now preserve graph order without serializing executor work.
- Real Git/process tests exceeded old polling limits. Complex graph scenarios now have explicit bounded deadlines; recovery observations allow real process startup rather than assuming completion within one second.

- Activating a linked executor location loaded an isolated module graph, defeating module-local recovery ownership and cancelling the parent run. A canonical filesystem host lease now shares recovery and final-disposal ownership across locations, with PID birth checks and fail-closed handling of another live host.
- A cancelled prompt could arrive after its interrupt, leaving the executor running. Dispatch now checks cancellation on both sides of prompt delivery and interrupts again when needed.
- Resume guard failures could overwrite an accepted baseline. Reuse now precedes fresh-checkout checks, and guard failures preserve accepted evidence. During this trial, the exact prior passed baseline was restored through the store API from its journal after verifying all eight checks, approval, branch SHA and clean owned checkout. No check result or attempt counter was invented.

- Review tool aliases were registered only in the parent location. A live catalog probe showed aliases in the parent and none in the executor child. Each location now bootstraps safe observation aliases and any recorded functional observation tools. The installed-host regression bypasses explicit cross-location preparation and still verifies read tools and mutation denial.

- The executor selected a background green-test command. A background receipt is not validation completion: the adapter now waits for matching host shell completion and the following idle turn, and recovery reports pending background work as busy. Owned agent shell inputs request foreground execution to keep command lifetime within the awaited turn; normal sessions are unaffected. The real installed host confirmed foreground execution despite the fixture requesting background.

- A green feature run reproduced a service-isolation test timeout. The fixture journal grew to 61 MB, and every read reparsed the entire file. A metadata-keyed cache now replays only appended records after verifying the unchanged prefix, invalidates replacements/truncations/rewrites, and clones public results. The same test passed in 27 seconds with all 21 assertions, without raising its 90-second limit.

- The real executor produced valid code and red/green evidence but added validation/documentation/cleanCheckout fields to its strict submission JSON. The engine retained its commit and automatically retried within the original issue budget. Bundled TDD instructions now explicitly list the only allowed top-level keys.

- Live agents repeated full validation in both executor and merger sessions before the deterministic runner. Parallel agent checks also produced a Biome missing-file diagnostic while builds replaced generated assets. Role/project guidance now assigns focused TDD to the executor, Git-only integration to the merger, and full checks to the host runner, with sequential local checks. The full approved validation set remains mandatory.

## Repeatable host regression

```sh
OPENCODE_SMOKE=1 bun test tests/smoke/opencode.test.ts -t 'installed package:'
```

The installed-package test passed with 35 assertions. It uses a deterministic local model with a real installed OpenCode host. It now covers native setup approval, the host's separate command permission, successful execution through the compiled-host wrapper, denied tools, events, status, restart, cancellation, linked-location observation bootstrap without parent preparation, and forced foreground execution for owned shell calls. This is distinct from the credentialed feature trial.

## Credentialed feature trial

The first feature trial was explicitly stopped after two consumed attempts: one exposed host lifecycle cancellation, the next recorded genuine red assertions but failed green validation in the unchanged service-isolation test. Its approvals, worktrees, journal and budgets remain retained; no completion is claimed. A fresh committed-copy trial includes the fixes and repeats setup followed by a small `/ralph-status` issue-count summary feature, driven through native OpenCode commands and question forms. The repeat trial completed with a terminal **verified** report. Independent code and functional review both passed in round two on the unchanged feature commit; round one remains retained as unverified. There were no workflow validation skips or cleanup failures. Optional credentialed smoke and agent-browser fixture tests remain separately gated; their skips are disclosed, not counted as live feature evidence.

## Additional live failures during final review

The first review of the integrated status feature correctly returned `unverified`: reviewers had final code and checks but not the executor’s native historical red/green observations. Executor receipts are now captured before cleanup and included with submission TDD in review snapshots. Functional review also receives candidate checks, the diff and approved command-policy identity. An explicit `--review` resume consumes the next round on the same commit and retains prior verdicts and budgets.

The terminal UI rendered plugin questions without a usable answer control. `/ralph-answer` now registers in global input scope, fetches pending forms directly from the native API and rechecks them before reply. A live keyboard probe opened the dialog with Reject selected, rejected the exact pending setup proposal, cleared the native form and preserved approved revision 2. A first implementation using the TUI form cache returned no question despite the pending native form; the live probe caught this before delivery.

As the journal exceeded 250 MB, retained expanded history caused substantial memory pressure in separate location modules. Compressed cached snapshots and a verified prefix digest reduced a same-history benchmark from approximately 618 MB retained heap to 70 MB; five subsequent latest-run reads were included. All journal bytes remain retained, and rewrite/truncation/caller-isolation regressions still pass.

## Verified live result

- Run: `feature-4936a199-b6bc-492a-be6d-351590d5b760`
- Repository: `/private/tmp/ralph-live-trial-2/repo`
- Feature branch: `ralph/feature-4936a199-b6bc-492a-be6d-351590d5b760`
- Reviewed commit: `e24fc00f2be8179b0a057f37e250e2061e9eaa2a`
- Feature: execution-only `issueSummary` in selected-run `/ralph-status` JSON; absent/empty execution has zero counts, and the existing no-run contract is unchanged.
- Executor attempt 1 was rejected for extra submission JSON keys; attempt 2 recorded native red/green tests and integrated successfully. Neither attempt was erased.
- Review round 1 remained unverified for missing historical handoff evidence. Explicit review retry consumed round 2 on the same SHA; both reviewers passed.
- All nine approved candidate/final check commands passed with no workflow validation skips. Setup also verified both installation steps.
- Machine-readable evidence: [live-opencode-evidence.json](live-opencode-evidence.json).

## Final source validation

After the native trial fixes and accepted feature were brought into the original checkout, the complete integration suite passed: 232 passed, one separately gated agent-browser fixture skipped, zero failed, 1,418 assertions, 466.37 seconds. The earlier interrupted final run is not counted as a pass. Latest-event/cursor reads and dashboard reconnect handling have focused regression coverage as well.

The final installed-host smoke caught a fast-command output race: Bun version verification succeeded but persisted empty stdout. Command exit IPC can arrive before parent pipe callbacks. The wrapper now captures bounded UTF-8 stdout/stderr and includes them in its final completion receipt; the parent discards duplicate late pipe delivery. A deterministic protocol regression failed before the fix and then passed, alongside lifecycle command tests. Final validation was rerun after this fix.

The final Chromium suite passed all six checks. The complete installed-package smoke suite passed three tests with 37 assertions and one separately gated credentialed-response skip. Its first empty-cache download attempt hit the existing 120-second limit; the unchanged retry passed in 100.83 seconds. No timeout or dependency was changed. The real installed-host check passed again with the output-receipt fix.

The final deterministic packaged end-to-end test and package validation both passed after the output fix. The package probe verified its passing and deliberately incomplete-validation consumers independently. An interrupted package build was rerun; it was not counted as a successful check.

## Final installed runtime

The final archive was installed outside the development checkout at `~/.local/share/opencode/ralph-local/verified-20261015/node_modules/opencode-ralph-plugin`. The stale global plugin URL into this repository’s own `node_modules` was replaced; all other global settings were preserved and the original config was backed up. Critical installed runtime files were compared byte-for-byte with the clean build.

A fresh real OpenCode server loaded both installed server/TUI entry points. Native `/ralph-status` returned the verified feature with total=1, integrated=1 and all other issue counts zero; an unknown run preserved the no-run response without `issueSummary`. The real agent-browser session connected to the installed dashboard and confirmed `Outcome: verified` on the same reviewed commit. Screenshot: `/private/tmp/ralph-live-trial-2/verified-dashboard.png`. Test services were closed after verification; the retained Git branch, journals and native session evidence remain available.

## Foreground command setup follow-up (2026-10-15)

Command setup now runs as a visible `ralph_setup_commands` tool in the current chat. A native dialog automatically lists the exact commands before approval, with individual/full-configuration inspection and explicit rejection. The tool retains the proposal and result in its transcript. The public setup API remains awaited.

A real OpenCode 2.0.29 terminal trial with a deterministic HTTP model verified automatic dialog opening, keyboard inspection, rejection without a saved configuration, and explicit approval followed by native shell permission and successful `bun --version` verification (`1.4.3`). The configuration remained absent before approval. This trial used an isolated committed repository under `/private/tmp/ralph-foreground-ui/repo2`; it did not approve or save commands in the source repository.

The terminal trial caught form creation events without a repository location. Matching the selected session instead restored automatic opening. Regression tests cover that event shape, stale forms, dismissal, rejection, pending-approval interruption and process cancellation with cleanup.

## Missing discovery search path regression (2026-10-15)

The installed-package native OpenCode smoke test now deliberately calls `ralph_review_grep` on nonexistent `src/project`. It asserts the native error receipt, continued discovery, an approval form in the main setup tool before any configuration exists, and successful approved save/verification. The deterministic model controls proposals; OpenCode and its grep, question, permission and execution boundaries are real. The probe passed 38 assertions.

Missing paths are recoverable only for read-only discovery search observations; executor/search permission errors remain blocking. Failed/rejected setup disables tools in the main assistant's immediate continuation and instructs it to report the blocker without proposing another approval. Focused integration tests cover recovery versus executor failure, stale tool calls, and restoration of ordinary tools on the next user prompt.

### Superseding setup simplification (2026-10-15)
The custom foreground setup tool and automatic review dialog described above have
been replaced. `/ralph-commands` prompts the current assistant to search, show a
proposal, wait for ordinary chat approval, and use `ralph_save_commands` to validate
and save `.ralph/commands.json`. It does not execute commands or run verification.
The installed-package smoke test covers this current flow in native OpenCode.

### Chat workflow and project removal (2026-10-15)
Native orchestrator/resume now prompt the current assistant to run visible workflow
steps. Worker and reviewer sessions remain independent; ordinary user replies
answer questions and approve the exact saved revision. The custom `/ralph-answer`
UI is removed. Installed-host tests cover interview replies, both planning gates,
visible worker results and approved project removal. Integration coverage also
runs workers, integration and both reviewers through the visible workflow tool.
`/ralph-remove` preserves code, branches and retained workspaces while clearing
configuration and saved workflow state after a fresh preview and user approval.
