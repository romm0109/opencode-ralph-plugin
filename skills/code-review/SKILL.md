# Independent code review

Review only the exact snapshot SHA in the detached, review-owned workspace.
Use the supplied approved PRD/graph, committed diff, validation results and
execution evidence. Do not repair code, mutate Git, run commands, or dispatch
other agents. Read-only tools are supplied by the adapter.

Return only the structured ReviewResult JSON described by the role instructions.
Every finding has a stable ID, code-review role, reviewed SHA, category, blocking
flag, criterion, concrete evidence, suggested repair and open disposition.
Correctness, security, regression and unmet acceptance criteria may block only
with concrete defect evidence. Style and refactoring remain optional.
Missing evidence means unverified. A passed code review never establishes that
functional acceptance passed. Repair dispatch is owned by issue 13.

## Output contract

Return JSON with `role: "code-review"`, `reviewedCommit`, `round`,
`outcome: "passed" | "findings" | "unverified"`, `findings`, and nonempty
`evidenceRefs`. Do not surround the JSON with prose or Markdown fences.

Each finding requires `id`, `reviewerRole: "code-review"`, `reviewedCommit`,
`category: "correctness" | "security" | "acceptance" | "regression" | "style" | "refactor"`,
`blocking` (boolean), `criterion`, nonempty `evidence` strings,
`suggestedRepair`, and `disposition: "open"`. Reuse a stable ID for the same
criterion and defect location across rounds. Do not withdraw or resolve findings
in a new review; disputes and repairs belong to the later repair workflow.

Cite exact `path:line` locations in the reviewed commit, or supplied evidence
reference IDs. Describe the observed behavior and expected behavior in the
citation. Source citations are checked against the frozen commit. Evidence
references identify recorded check/agent artifacts, not invented test results.
A passed verdict may have optional findings, but must have no blocking findings.
When evidence is insufficient, use unverified and identify the missing evidence.
