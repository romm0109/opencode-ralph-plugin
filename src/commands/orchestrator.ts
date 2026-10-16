import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type InterviewOptions,
  startInterview,
} from "../planning/interview.js";
import { releaseStoppedPlanningRun } from "../state/active-run.js";
import { handleControlCommand } from "./control.js";
import { resumeWorkflow } from "./resume.js";
/** The slash command owns startup; no model-selected workflow tool is involved. */
export async function startNativeFeature(options: InterviewOptions) {
  const { store, adapter } = options;
  let owner: { runId: string; repositoryId: string } | undefined;
  try {
    owner = JSON.parse(
      await readFile(join(store.root, "active-run.lock", "owner.json"), "utf8"),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const run = owner ? await store.getRun(owner.runId) : undefined;
  if (owner && (owner.repositoryId !== store.repositoryId || !run))
    throw new Error(
      "Repository ownership cannot be verified; reconcile before starting fresh",
    );
  if (run && run.reviewWorkflow?.status !== "terminal") {
    const state = run.planning;
    if (state?.protocol !== "native-interview-v1")
      throw new Error(
        "Unsupported saved workflow; a fresh workflow is required. Settle ownership with /ralph-stop; artifacts are preserved.",
      );
    const accepted = !!state.prdAcceptance;
    const restartable =
      !run.baseline && !Object.keys(run.issueAttempts ?? {}).length;
    const request = {
      kind: "existing-run" as const,
      runId: run.runId,
      workspace: options.workspace,
      sessionId: options.sessionId,
      requestId: randomUUID(),
      revision: run.revision,
      question: accepted
        ? `Run ${run.runId} has an accepted PRD (${state.phase}). Resume the saved stage using exact artifacts and remaining attempts, or keep it saved?`
        : `Run ${run.runId} has no accepted PRD. Restart discovery from the opening question in a fresh session. Old history and partial drafts remain available for diagnosis.`,
      options: [
        ...(accepted
          ? [
              {
                label: "Resume saved stage",
                description:
                  "Recover accepted artifacts and remaining attempts",
              },
            ]
          : []),
        ...(restartable
          ? [
              {
                label: "Restart discovery",
                description:
                  "Stop and verify cleanup, preserve history, then open a fresh interview",
              },
            ]
          : []),
        {
          label: "Keep saved run",
          description: "Leave the saved workflow in place",
        },
      ],
    };
    const answer = await adapter.requestUserInput(request);
    if (!answer.ok)
      throw new Error(
        `Existing-run question unavailable: ${answer.error.message}`,
      );
    if (
      answer.source !== "user" ||
      !answer.messageId ||
      answer.sessionId !== request.sessionId ||
      answer.requestId !== request.requestId ||
      answer.revision !== request.revision ||
      (await store.getRun(run.runId))?.revision !== run.revision
    )
      throw new Error("Existing-run choice is stale; inspect the current run");
    if (answer.text === "Keep saved run") return run;
    if (accepted && answer.text === "Resume saved stage") {
      await resumeWorkflow(store, adapter, run.runId);
      return store.getRun(run.runId);
    }
    if (!restartable || answer.text !== "Restart discovery")
      throw new Error("Choose an applicable existing-run option");
    await handleControlCommand("ralph-stop", run.runId, store, adapter, {
      expectedRevision: run.revision,
    });
    await releaseStoppedPlanningRun(store, run.runId);
  }
  return startInterview(options);
}
