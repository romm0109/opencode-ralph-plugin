import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { executorQuestionSchema } from "../agents/results.js";
import { continuePlanning } from "../core/orchestrator.js";
import type {
  Failure,
  RunRecord,
  UserInputRequest,
  UserInputResult,
} from "../core/types.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import { artifactHash, issueBundleHash } from "../planning/artifacts.js";
import { topologicalOrder, validateIssueGraph } from "../planning/graph.js";
import type { RunStore } from "../state/run-store.js";
import type { AttemptOptions } from "./attempts.js";
import type { IssueAttempt } from "./execute-issue.js";
import { scheduleReadyIssues } from "./scheduler.js";

export interface ExecutorQuestion
  extends z.infer<typeof executorQuestionSchema> {
  request: UserInputRequest;
  jobId: string;
  attempt: number;
  operationId: string;
  epoch: number;
  prdHash: string;
  graphHash: string;
  inputRevisions: Record<string, number>;
  answer?: Extract<UserInputResult, { ok: true }>;
  error?: Failure;
}
export function createExecutorQuestion(
  run: RunRecord,
  attempt: IssueAttempt,
  value: z.infer<typeof executorQuestionSchema>,
): ExecutorQuestion {
  const state = run.planning;
  if (!state?.prd || !state.graph)
    throw new Error("Missing approved question artifacts");
  return {
    kind: value.kind,
    question: value.question,
    recommendedAnswer: value.recommendedAnswer,
    affectedRequirement: value.affectedRequirement,
    ...(value.revisedExplanation
      ? { revisedExplanation: value.revisedExplanation }
      : {}),
    jobId: attempt.job.jobId,
    attempt: attempt.attempt,
    operationId: attempt.operationId,
    epoch: run.control?.epoch ?? 0,
    prdHash: state.prd.hash,
    graphHash: state.graph.hash,
    inputRevisions: {
      ...attempt.job.inputRevisions,
      prd: state.prd.revision,
      graph: state.graph.revision,
    },
    request: {
      ...(state.protocol === "native-interview-v1"
        ? { kind: "product" as const, recommendation: value.recommendedAnswer }
        : {}),
      runId: run.runId,
      workspace: state.workspace,
      sessionId: state.sessionId,
      requestId: randomUUID(),
      revision: state.graph.revision,
      question: `Issue ${attempt.issueId}, attempt ${attempt.attempt}\nRequirement: ${value.affectedRequirement}\n${value.question}\nRecommended answer: ${value.recommendedAnswer}`,
    },
  };
}

