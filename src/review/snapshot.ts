import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { waitForDispatch } from "../commands/control.js";
import {
  pinReviewCommit,
  readReviewGit,
  resolveReviewCommit,
  verifyReviewRepository,
} from "../git/review-workspace.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import { artifactHash, issueBundleHash } from "../planning/artifacts.js";
import { assertNativeExecutionInputs } from "../planning/eligibility.js";
import { validateIssueGraph } from "../planning/graph.js";
import type { ReviewSnapshot, SnapshotOptions } from "./types.js";

export async function createReviewSnapshot(
  options: SnapshotOptions,
): Promise<ReviewSnapshot> {
  await waitForDispatch(options.store, options.runId);
  await verifyReviewRepository(options.directory, options.store.repositoryId);
  const run = await options.store.getRun(options.runId);
  const ids = options.graph.issues.map((issue) => issue.id);
  if (
    !run?.execution ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        run.execution?.issues.filter(
          (issue) => issue.id === id && issue.status === "integrated",
        ).length !== 1,
    ) ||
    run.execution.issues.some(
      (issue) => issue.status !== "integrated" || !ids.includes(issue.id),
    ) ||
    run.execution.integrationQueue.length ||
    Object.values(run.jobs).some(
      (job) =>
        job.status !== "terminal" &&
        !["code-review", "functional-review"].includes(job.envelope.role),
    )
  ) {
    throw new Error("All planned issues must be integrated before review");
  }
  if (
    !Number.isInteger(options.round) ||
    options.round < 1 ||
    options.round > 3 ||
    !options.prdRevision.trim() ||
    !options.graph.revision.trim() ||
    !options.evidenceRefs.length ||
    options.evidenceRefs.some((ref) => !ref.trim())
  )
    throw new Error("Invalid review revisions, round or evidence");
  if (options.approvedPlanning && run.planning)
    await assertNativeExecutionInputs(run.planning, options.runId);
  const commit = await resolveReviewCommit(options.directory, options.commit);
  const baseCommit = await resolveReviewCommit(
    options.directory,
    options.baseCommit,
  );
  await readReviewGit(options.directory, [
    "merge-base",
    "--is-ancestor",
    baseCommit,
    commit,
  ]);
  const snapshot: ReviewSnapshot = {
    runId: options.runId,
    round: options.round,
    commit,
    prdRevision: options.prdRevision,
    graphRevision: options.graph.revision,
    evidenceRefs: [...options.evidenceRefs],
  };
  if (run.review) {
    if (
      !run.review.superseded &&
      isDeepStrictEqual(run.review.snapshot, snapshot)
    )
      return run.review.snapshot;
    if (run.review.snapshot.round >= options.round)
      throw new Error("Superseded or conflicting review round");
  }
  let prd: string;
  let graph: string;
  if (options.approvedPlanning) {
    const planning = run.planning;
    const approved = planning?.executionEligibility;
    if (
      !planning?.prd ||
      !executionEligibilityMatchesRevision(planning) ||
      !planning.graph ||
      !approved ||
      planning.phase !== "execution_approved" ||
      approved.prdHash !== planning.prd.hash ||
      approved.graphHash !== planning.graph.hash ||
      options.prdRevision !== planning.prd.hash ||
      !isDeepStrictEqual(options.graph, {
        revision: planning.graph.hash,
        issues: planning.graph.value.issues,
      })
    )
      throw new Error(
        "Review requires the current approved planning revisions",
      );
    validateIssueGraph(
      planning.graph.value,
      planning.graph.files,
      planning.prd,
    );
    prd = await readFile(
      join(planning.workspace, planning.prd.artifactPath),
      "utf8",
    );
    if (
      artifactHash(prd) !== planning.prd.hash ||
      issueBundleHash(planning.graph.value, planning.graph.files) !==
        planning.graph.hash
    )
      throw new Error("Approved review requirements changed");
    graph = JSON.stringify({
      ...planning.graph.value,
      files: planning.graph.files,
    });
  } else {
    prd = await readReviewGit(options.directory, [
      "show",
      `${commit}:${options.prdPath ?? "PRD.md"}`,
    ]);
    graph = await readReviewGit(options.directory, [
      "show",
      `${commit}:${options.graphPath ?? "graph.json"}`,
    ]);
    const committedGraph = JSON.parse(graph);
    if (!isDeepStrictEqual(committedGraph, options.graph) || !prd.trim())
      throw new Error("Committed requirements do not match the approved graph");
  }
  const diff = await readReviewGit(options.directory, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    baseCommit,
    commit,
    "--",
  ]);
  const observeJob = options.adapter?.observeJob;
  const tddEvidence = await Promise.all(
    Object.values(run.issueAttempts ?? {})
      .filter(
        (attempt) => attempt.status === "integrated" && attempt.submission,
      )
      .map(async (attempt) => ({
        issueId: attempt.issueId,
        attempt: attempt.attempt,
        submittedCommit: attempt.submission?.submittedCommit ?? "",
        tdd: attempt.submission?.tdd ?? { cycles: [] },
        ...(observeJob
          ? {
              previousAttempts: await Promise.all(
                (attempt.history ?? [])
                  .filter(
                    (previous) =>
                      previous.executionResult?.outcome === "completed",
                  )
                  .map(async (previous) => ({
                    attempt: previous.attempt,
                    native: await observeJob(
                      previous.executionResult ?? previous.job,
                    ),
                  })),
              ),
              native: await observeJob(attempt.executionResult ?? attempt.job),
            }
          : {}),
      })),
  );
  if (
    !(await options.store.recordReviewSnapshot(options.runId, run.revision, {
      snapshot,
      inputs: {
        ...(tddEvidence.length ? { tddEvidence } : {}),
        baseCommit,
        prd,
        graph,
        diff,
        tests: run.execution.checks,
        execution: run.execution,
      },
    }))
  )
    throw new Error("Execution changed while creating review snapshot");
  const operation = {
    operationId: `review-pin-${options.round}`,
    kind: "review.pin" as const,
    status: "intent" as const,
    job: {
      runId: options.runId,
      jobId: `review-pin-${options.round}`,
      attempt: 1,
      role: "review-snapshot",
      workspace: options.directory,
      inputRevisions: { round: options.round },
      baseCommit: commit,
      prompt: "Pin review commit",
    },
  };
  if (!(await options.store.recordOperation(operation)))
    throw new Error("Review pin intent rejected");
  try {
    await pinReviewCommit(
      options.directory,
      `refs/ralph/reviews/${options.runId}/${options.round}`,
      commit,
    );
    await options.store.recordOperation({ ...operation, status: "completed" });
  } catch (cause) {
    await options.store.recordOperation({
      ...operation,
      status: "failed",
      error: {
        code: "sdk-error",
        message: "Cannot pin review commit",
        cause: String(cause),
      },
    });
    throw cause;
  }
  return snapshot;
}
