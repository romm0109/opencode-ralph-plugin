import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { assertPlanningOwner, completeInterview } from "./completion.js";
import { savePlanning } from "./generation.js";

export const productDecisionInput = z
  .object({
    runId: z.string().min(1),
    attempt: z.number().int().positive(),
    question: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
    revisedExplanation: z
      .object({
        text: z.string().trim().min(1),
        scope: z.array(z.string().trim().min(1)).min(1),
        criteria: z.array(z.string().trim().min(1)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Persist the stage-owned identity before invoking the native host boundary. */
export async function requestProductDecision(
  store: RunStore,
  adapter: OpenCodeAdapter,
  input: z.infer<typeof productDecisionInput>,
  sessionId: string,
) {
  const value = productDecisionInput.parse(input);
  let { run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  );
  const last = state.decisions?.at(-1);
  // A retry of an interrupted revised-scope approval uses its recorded proposal.
  if (
    (state.phase === "explanation_approval" || state.revisionProposal) &&
    last?.answer &&
    last.revisedExplanation
  )
    return completeInterview(
      store,
      adapter,
      {
        runId: value.runId,
        attempt: value.attempt,
        ...last.revisedExplanation,
      },
      sessionId,
      true,
    );
  if (
    !state.owner ||
    !["prd", "issues"].includes(state.owner.stage) ||
    !state.approval ||
    (state.owner.stage === "prd"
      ? state.phase !== "prd_generation" || !!state.prdAcceptance
      : state.phase !== "issue_generation" || !!state.issueAcceptance)
  )
    throw new Error(
      "Product decisions require the authorized owning PRD or issue stage",
    );
  if (!state.pending) {
    const next = structuredClone(state);
    const request = {
      kind: "product" as const,
      runId: run.runId,
      workspace: state.workspace,
      sessionId,
      requestId: randomUUID(),
      revision: state.explanation?.revision ?? 0,
      recommendation: value.recommendation,
      question: `Stage: ${state.owner.stage}, attempt ${value.attempt}\n${value.question}\nRecommended answer: ${value.recommendation}`,
    };
    next.pending = request;
    next.decisions = [
      ...(next.decisions ?? []),
      {
        stage: state.owner.stage as "prd" | "issues",
        attempt: value.attempt,
        request,
        ...(value.revisedExplanation
          ? { revisedExplanation: value.revisedExplanation }
          : {}),
      },
    ];
    await savePlanning(store, run.runId, run.revision, next);
  }
  ({ run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  ));
  const request = state.pending;
  const decision = state.decisions?.at(-1);
  if (
    !request ||
    request.kind !== "product" ||
    decision?.request.requestId !== request.requestId
  )
    return {
      outcome: "blocked",
      message: "Resolve the pending scope approval first",
    };
  const response = await adapter.requestUserInput(request);
  if (!response.ok)
    return {
      outcome: "blocked",
      requestId: request.requestId,
      error: response.error,
    };
  ({ run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  ));
  if (
    state.pending?.requestId !== request.requestId ||
    response.source !== "user" ||
    response.requestId !== request.requestId ||
    response.sessionId !== sessionId ||
    response.revision !== request.revision ||
    !response.messageId ||
    !response.text.trim() ||
    state.transcript.some((e) => e.messageId === response.messageId)
  )
    return { outcome: "stale", requestId: request.requestId };
  const next = structuredClone(state);
  const current = next.decisions?.at(-1);
  if (!current) throw new Error("Missing product decision intent");
  current.answer = response;
  if (current.revisedExplanation)
    next.revisionProposal = current.revisedExplanation;
  delete next.pending;
  next.transcript.push({
    source: "user",
    text: response.text,
    messageId: response.messageId,
    requestId: response.requestId,
    revision: response.revision,
  });
  await savePlanning(store, run.runId, run.revision, next);
  if (current.revisedExplanation)
    return completeInterview(
      store,
      adapter,
      {
        runId: value.runId,
        attempt: value.attempt,
        ...current.revisedExplanation,
      },
      sessionId,
      true,
    );
  return {
    outcome: "answered",
    requestId: request.requestId,
    answer: response.text,
    message:
      "Continue within approved scope. If this answer changes scope, submit a revisedExplanation before completion.",
  };
}