/** Durable pending identity is the publication intent; waiting has no agent timer. */
const pending = new Map<string, Promise<void>>();
export function handleExecutorQuestion(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  issueId: string,
  requestId?: string,
  options: AttemptOptions = {},
) {
  const key = `${store.repositoryId}:${runId}:${issueId}:${requestId ?? "current"}`;
  if (pending.has(key)) return;
  const work = (async () => {
    const attempt = (await store.getRun(runId))?.issueAttempts?.[issueId];
    const question = attempt?.question;
    if (
      attempt?.status !== "waiting" ||
      !question ||
      question.answer ||
      (requestId && question.request.requestId !== requestId)
    )
      return;
    const published = await adapter.publishStatus(
      question.request.sessionId,
      question.request.workspace,
      question.request.question,
    );
    const response: UserInputResult = published.ok
      ? await adapter.requestUserInput(question.request)
      : {
          ok: false,
          error: published.error ?? {
            code: "sdk-error",
            message: "Could not publish executor question",
          },
        };
    if (!response.ok) {
      for (;;) {
        const latest = await store.getRun(runId);
        const current = latest?.issueAttempts?.[issueId];
        if (
          !latest ||
          (latest.control && latest.control.status !== "active") ||
          !current?.question ||
          current.question.request.requestId !== question.request.requestId ||
          current.question.answer
        )
          return;
        current.question.error = response.error;
        if (await store.recordIssueAttempt(runId, latest.revision, current))
          return;
      }
    }
    if (await answerExecutorQuestion(store, runId, issueId, response)) {
      if (
        (await store.getRun(runId))?.planning?.phase === "execution_approval"
      ) {
        await continuePlanning(store, adapter, runId);
      } else {
        // A scheduler may still be settling independent workers. Join it, then re-read.
        await scheduleReadyIssues(store, adapter, runId, options);
        await scheduleReadyIssues(store, adapter, runId, options);
      }
    }
  })()
    .catch(async (cause) => {
      const run = await store.getRun(runId);
      const attempt = run?.issueAttempts?.[issueId];
      if (
        run &&
        attempt?.question &&
        attempt.status === "waiting" &&
        (!requestId || attempt.question.request.requestId === requestId)
      ) {
        attempt.question.error = { code: "sdk-error", message: String(cause) };
        await store.recordIssueAttempt(runId, run.revision, attempt);
      }
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, work);
}

export async function answerExecutorQuestion(
  store: RunStore,
  runId: string,
  issueId: string,
  response: UserInputResult,
) {
  for (;;) {
    const run = await store.getRun(runId);
    const attempt = run?.issueAttempts?.[issueId];
    const q = attempt?.question;
    const state = run?.planning;
    if (
      !run ||
      !state ||
      !attempt ||
      attempt.status !== "waiting" ||
      !q ||
      q.answer ||
      (run.control && run.control.status !== "active") ||
      (run.control?.epoch ?? 0) !== q.epoch ||
      attempt.operationId !== q.operationId ||
      attempt.job.jobId !== q.jobId ||
      attempt.attempt !== q.attempt ||
      state.phase !== "execution_approved" ||
      !executionEligibilityMatchesRevision(state) ||
      state.prd?.hash !== q.prdHash ||
      state.graph?.hash !== q.graphHash ||
      state.graph?.revision !== q.request.revision ||
      state.prd?.revision !== q.inputRevisions.prd ||
      !response.ok ||
      response.source !== "user" ||
      !response.messageId ||
      !response.text.trim() ||
      response.requestId !== q.request.requestId ||
      response.sessionId !== q.request.sessionId ||
      response.revision !== q.request.revision ||
      state.transcript.some(
        (entry) => entry.messageId === response.messageId,
      ) ||
      Object.values(run.issueAttempts ?? {}).some((a) =>
        [...(a.questions ?? []), ...(a.question ? [a.question] : [])].some(
          (q) => q.answer?.messageId === response.messageId,
        ),
      )
    )
      return false;
    if (
      artifactHash(
        await readFile(join(state.workspace, state.prd.artifactPath), "utf8"),
      ) !== state.prd.hash
    )
      return false;
    if (state.protocol === "native-interview-v1" && q.revisedExplanation) {
      await reviseQuestionScope(
        store,
        run,
        attempt,
        response,
        await readFile(join(state.workspace, state.prd.artifactPath), "utf8"),
        structuredClone(state.graph.value),
        state.graph.files,
        q.revisedExplanation,
      );
      return true;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.text);
    } catch {
      /* Ordinary clarification prose. */
    }
    if (
      raw &&
      typeof raw === "object" &&
      "kind" in raw &&
      raw.kind === "revise_scope"
    ) {
      const draft = z
        .object({
          kind: z.literal("revise_scope"),
          explanation: z
            .object({
              text: z.string().trim().min(1),
              scope: z.array(z.string().trim().min(1)).min(1),
              criteria: z.array(z.string().trim().min(1)).min(1),
            })
            .strict()
            .optional(),
          prd: z.string().trim().min(1),
          graph: z.unknown(),
          files: z.record(z.string(), z.string()),
        })
        .strict()
        .parse(raw);
      if (state.protocol === "native-interview-v1" && !draft.explanation)
        return false;
      const currentPrd = await readFile(
        join(state.workspace, state.prd.artifactPath),
        "utf8",
      );
      const value = validateIssueGraph(
        { ...(draft.graph as object), prdRevision: state.prd },
        draft.files,
        state.prd,
      );
      if (
        draft.explanation ||
        draft.prd !== currentPrd ||
        issueBundleHash(value, draft.files) !== state.graph.hash
      ) {
        await reviseQuestionScope(
          store,
          run,
          attempt,
          response,
          draft.prd,
          value,
          draft.files,
          draft.explanation,
        );
        return true;
      }
    }
    q.answer = response;
    attempt.status = "resume_ready";
    if (await store.recordIssueAttempt(runId, run.revision, attempt))
      return true;
  }
}

