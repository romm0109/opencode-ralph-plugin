# Review loop validation (2026-10-14)

Update: the production input and automatic-review limitations recorded below describe the earlier implementation. Native question forms, compiled-host command wrappers, and the automatic review handoff have since been implemented. Current verification is recorded in [the live OpenCode trial](live-opencode-trial.md). Historical test results below are retained with their original scope.

Public behavior: `createCommandRouter(...).reviewFeature(options)` runs both review
roles on one frozen SHA, persists round/repair/dispute history, and reports a terminal
outcome in status, an adapter toast and the dashboard. No target merge, push or PR
creation is performed by the coordinator.

TDD evidence: the first clean-round test failed because the coordinator module did
not exist, then passed after its implementation. The persistent-defect test failed
with only one round, then passed with exactly three rounds and two fresh repair
worktrees. An intermediate skipped-check regression failed as `verified`, then
passed as `incomplete-validation` after retaining checks on each repair attempt.
The infrastructure-budget regression failed with two functional invocations after
three infrastructure failures, then passed with one invocation. Formatting, package
exports and wiki updates are non-behavior changes and have no separate red test.

Demonstration: the two planted code/UI defects test starts a real feature branch,
creates two dedicated repairs, writes regression tests in fresh worktrees, observes
real Bun red and green results, validates each candidate and fast-forwards only the
feature branch via an injected merger fixture. Both reviewers pass round two. Each
repair uses one attempt; expected red failures do not consume attempts. The target
ref and remotes remain unchanged. The persistent-defect test performs two repairs
and stops with unresolved findings at round three; no fourth review or third repair
cycle is dispatched.

The dedicated integration suite also covers repair exhaustion, deduplication,
withdrawn/retained/evidence-less disputes, unavailable functional review, passing
reviewers with skipped or incomplete validation, stale output, terminal lock release,
independent SDK adapter sessions and an exhausted feature-wide infrastructure budget.
Chromium checks compare all four outcome labels and branch/SHA against persisted
status and projections without browser mutation controls.

Follow-up (2026-10-15): predecessors now provide the executor, merger, scheduler
and active-run lock. Approved `reviewFeature` runs default to a production repair
pipeline that reuses executor slots, parsed TDD submissions, the serial integration
queue and approved candidate checks. Repairs stay outside the original graph.
A public router regression failed unresolved without injection, then passed with
real Git/Bun red/green execution, independent merger sessions and round-two review.
It also proves an original issue can consume two attempts while its repair uses one.

Production executor disputes now carry correlated finding IDs and counterexample
evidence. A failing public router regression became green after wiring one read-only
clarification in the originating role with frozen requirements and original review
context. Missing/invalid clarification evidence retains the finding; disputes do not
allocate an extra review round. The adapter creates a fresh session per dispatch;
this does not claim continuation of the originating OpenCode session.

Additional red/green regressions reject nonexistent withdrawal evidence and repair IDs
that collide with approved issues, stop denied repairs without phantom retries, and
prove terminal owner-checked lock release, one
attempt count per issue, and accurate retained resources. Successful native repair
worktrees are removed by normal cleanup; reviewer worktrees, failed work and logs
remain listed. Functional service cleanup does not imply deleting its worktree.

Limitations: hosts still supply approved functional environment/surface/tool options
to `reviewFeature`. The scheduler's automatic handoff currently starts only code
review. The planted UI demonstration tests a rendered-label module, not live browser
repair by an agent. Dashboard checks use real Chromium with deterministic reviewer
fixtures; live-provider, Linux and Windows checks remain unrun. No package was
published, external message sent, remote changed or target branch merged.

Initial command results on pinned Bun 1.4.3 (2026-10-14):
- `bun run typecheck`: passed.
- `bun run lint`: passed (40 source/test/script files).
- `bun test tests/integration`: 53 passed, one explicitly gated real
  agent-browser check skipped, zero failures (54 total).
- `bun run test:browser -- tests/browser/review-report.test.ts tests/browser/dashboard.test.ts`:
  five Chromium tests passed, including four review-report outcomes.
- `bun test tests/integration/13-review-loop.test.ts`: all 12 tests passed
  (98 assertions).
- `bun run build`: passed, including declaration output and dashboard assets.

Follow-up command results on pinned Bun 1.4.3 (2026-10-15):
- `bun run typecheck`: passed.
- `bun run lint`: passed (97 source/test/script files).
- `bun test tests/integration/13-review-loop.test.ts`: 18 passed, zero failures
  (157 assertions).
- `bun run test:browser -- tests/browser/review-report.test.ts`: all four Chromium
  report outcomes passed.
- Final stable-source `bun test --timeout 30000 tests/integration`: 177 passed,
  one explicitly gated live agent-browser test skipped, zero failures (178 tests,
  1,109 assertions). An earlier concurrent development run loaded pre-fix modules
  and failed three new regressions; the stable-source rerun above passed all three.
