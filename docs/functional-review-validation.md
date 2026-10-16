# Issue 12 completion evidence

Date: 2026-10-14. Runtime: Bun 1.4.3, macOS.

## Changed public behavior

`createCommandRouter(...).reviewFunctional(snapshot, options)` and exported
`runFunctionalReview` independently review the exact pinned commit. Results retain
criterion statuses, SHA-bound observation records, blocking acceptance findings,
cleanup logs, unavailable-attempt blockers and session identity. Results persist under
`review.functionalResult`, separately from code review. Duplicate completed invocations
reuse evidence; superseded completions are rejected.

Approved setup and cleanup are delegated through the explicit lifecycle contract.
Review neither edits approved configuration nor implements repairs. Dedicated browser
and HTTP tools are selectively enabled; shell and editing tools remain disabled.

## Behavioral development evidence

Observed red → green cycles:

1. Public backend review initially failed because `reviewFunctional` did not exist;
   the entrypoint, snapshot/workspace workflow and result persistence made it pass.
2. Fabricated evidence initially passed; evidence-record/coverage validation now
   returns `invalid-review` and unverified.
3. Startup diagnostics containing a quoted test secret initially leaked into the
   journal; recursive redaction now removes values from snapshots and events.
4. An observed HTTP failure with unavailable UI initially became unverified;
   partial observed failures now retain blocking findings without infrastructure retries.

Packaging and wiki changes have no independent behavioral TDD requirement.

## Acceptance evidence

| Criterion | Result | Evidence |
| --- | --- | --- |
| Every criterion has status/evidence or inability reason | Pass | Complete checklist validation; omitted/unknown evidence rejected; unsupported and justified N/A covered |
| Local UI/backend at reviewed commit | Pass for fixture | Real HTTP against committed fixture; real agent-browser form, screenshot and API observation through router/adapter boundary |
| At most three unavailable attempts | Pass | Missing account, startup, tool and output cases; three attempts, three owned cleanups, blockers retained |
| Observed failures remain blocking | Pass | HTTP failure plus unavailable UI returns findings after one attempt |
| Approved setup/cleanup policy preserved | Pass at lifecycle boundary | Frozen fixture lifecycle; no command JSON authoring; cleanup failure stops retries and cannot pass |
| Slice regression tests | Pass | Default suite: 9 pass, 1 gated smoke skipped; explicit smoke-enabled suite recorded below |
| Typecheck/lint | Pass | `bun run typecheck`; `bun run lint` |
| Demonstrable public flow | Pass for fixture | Smoke-enabled successful UI/API review; missing test-account reference produces three attempts then unverified |
| Live provider / Linux / native Windows | Unverified | Not executed here; no platform-specific test exclusions added |

Additional checks: `bun run build` passed. The first live browser invocation exceeded
Bun's default five-second test timeout; an explicit 60-second smoke timeout resolved it,
and the next invocation passed in approximately five seconds. The browser session is
owned by the smoke and closed during cleanup.

## Integration limitations

This checkout lacks issues 2–8's actual approved command/environment implementation.
`src/process/environment.ts` supplies the documented injectable lifecycle contract;
it does not invent command approval or execution behavior. The predecessor must wire
that lifecycle, authoritative revisions, actual feature surfaces and registered
OpenCode browser/HTTP observation tools. Missing tool access explicitly finishes
unverified. Checklist extraction expects explicit PRD acceptance lists/checkboxes and
graph issue `acceptanceCriteria`. Automatic repairs and interrupted-operation recovery
remain the later slices' responsibility. Worktrees/diagnostics are retained for review.

## Final command results

- `bun run typecheck`: passed.
- `bun run lint`: passed, 35 files checked.
- `bun test tests/integration/12-functional-review.test.ts`: 9 passed, 1 gated smoke skipped.
- `RUN_AGENT_BROWSER_SMOKE=1 bun test tests/integration/12-functional-review.test.ts`: 10 passed, 0 failed, including actual browser/HTTP review.
- `bun test tests/integration`: 41 passed, 1 gated smoke skipped, 0 failed.
- `bun run build`: passed.

Wiki updated: created `docs/wiki/features/functional-review.md`; updated the wiki
index and open questions with the predecessor/live-provider/platform boundaries.
