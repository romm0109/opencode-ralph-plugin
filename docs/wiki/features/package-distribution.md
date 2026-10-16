# Local package distribution

## Summary

Clean builds pack the runtime, dashboard and full planning/reviewer skills into a local tarball. Two independent committed Git consumers load installed exports and run the native planning protocol. This catches installed tool, artifact and handoff failures that source imports miss.

## Key behavior

- Bun 1.4.3 and OpenCode CLI/client/plugin/schema 2.0.29 remain pinned. The manifest allowlists runtime resources; stale logs, source and author-machine skill paths are not package dependencies.
- The installed command starts a fresh interview and mandatory opening question. Fixture answers return through the host question tool, with the actual request context; fixtures do not write accepted planning state.
- Installed completion tools approve the displayed scope/SHA, retain PRD authoring in the interview session, open fresh issue planning, then start execution and dual review automatically. Repeated PRD/issues completion does not duplicate sessions or workers. No hidden approval-gate Git commit is made; setup is committed explicitly before startup.
- Executors perform real red/green tests, commit in isolated worktrees and integrate through candidate checks. Independent reviewers observe addition in their review worktrees. Reports distinguish passing validation (`verified`) from a real run-local timeout omission (`incomplete-validation`). Final qualified progress is delivered to the owning chat.
- Consumers have separate canonical stores, locks, command hashes and dashboard listeners. Dashboard HTML/JS, bundled skill content and the owned-process wrapper survive packing. Target branch and remotes are checked; no push, target merge or PR is performed.
- The real installed OpenCode smoke uses a local deterministic model and the native form API. On 2026-10-16 it **fails** before answers: an opening request is persisted but no native form appears, with no pending permission. `requestNativeInput` reaches `question.execute` and waits. The regression is retained; downstream real-host approval/PRD assertions are unverified. This blocks release and a complete live trial.
- Recovery notifications remain deferred until plugin activation returns. Disposal cancels owned work; workflow execution is bound to the host lifetime.

## Code references

- `package.json`, `scripts/clean-build.ts` — pinned dependencies, package allowlist and clean build.
- `tests/helpers/package.ts`, `tests/helpers/packaged-probe.ts` — two isolated tarball consumers, assets, automatic reports and published progress assertions.
- `tests/helpers/packaged-workflow.ts`, `tests/helpers/fake-opencode.ts` — installed command/tool/native-question boundary, real Git/TDD workers and duplicate completion checks.
- `tests/helpers/model-fixture.ts`, `tests/smoke/opencode.test.ts` — pinned real host, native forms, permission denial, cancellation and restart.
- `tests/integration/15-package.test.ts`, `tests/e2e/full-workflow.test.ts` — installed passing/timeout workflow coverage.
- `tests/integration/03-interview.test.ts`, `tests/integration/04-planning.test.ts` — unavailable input, stale/denied responses, retry budgets, stop and recovery.
- `tests/browser/dashboard.test.ts` — visible read-only planning/progress and qualified validation state.
- `src/plugin.ts`, `src/opencode/progress.ts` — host lifecycle, focus events and visible progress delivery.
- `scripts/package-smoke.ts`, `.github/workflows/ci.yml` — reproducible automated evidence and platform matrix.

## Related

- [Workflow controls and recovery](workflow-recovery.md)
- [Bounded review and repair](bounded-review-repairs.md)

## Notes

The 2026-10-15 credentialed trial used the previous protocol. It does not certify the 2026-10-16 native flow. Current command results, the human-visible acceptance checklist and missing Linux/native Windows evidence are recorded in `docs/package-validation.md`, `docs/live-opencode-trial.md` and `docs/live-opencode-evidence.json`. Missing human/platform evidence remains a release blocker.

Iteration 2 reran the full prescribed sequence after predecessor updates. Fixture integration (293 passed, one gated skip), seven browser tests and both packaged outcomes still pass; the opted-in real host reproduces the missing opening form (zero pending permissions). `docs/live-opencode-evidence.json` → `automated.revalidation` retains current command/log hashes, source receipts and archive identity alongside earlier evidence. No runtime or fixture change was made. Human participation was requested but no acceptance was recorded; human and Linux/Windows blockers remain.

## Last updated

2026-10-16
