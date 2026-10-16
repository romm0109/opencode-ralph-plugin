# Acceptance-based functional review

## Summary
`runFunctionalReview` / router `reviewFunctional` review the pinned shared snapshot in
an independent OpenCode session and detached owned worktree. Code and functional
results are stored separately; neither marks the feature complete.

## Key behavior
- Checklist IDs come from explicit PRD acceptance lists/checkboxes and graph issue
  `acceptanceCriteria`. Supplied UI/HTTP surfaces determine planned coverage. Command-only criteria use log coverage.
- Each criterion reports pass, fail, justified not-applicable, or unverified. Observed
  results cite typed, SHA-bound browser/HTTP evidence records. Pass requires planned
  coverage; a failure on one observed surface stays blocking despite unavailable paths.
- Missing startup, tools, access, or agent output permits three total attempts. Invalid
  output and observed defects do not grant infrastructure retries or repair rounds.
- Production scheduling invokes `runAutomaticReview` after integration. It reconstructs the approved lifecycle, invokes both reviewers and the bounded repair coordinator, publishes the report, and releases the run lock. Library adapters may supply `finalizeExecution`; otherwise the existing code-only handoff remains available.
- Command-only review re-runs exact approved checks against the frozen SHA and supplies sanitized outputs to the independent reviewer; no URL is required. Missing evidence cannot pass.
- The caller supplies an approved lifecycle and registered dedicated observation tool
  IDs. Setup/cleanup delegate to that lifecycle; review never discovers or edits commands.
  Shell/edit tools stay disabled. Tool discovery uses the existing pinned SDK boundary.
- Journals precede worktree/setup/cleanup effects. Cleanup runs even for partial startup;
  failed cleanup stops retries. Worktrees and diagnostic evidence remain retained.
- Superseded snapshots cannot attach sessions or publish results. Repeated completed
  invocations return stored evidence; interrupted operations require reconciliation.
- Nested diagnostics are redacted before persistence, including quoted secret values.

## Code references
- `src/review/automatic.ts`, `src/review/after-execution.ts` — production scheduling handoff and approved environment reconstruction.
- `src/review/functional-review.ts` — bounded workflow and public options.
- `src/review/functional-results.ts` — checklist, evidence and verdict validation.
- `src/process/environment.ts` — approved lifecycle structural boundary.
- `skills/functional-review/SKILL.md` — reviewer instructions and output schema.
- `tests/integration/12-functional-review.test.ts` — fixture, adapter and gated smoke.
- `tests/fixtures/review-app.ts` — committed HTML form and local API fixture.

## Related
- [Independent code review](independent-code-review.md)

## Notes
Automatic HTTP review uses the configured URL and an available host HTTP/webfetch tool.
UI-specific observation still requires a host-supplied browser tool and explicit surface options.
The fixture has actual HTTP observations; the
opt-in agent-browser smoke performs real form submission with fake reviewer prose.
Live OpenCode provider observation tools and Linux/Windows execution are unverified.

## Last updated
2026-10-15

Review input includes native executor test receipts, submission TDD, commit-bound candidate check statuses, the frozen diff and approved command-policy identity. Historical TDD criteria can be verified from correlated host observations after executor worktree cleanup; absent or truncated observations remain disclosed.