/** Explicit user-correlated artifact edits always pass the normal approval gate. */
async function reviseQuestionScope(
  store: RunStore,
  run: RunRecord,
  attempt: IssueAttempt,
  response: Extract<UserInputResult, { ok: true }>,
  text: string,
  value: import("../planning/graph.js").IssueGraph,
  files: Record<string, string>,
  explanation?: { text: string; scope: string[]; criteria: string[] },
) {
  const state = structuredClone(run.planning);
  if (
    !state?.prd ||
    !state.graph ||
    !state.executionEligibility ||
    !attempt.question
  )
    throw new Error("Missing scope revision context");
  const oldPrd = state.prd,
    oldGraph = state.graph,
    oldApproval = state.executionEligibility;
  const revision = oldGraph.revision + 1;
  const directory = `.ralph/features/${run.runId}/scope-${revision}`;
  const prd = {
    revision: oldPrd.revision + 1,
    hash: artifactHash(text),
    artifactPath: `${directory}/PRD.md`,
  };
  value.prdRevision = prd;
  validateIssueGraph(value, files, prd);
  const affected = new Set<string>();
  const previousText = await readFile(
    join(state.workspace, oldPrd.artifactPath),
    "utf8",
  );
  for (const issue of value.issues) {
    const old = oldGraph.value.issues.find((i) => i.id === issue.id);
    if (
      explanation ||
      text !== previousText ||
      JSON.stringify(old) !== JSON.stringify(issue) ||
      oldGraph.files[issue.artifactPath] !== files[issue.artifactPath]
    )
      affected.add(issue.id);
  }
  for (const old of oldGraph.value.issues)
    if (!value.issues.some((i) => i.id === old.id)) affected.add(old.id);
  for (const id of topologicalOrder(value)) {
    if (
      value.issues
        .find((i) => i.id === id)
        ?.dependencies.some((d) => affected.has(d))
    )
      affected.add(id);
  }
  state.scopeChange = {
    issueId: attempt.issueId,
    requestId: attempt.question.request.requestId,
    affectedIssueIds: [...affected],
    integratedIssueIds: [...affected].filter(
      (id) => run.issueAttempts?.[id]?.status === "integrated",
    ),
    previousPrd: oldPrd,
    previousGraph: oldGraph,
    previousApproval: oldApproval,
  };
  if (state.protocol === "native-interview-v1") {
    if (!explanation)
      throw new Error("Revised explanation required for scope approval");
    state.revisionProposal = explanation;
    state.phase = "execution_approval";
    delete state.executionEligibility;
    delete state.pending;
    state.transcript.push({
      source: "user",
      text: response.text,
      messageId: response.messageId,
      requestId: response.requestId,
      revision: response.revision,
    });
    for (;;) {
      const latest = await store.getRun(run.runId);
      if (
        !latest?.planning ||
        latest.planning.phase !== "execution_approved" ||
        latest.planning.graph?.hash !== oldGraph.hash ||
        (latest.control && latest.control.status !== "active")
      )
        throw new Error("Stale scope proposal");
      const next = structuredClone(latest.planning);
      next.scopeChange = state.scopeChange;
      next.revisionProposal = explanation;
      next.phase = "execution_approval";
      next.transcript = state.transcript;
      delete next.executionEligibility;
      delete next.pending;
      if (await store.recordPlanning(run.runId, latest.revision, next)) break;
    }
    for (;;) {
      const latest = await store.getRun(run.runId);
      const current = latest?.issueAttempts?.[attempt.issueId];
      if (
        !latest ||
        !current?.question ||
        current.question.request.requestId !== response.requestId ||
        (latest.control && latest.control.status !== "active")
      )
        throw new Error("Stale scope question");
      current.question.answer = response;
      if (await store.recordIssueAttempt(run.runId, latest.revision, current))
        break;
    }
    return;
  }
}

