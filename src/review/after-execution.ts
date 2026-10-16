import { readReviewGit } from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { runCodeReview } from "./code-review.js";
import { createReviewSnapshot } from "./snapshot.js";

/** Scheduler handoff only; functional review and repair coordination have separate owners. */
export async function reviewIntegratedExecution(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  const run = await store.getRun(runId);
  if (
    !run ||
    (run.control && run.control.status !== "active") ||
    !run.execution?.issues.length ||
    run.execution.issues.some((i) => i.status !== "integrated")
  )
    return run;
  if (run.review) {
    if (adapter.finalizeExecution && run.reviewWorkflow?.status !== "terminal")
      await adapter.finalizeExecution(run.review.snapshot);
    return store.getRun(runId);
  }
  const planning = run.planning;
  if (!planning?.graph || !planning.prd || !run.baseline?.workspace)
    throw new Error("Missing approved execution review inputs");
  const directory = run.baseline.workspace;
  const commit = (await readReviewGit(directory, ["rev-parse", "HEAD"])).trim();
  const integration = Object.values(run.operations)
    .filter(
      (operation) =>
        operation.kind === "integration.advance" &&
        operation.status === "completed",
    )
    .at(-1);
  if (!integration?.expectedNew || integration.expectedNew !== commit)
    throw new Error(
      "Integration workspace no longer matches the accepted feature commit",
    );
  const snapshot = await createReviewSnapshot({
    store,
    adapter,
    directory,
    runId,
    round: 1,
    commit,
    baseCommit: run.baseline.candidateCommit,
    prdRevision: planning.prd.hash,
    graph: {
      revision: planning.graph.hash,
      issues: planning.graph.value.issues,
    },
    evidenceRefs: Object.values(run.issueAttempts ?? {}).map(
      (attempt) =>
        `integration:${attempt.issueId}:${attempt.attempt}:${attempt.integratedCommit}`,
    ),
    approvedPlanning: true,
  });
  if (adapter.finalizeExecution) {
    await adapter.finalizeExecution(snapshot);
    return store.getRun(runId);
  }
  await runCodeReview(snapshot, {
    store,
    adapter,
    directory,
    parentSessionId: planning.sessionId,
    ...(planning.settings.models["code-review"]
      ? { model: planning.settings.models["code-review"] }
      : {}),
  });
  return store.getRun(runId);
}
