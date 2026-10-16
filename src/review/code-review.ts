import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { waitForDispatch } from "../commands/control.js";
import type { JobEnvelope } from "../core/types.js";
import {
  createReviewWorkspace,
  verifyFindingEvidence,
  verifyReviewRepository,
  verifyReviewWorkspace,
} from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { loadRoleInstructions } from "../roles/instructions.js";
import type { RunStore } from "../state/run-store.js";
import type { ReviewResult, ReviewSnapshot } from "./types.js";
import { validateReviewResult } from "./validate-result.js";

export interface CodeReviewOptions {
  store: RunStore;
  adapter: OpenCodeAdapter;
  directory: string;
  parentSessionId: string;
  model?: JobEnvelope["model"];
}
export async function runCodeReview(
  snapshot: ReviewSnapshot,
  options: CodeReviewOptions,
): Promise<ReviewResult> {
  await waitForDispatch(options.store, snapshot.runId);
  await verifyReviewRepository(options.directory, options.store.repositoryId);
  const run = await options.store.getRun(snapshot.runId);
  if (
    !run?.review ||
    run.review.superseded ||
    !isDeepStrictEqual(run.review.snapshot, snapshot) ||
    run.operations[`review-pin-${snapshot.round}`]?.status !== "completed"
  )
    throw new Error("Unknown or superseded review snapshot");
  if (run.review.result) return run.review.result;
  const workspace = join(options.store.root, "review-workspaces", randomUUID());
  const job: JobEnvelope = {
    runId: snapshot.runId,
    jobId: `code-review-${snapshot.round}`,
    attempt: 1,
    role: "code-review",
    readOnly: true,
    workspace,
    baseCommit: snapshot.commit,
    inputRevisions: { round: snapshot.round },
    prompt: `${await loadRoleInstructions("code-review")}\nReview input:\n${JSON.stringify({ snapshot, ...run.review.inputs })}`,
    ...(options.model ? { model: options.model } : {}),
  };
  const operation = {
    operationId: `review-workspace-${snapshot.round}`,
    kind: "review.workspace" as const,
    status: "intent" as const,
    job,
  };
  if (!(await options.store.recordOperation(operation)))
    throw new Error(
      "Review dispatch already started; resume must reconcile the existing operation",
    );
  try {
    await createReviewWorkspace(options.directory, workspace, snapshot.commit);
    await options.store.recordOperation({ ...operation, status: "completed" });
  } catch (cause) {
    await options.store.recordOperation({
      ...operation,
      status: "failed",
      error: {
        code: "sdk-error",
        message: "Review workspace preparation failed",
        cause: String(cause),
      },
    });
    throw cause;
  }
  await waitForDispatch(options.store, snapshot.runId);
  const response = await options.adapter.dispatchJob(job);
  const result: ReviewResult = {
    role: "code-review",
    reviewedCommit: snapshot.commit,
    round: snapshot.round,
    outcome: "unverified",
    findings: [],
    evidenceRefs: response.evidence,
    ...(response.sessionId ? { sessionId: response.sessionId } : {}),
  };
  try {
    if (
      response.outcome === "completed" &&
      (!response.sessionId ||
        response.sessionId === options.parentSessionId ||
        Object.values(run.jobs).some(
          (entry) => entry.envelope.sessionId === response.sessionId,
        ) ||
        response.baseCommit !== snapshot.commit ||
        response.workspace !== workspace ||
        response.runId !== snapshot.runId ||
        response.jobId !== job.jobId ||
        response.attempt !== job.attempt)
    )
      throw new Error(
        "Reviewer response is not an independent correlated session",
      );
    await verifyReviewWorkspace(workspace, snapshot.commit);
    if (response.outcome === "completed" && response.text) {
      const parsed = validateReviewResult(response.text, snapshot);
      for (const finding of parsed.findings)
        if (finding.blocking)
          await verifyFindingEvidence(
            workspace,
            snapshot.commit,
            finding.evidence,
            snapshot.evidenceRefs,
          );
      result.findings = parsed.findings;
      result.outcome = parsed.outcome;
      result.evidenceRefs = [...parsed.evidenceRefs, ...response.evidence];
    } else {
      result.error = response.error ?? {
        code: "missing-output",
        message: "No completed reviewer output",
      };
    }
  } catch (cause) {
    result.error = {
      code: "invalid-review",
      message: cause instanceof Error ? cause.message : String(cause),
      cause:
        cause instanceof Error
          ? { name: cause.name, message: cause.message }
          : cause,
    };
  }
  const summary = `Code review round ${snapshot.round} at ${snapshot.commit}: ${result.outcome}.${result.error ? ` ${result.error.message}` : ""}\n${result.findings.map((finding) => `${finding.id} [${finding.blocking ? "blocking" : "optional"}] ${finding.category}: ${finding.criterion}\nEvidence: ${finding.evidence.join("; ")}\nSuggested repair: ${finding.suggestedRepair}`).join("\n")}\nFunctional review is still required.`;
  if (
    !(await options.store.recordReviewResult(
      snapshot.runId,
      snapshot,
      result,
      summary,
    ))
  )
    throw new Error("Superseded review result ignored");
  const stored = (await options.store.getRun(snapshot.runId))?.review;
  if (
    !stored?.result ||
    stored.superseded ||
    stored.snapshot.round !== snapshot.round
  )
    throw new Error("Superseded review publication ignored");
  const publish = {
    operationId: `review-publish-${snapshot.round}`,
    kind: "review.publish" as const,
    status: "intent" as const,
    job,
  };
  await waitForDispatch(options.store, snapshot.runId);
  if (!(await options.store.recordOperation(publish))) return result;
  const published = await options.adapter.publishStatus(
    options.parentSessionId,
    options.directory,
    stored.summary ?? summary,
  );
  await options.store.recordOperation({
    ...publish,
    status: published.ok ? "completed" : "failed",
    ...(published.error ? { error: published.error } : {}),
  });
  return stored.result;
}
