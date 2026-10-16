import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRoleInstructions } from "../agents/skills.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { continuePlanning } from "../core/orchestrator.js";
import { handleExecutorQuestion } from "../execution/questions.js";
import { readReviewGit } from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import {
  completeInterview,
  completeIssues,
  completePrd,
} from "../planning/completion.js";
import { supervisePlanning } from "../planning/generation.js";
import { continueInterview } from "../planning/interview.js";
import { queueIssuePlanner } from "../planning/issues.js";
import { reconcileRun } from "../recovery/reconcile.js";
import { retryUnverifiedReview } from "../review/retry.js";
import type { RunStore } from "../state/run-store.js";
import { handleControlCommand } from "./control.js";

/** Called after an explicit native resume command has passed recovery/control checks. */
export async function resumeWorkflow(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  options: { selectedCommit?: string; review?: boolean } = {},
) {
  let run = await store.getRun(runId);
  if (run?.planning?.protocol !== "native-interview-v1")
    throw new Error("Unsupported saved workflow; a fresh workflow is required");
  if (options.review) {
    await handleControlCommand("ralph-resume", runId, store, adapter);
    return retryUnverifiedReview(store, adapter, runId);
  }
  if (run?.planning?.protocol === "native-interview-v1") {
    const owner = JSON.parse(
      await readFile(join(store.root, "active-run.lock", "owner.json"), "utf8"),
    );
    if (owner.runId !== runId || owner.repositoryId !== store.repositoryId)
      throw new Error("Repository ownership differs; resume blocked");
  }
  if (
    run?.planning?.protocol === "native-interview-v1" &&
    run.control &&
    run.control.status !== "active"
  ) {
    if (!run.planning.prdAcceptance)
      throw new Error(
        "No accepted PRD; use /ralph-orchestrator to restart discovery in a fresh session",
      );
    if (
      run.control.cleanupPending ||
      run.control.status === "blocked" ||
      (run.control.facts?.length && run.control.status === "stopped")
    )
      await handleControlCommand("ralph-resume", runId, store, adapter);
    if (run.control.status !== "paused")
      await reconcileRun({
        store,
        adapter,
        runId,
        directory: run.planning.workspace,
      });
    await handleControlCommand("ralph-resume", runId, store, adapter);
    run = await store.getRun(runId);
  }
  for (const attempt of Object.values(run?.issueAttempts ?? {}))
    if (
      attempt.status === "waiting" &&
      attempt.question &&
      !attempt.question.answer
    )
      handleExecutorQuestion(
        store,
        adapter,
        runId,
        attempt.issueId,
        attempt.question.request.requestId,
      );
  const planning = run?.planning;
  if (!run || !planning || run.reviewWorkflow?.status === "terminal")
    return run;
  if (
    planning.protocol === "native-interview-v1" &&
    planning.owner?.stage === "issues"
  )
    await adapter.focusStageSession?.(
      planning.workspace,
      runId,
      planning.owner.sessionId,
      "issues",
    );
  if (
    planning.protocol === "native-interview-v1" &&
    planning.explanation &&
    planning.owner
  ) {
    const config = await loadProjectConfig(planning.workspace);
    const head = (
      await readReviewGit(planning.workspace, ["rev-parse", "HEAD"])
    ).trim();
    if (
      options.selectedCommit &&
      (
        await readReviewGit(planning.workspace, [
          "rev-parse",
          "--verify",
          `${options.selectedCommit}^{commit}`,
        ])
      ).trim() !== head
    )
      throw new Error(
        "Check out the requested starting commit before renewed explanation approval",
      );
    if (
      planning.approval &&
      (options.selectedCommit ||
        head !== planning.approval.sha ||
        commandConfigHash(config.commands) !== planning.approval.commandHash)
    ) {
      if (
        Object.keys(run.issueAttempts ?? {}).length ||
        (run.baseline && run.baseline.status !== "failed")
      )
        throw new Error(
          "Starting inputs cannot change after execution begins; preserve the integration and start a fresh workflow",
        );
      return completeInterview(
        store,
        adapter,
        {
          runId,
          attempt: planning.owner.attempt,
          text: planning.explanation.text,
          scope: planning.explanation.scope,
          criteria: planning.explanation.criteria,
        },
        planning.sessionId,
        true,
      );
    }
    if (planning.phase === "explanation_approval")
      return completeInterview(
        store,
        adapter,
        {
          runId,
          attempt: planning.owner.attempt,
          text: planning.explanation.text,
          scope: planning.explanation.scope,
          criteria: planning.explanation.criteria,
        },
        planning.sessionId,
        true,
      );
    if (planning.prdAcceptance) {
      if (planning.issueAcceptance && planning.owner) {
        if (!planning.issueAcceptance.result) {
          await completeIssues(
            store,
            adapter,
            {
              runId,
              attempt: planning.issueAcceptance.attempt,
              graphPath: "graph.json",
            },
            planning.issueAcceptance.sessionId,
          );
          return store.getRun(runId);
        }
        return continuePlanning(store, adapter, runId);
      }
      if (!planning.prd)
        await completePrd(
          store,
          adapter,
          { runId, attempt: planning.prdAcceptance.attempt, path: "PRD.md" },
          planning.prdAcceptance.sessionId,
        );
      else if (planning.owner?.retired)
        await supervisePlanning(store, adapter, runId);
      else await queueIssuePlanner(store, adapter, runId);
      return store.getRun(runId);
    }
    if (["prd_generation", "issue_generation"].includes(planning.phase))
      return run;
  }
  const activePlanning = Object.values(run.jobs).some(
    (job) =>
      ["interview", "prd", "issues"].includes(job.envelope.role) &&
      job.status !== "terminal",
  );
  if (activePlanning) {
    if (options.selectedCommit)
      throw new Error(
        "Wait for the active planning job before selecting a starting commit",
      );
    return run;
  }
  if (options.selectedCommit)
    throw new Error(
      "Pinned commit changes require renewed explanation approval",
    );
  if (["interview", "explanation_approval"].includes(planning.phase)) {
    const path = planning.settings.skills.interview?.path;
    if (!path) throw new Error("Missing captured interview instructions");
    await continueInterview(
      store,
      adapter,
      runId,
      (
        await loadRoleInstructions(
          planning.workspace,
          "interview",
          path.startsWith("file:") ? {} : { interview: path },
        )
      ).text,
    );
  }
  return continuePlanning(store, adapter, runId);
}