/** Keep baseline/code evidence; approval explicitly authorizes the changed artifacts. */
export async function prepareApprovedScope(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  let run = await store.getRun(runId);
  const state = run?.planning;
  if (
    !run ||
    !state?.scopeChange ||
    state.scopeChange.prepared ||
    state.phase !== "execution_approved" ||
    !executionEligibilityMatchesRevision(state) ||
    !state.executionEligibility
  )
    return run;
  const change = state.scopeChange;
  const approval = state.executionEligibility;
  // Settle sessions from the superseded artifacts before dispatching continuations.
  for (const job of Object.values(run.jobs).filter(
    (j) => j.status !== "terminal",
  )) {
    const cancelled = await adapter.cancelJob(job.envelope);
    if (!cancelled.ok)
      throw new Error("Superseded executor cancellation was not confirmed");
  }
  for (;;) {
    run = await store.getRun(runId);
    if (
      !run ||
      (run.control && run.control.status !== "active") ||
      run.planning?.executionEligibility?.requestId !== approval.requestId
    )
      throw new Error("Scope approval changed");
    if (!run.planning || !executionEligibilityMatchesRevision(run.planning))
      throw new Error("Scope approval changed");
    if (
      !run.baseline ||
      run.baseline.commandHash !== state.commandHash ||
      run.baseline.candidateCommit !==
        state.executionEligibility?.selectedCommit
    )
      throw new Error("Scope baseline changed");
    if (
      await store.recordBaseline(
        runId,
        run.revision,
        {
          ...run.baseline,
          approvalRequestId: approval.requestId,
        },
        run.validationSkips ?? [],
      )
    )
      break;
  }
  const reissued: { issueId: string; requestId: string }[] = [];
  for (const id of Object.keys(run.issueAttempts ?? {})) {
    for (;;) {
      const latest = await store.getRun(runId);
      const attempt = latest?.issueAttempts?.[id];
      if (
        !latest ||
        !attempt ||
        (latest.control && latest.control.status !== "active") ||
        latest.planning?.executionEligibility?.requestId !== approval.requestId
      )
        throw new Error("Scope approval changed");
      if (id === change.issueId && attempt.question?.answer)
        attempt.status = "resume_ready";
      else if (
        attempt.status === "waiting" &&
        attempt.question &&
        !attempt.question.answer
      ) {
        const old = attempt.question;
        attempt.questions = [...(attempt.questions ?? []), old];
        attempt.question = createExecutorQuestion(latest, attempt, old);
        reissued.push({
          issueId: id,
          requestId: attempt.question.request.requestId,
        });
      } else if (
        ["executing", "submitted", "merging"].includes(attempt.status)
      ) {
        attempt.status = "failed";
        attempt.error = {
          code: "cancelled",
          message:
            "Approved scope revision requires execution against current artifacts; previous evidence retained",
        };
      } else break;
      if (await store.recordIssueAttempt(runId, latest.revision, attempt))
        break;
    }
  }
  for (;;) {
    run = await store.getRun(runId);
    if (
      !run ||
      (run.control && run.control.status !== "active") ||
      run.planning?.executionEligibility?.requestId !== approval.requestId
    )
      throw new Error("Scope approval changed");
    const planning = structuredClone(run.planning);
    if (
      !planning?.scopeChange ||
      !executionEligibilityMatchesRevision(planning)
    )
      throw new Error("Scope approval changed");
    planning.scopeChange.prepared = true;
    if (await store.recordPlanning(runId, run.revision, planning)) {
      for (const q of reissued)
        handleExecutorQuestion(store, adapter, runId, q.issueId, q.requestId);
      return store.getRun(runId);
    }
  }
}
