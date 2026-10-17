import { randomUUID } from "node:crypto";
import type { UserInputRequest, UserInputResult } from "../core/types.js";
import type { RunStore } from "../state/run-store.js";
import { previewProjectRemoval, removeProject } from "./remove-project.js";

export const REMOVE_OPTION = "Remove Ralph state";
export const KEEP_OPTION = "Keep everything";

/**
 * `/ralph-remove` is plugin-driven: the plugin builds the preview, asks one
 * native question bound to that exact preview, and removes only on a real
 * matching answer. No model decides or approves anything.
 */
export async function runRemovalCommand(options: {
  directory: string;
  store: RunStore;
  sessionId: string;
  ask: (request: UserInputRequest) => Promise<UserInputResult>;
  signal?: AbortSignal;
}): Promise<string> {
  const { directory, store, sessionId } = options;
  const plan = await previewProjectRemoval(directory, store);
  if (plan.blockers.length)
    return [
      "Ralph removal blocked. Nothing was deleted.",
      ...plan.blockers.map((blocker) => `- ${blocker}`),
    ].join("\n");
  const request: UserInputRequest = {
    runId: "project-removal",
    sessionId,
    workspace: directory,
    requestId: randomUUID(),
    revision: 0,
    question: [
      "Remove Ralph from this project?",
      "Deletes:",
      ...plan.targets.map((path) => `- ${path}`),
      `Keeps: ${plan.preserves}`,
      ...(plan.retainedWorktrees.length
        ? [
            "Retained worktrees (kept):",
            ...plan.retainedWorktrees.map((path) => `- ${path}`),
          ]
        : []),
      plan.sharedState,
    ].join("\n"),
    options: [
      {
        label: REMOVE_OPTION,
        description: "Delete exactly the paths listed above",
      },
      { label: KEEP_OPTION, description: "Delete nothing" },
    ],
  };
  const answer = await options.ask(request);
  if (!answer.ok)
    return `Ralph removal not performed: ${answer.error.message}. Nothing was deleted.`;
  if (
    answer.source !== "user" ||
    answer.sessionId !== sessionId ||
    answer.requestId !== request.requestId ||
    answer.revision !== request.revision
  )
    return "Ralph removal not performed: the answer does not match this preview. Nothing was deleted.";
  if (answer.text !== REMOVE_OPTION)
    return "Ralph removal cancelled. Nothing was deleted.";
  // removeProject re-checks the preview under locks and refuses any change.
  const result = await removeProject(
    directory,
    store,
    plan.planId,
    options.signal,
  );
  return [
    "Ralph removed from this project.",
    "Deleted:",
    ...result.removed.map((path) => `- ${path}`),
    `Kept: ${result.preserved}`,
  ].join("\n");
}
