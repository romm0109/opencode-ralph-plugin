import { preflightRun } from "../execution/preflight.js";
import {
  handleExecutorQuestion,
  prepareApprovedScope,
} from "../execution/questions.js";

export { preflightRun } from "../execution/preflight.js";

import {
  type CodeReviewOptions,
  runCodeReview,
} from "../review/code-review.js";
import type { ReviewSnapshot } from "../review/types.js";
/** Code review is a phase boundary; feature verification belongs to both reviewers. */
export function reviewCompletedCode(
  snapshot: ReviewSnapshot,
  options: CodeReviewOptions,
) {
  return runCodeReview(snapshot, options);
}

export {
  handleInterviewResponse,
  startInterview,
} from "../planning/interview.js";
export { coordinateReviewRound } from "../review/coordinator.js";

import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { completeInterview } from "../planning/completion.js";
import { queueApprovedPrd } from "../planning/prd.js";
import type { RunStore } from "../state/run-store.js";

/** Approved execution proceeds through baseline validation into DAG scheduling. */
export async function continuePlanning(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  for (;;) {
    const run = await store.getRun(runId);
    if (run?.planning && run.planning.protocol !== "native-interview-v1")
      throw new Error(
        "Unsupported saved workflow; a fresh workflow is required",
      );
    if (!run?.planning || (run.control && run.control.status !== "active"))
      return run;
    if (run.planning.phase === "execution_approved") {
      const prepared = run.planning.scopeChange
        ? await prepareApprovedScope(store, adapter, runId)
        : await preflightRun(store, adapter, runId);
      if (
        prepared?.baseline &&
        ["passed", "passed_with_omissions"].includes(prepared.baseline.status)
      )
        return scheduleReadyIssues(store, adapter, runId);
      return prepared;
    }
    if (run.planning.phase === "explanation_approved") {
      await queueApprovedPrd(store, adapter, runId);
      return store.getRun(runId);
    }
    if (run?.planning?.phase !== "execution_approval") return run;
    if (run.planning.protocol === "native-interview-v1") {
      if (run.planning.revisionProposal && run.planning.owner) {
        await completeInterview(
          store,
          adapter,
          {
            runId,
            attempt: run.planning.owner.attempt,
            ...run.planning.revisionProposal,
          },
          run.planning.sessionId,
          true,
        );
        return store.getRun(runId);
      }
      await store.recordPlanning(runId, run.revision, {
        ...run.planning,
        error: {
          code: "baseline-blocked",
          message:
            "Execution eligibility invalidated; restore approved inputs or renew explanation approval",
        },
      });
      return store.getRun(runId);
    }
    return store.getRun(runId);
  }
}

import type { AttemptOptions } from "../execution/attempts.js";
import { executeIssue } from "../execution/execute-issue.js";
import { integrateIssue } from "../execution/integrate-issue.js";
import { scheduleReadyIssues } from "../execution/scheduler.js";

export {
  reconcileReadiness,
  scheduleReadyIssues,
} from "../execution/scheduler.js";

/** One issue budget; execution leases shared slots independently of integration. */
export async function runIssue(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  issueId: string,
  options: AttemptOptions = {},
) {
  for (;;) {
    let attempt = await executeIssue(store, adapter, runId, issueId, options);
    const settled = await store.getRun(runId);
    if (settled?.control && settled.control.status !== "active") return attempt;
    if (["submitted", "merging"].includes(attempt.status))
      attempt = await integrateIssue(store, adapter, runId, issueId, options);
    if (attempt.status === "waiting" && attempt.question)
      handleExecutorQuestion(
        store,
        adapter,
        runId,
        issueId,
        attempt.question.request.requestId,
        options,
      );
    if (attempt.status !== "failed") return attempt;
    const run = await store.getRun(runId);
    if (run?.control && run.control.status !== "active") return attempt;
  }
}
