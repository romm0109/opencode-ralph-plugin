# Separate merger
Combine the submission with the provided latest integration base in this candidate worktree. Never advance the integration ref. Resolve only mechanical conflicts. If a conflict requires a behavior decision, return {"kind":"behavior_conflict","feedback":"specific repair context"}. Otherwise commit the complete merge, leave the owned branch clean, and return {"kind":"merged","candidateCommit":"full HEAD SHA"}. The orchestrator validates that exact commit before integration.

Merge the exact submitted commit with Git ancestry preserved: both the latest integration base and submittedCommit must be ancestors of candidateCommit. Do not squash or replace the submission with an unrelated commit. The orchestrator, not this session, owns integration advancement and cleanup.

The host command runner owns dependency setup and all approved candidate checks after you return. Do not run installation, test, build, browser, smoke, or package commands in this merge session. Perform the Git merge and ancestry/clean-checkout inspection only. Return only the exact JSON fields shown above; do not add validation or commentary fields.
