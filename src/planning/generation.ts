import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { handleControlCommand } from "../commands/control.js";
import type { JobEnvelope } from "../core/types.js";
import { type Clock, systemClock } from "../execution/attempts.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { issueBundleHash } from "./artifacts.js";
import type { PlanningState } from "./types.js";

export async function savePlanning(
  store: RunStore,
  runId: string,
  revision: number,
  state: PlanningState,
) {
  if (!(await store.recordPlanning(runId, revision, state))) {
    const current = await store.getRun(runId);
    if (current?.control && current.control.status !== "active")
      throw new Error(
        `Planning write rejected: control is ${current.control.status}; reconcile or explicitly resume first`,
      );
    throw new Error("Stale planning transition: revision conflict");
  }
}
export async function featureRoot(state: PlanningState, runId: string) {
  if (!/^feature-[A-Za-z0-9-]+$/.test(runId))
    throw new Error("Invalid feature ID");
  let path = state.workspace;
  for (const part of [".ralph", "features", runId]) {
    path = join(path, part);
    await mkdir(path, { recursive: true });
    if (
      !(await lstat(path)).isDirectory() ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new Error("Feature path must be a real directory");
  }
  return path;
}
/** Rename a complete revision directory; never expose a partial bundle. */
export async function publishRevision(
  store: RunStore,
  expectedRevision: number,
  state: PlanningState,
  runId: string,
  name: string,
  files: Record<string, string>,
  publicationId?: string,
) {
  if (!/^(prd|graph)-[1-9][0-9]*$/.test(name))
    throw new Error("Invalid revision directory");
  const jobId = publicationId;
  if (!jobId) throw new Error("Artifact publication requires a generation job");
  state.publication = {
    jobId,
    name,
    hash: issueBundleHash({ name }, files),
    status: "intent",
  };
  await savePlanning(store, runId, expectedRevision, state);
  const persisted = await store.getRun(runId);
  if (
    !persisted?.planning ||
    persisted.planning.publication?.jobId !== jobId ||
    persisted.planning.publication?.name !== name ||
    (persisted.control && persisted.control.status !== "active")
  )
    throw new Error("Stale artifact publication");
  const root = await featureRoot(state, runId);
  if (publicationId) {
    try {
      const target = join(root, name);
      if ((await lstat(target)).isSymbolicLink())
        throw new Error("Accepted revision symlink denied");
      for (const [path, text] of Object.entries(files)) {
        const file = join(target, path);
        if (
          (await lstat(file)).isSymbolicLink() ||
          (await readFile(file, "utf8")) !== text
        )
          throw new Error("Accepted revision bytes changed");
      }
      state.publication.status = "completed";
      return {
        directory: `.ralph/features/${runId}/${name}`,
        revision: persisted.revision,
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  const staged = join(root, `.draft-${randomUUID()}`);
  await mkdir(staged);
  try {
    for (const [path, text] of Object.entries(files)) {
      if (!/^(PRD\.md|graph\.json|issues\/[A-Za-z0-9_-]+\.md)$/.test(path))
        throw new Error("Invalid artifact reference");
      if (path.startsWith("issues/"))
        await mkdir(join(staged, "issues"), { recursive: true });
      await writeFile(join(staged, path), text, { flag: "wx" });
    }
    await rename(staged, join(root, name));
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  state.publication.status = "completed";
  return {
    directory: `.ralph/features/${runId}/${name}`,
    revision: persisted.revision,
  };
}
/** Durable authoring authority is allocated before the inbox prompt is delivered. */
export async function registerPlanningAttempt(
  store: RunStore,
  runId: string,
  messageId: string,
  prompt: string,
  now = Date.now(),
) {
  const run = await store.getRun(runId);
  const state = run?.planning;
  const owner = state?.owner;
  if (!run || !state || !owner || owner.retired || owner.stage === "interview")
    throw new Error("No live planning owner");
  const existing = state.attempts?.find(
    (a) =>
      a.stage === owner.stage &&
      a.attempt === owner.attempt &&
      a.messageId === messageId,
  );
  if (existing) {
    if (
      !run.jobs[existing.job.jobId] &&
      !(await store.recordIntent(existing.job))
    )
      throw new Error("Planning dispatch authority changed");
    return;
  }
  const job: JobEnvelope = {
    runId,
    jobId: `planning-${owner.stage}-${randomUUID()}`,
    attempt: owner.attempt,
    role: owner.stage,
    sessionId: owner.sessionId,
    workspace: state.workspace,
    baseCommit: state.approval?.sha ?? "",
    readOnly: true,
    inputRevisions: {
      explanation: state.explanation?.revision ?? 0,
      prd: state.prd?.revision ?? 0,
    },
    model: requiredPlanningModel(state, owner.stage),
    prompt,
  };
  state.attempts = [
    ...(state.attempts ?? []),
    {
      stage: owner.stage,
      attempt: owner.attempt,
      sessionId: owner.sessionId,
      job,
      prompt,
      messageId,
      draftRoot: `.ralph/features/${runId}/${owner.stage}-draft-${owner.attempt}`,
      remainingMs: state.settings.agentTimeoutMs ?? state.settings.timeoutMs,
      controlEpoch: run.control?.epoch ?? 0,
      observedAt: now,
      status: "active",
    },
  ];
  await savePlanning(store, runId, run.revision, state);
  if (!(await store.recordIntent(job)))
    throw new Error("Planning dispatch authority changed");
}

const supervising = new Set<string>();
/** One observation per tick; question/control waits do not spend active time. */
export async function supervisePlanning(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  now = Date.now(),
) {
  const key = `${store.root}:${runId}`;
  if (supervising.has(key)) return;
  supervising.add(key);
  try {
    let run = await store.getRun(runId);
    let state = run?.planning;
    let owner = state?.owner;
    if (
      !run ||
      !state ||
      state.protocol !== "native-interview-v1" ||
      !owner ||
      owner.stage === "interview"
    )
      return;
    const controlEpoch = run.control?.epoch ?? 0;
    const stage = owner.stage;
    if (
      (stage === "prd" && state.prdAcceptance) ||
      (stage === "issues" && state.issueAcceptance)
    )
      return;
    const ownerAttempt = owner.attempt;
    let attempt = state.attempts?.find(
      (a) =>
        a.stage === stage &&
        a.attempt === ownerAttempt &&
        a.messageId ===
          (stage === "prd"
            ? state?.prdDelivery?.id
            : state?.issueHandoff?.messageId),
    );
    if (!attempt) return;
    // Paused records cannot be written. Discard the interval crossing a pause.
    if (run.control?.status === "paused") return;
    if (run.control && run.control.status !== "active") return;
    if (!owner.retired) {
      const suspended =
        !!state.pending ||
        !!state.revisionProposal ||
        !!state.nativeQuestions?.length ||
        state.phase !==
          (stage === "prd" ? "prd_generation" : "issue_generation");
      const elapsed =
        suspended || attempt.suspended || attempt.observedAt === undefined
          ? 0
          : Math.max(0, now - attempt.observedAt);
      attempt.remainingMs = Math.max(0, attempt.remainingMs - elapsed);
      attempt.observedAt = now;
      attempt.suspended = suspended;
      if (suspended) return;
      const turn = await adapter.inspectPlanningTurn?.(
        owner.sessionId,
        attempt.messageId,
      );
      const reason =
        attempt.remainingMs <= 0
          ? {
              code: "agent-timeout" as const,
              message: `${stage} active authoring deadline exceeded`,
            }
          : typeof turn === "object"
            ? turn.error
            : turn === "failed" || turn === "settled"
              ? {
                  code:
                    turn === "failed"
                      ? ("sdk-error" as const)
                      : ("missing-output" as const),
                  message: `${stage} turn ended without accepted completion`,
                }
              : undefined;
      if (!reason) {
        // The persisted budget plus active-since timestamp already describes a
        // running deadline. Avoid revision churn racing ordinary artifact tools.
        return;
      }
      owner.retired = true;
      attempt.status = "retired";
      attempt.reason = reason;
      state.error = reason;
      // CAS retirement precedes interruption. A winning completion invalidates this write.
      if (!(await store.recordPlanning(runId, run.revision, state))) return;
    }
    // Never abort a downstream owner, including when acceptance won the race.
    run = await store.getRun(runId);
    state = run?.planning;
    owner = state?.owner;
    if (
      !run ||
      (run.control?.epoch ?? 0) !== controlEpoch ||
      !state ||
      !owner?.retired ||
      owner.stage !== stage ||
      owner.attempt !== attempt.attempt ||
      (run.control && run.control.status !== "active")
    )
      return;
    const cancelled = await adapter.cancelJob(attempt.job);
    const session = await adapter.inspectSession?.(attempt.job);
    if (
      !cancelled.ok ||
      !["idle", "missing"].includes(session ?? "unknown") ||
      (stage === "prd" && session === "missing")
    ) {
      const latest = await store.getRun(runId);
      if (latest?.planning)
        await store.recordPlanning(runId, latest.revision, {
          ...latest.planning,
          error: {
            code: "cancelled",
            message:
              "Planning owner settlement is unconfirmed; reconcile the retained session before retrying",
          },
        });
      return;
    }
    run = await store.getRun(runId);
    state = run?.planning;
    if (
      !run ||
      (run.control?.epoch ?? 0) !== controlEpoch ||
      !state?.owner?.retired ||
      state.owner.attempt !== attempt.attempt ||
      (run.control && run.control.status !== "active")
    )
      return;
    const reset =
      state.budgetResets
        ?.filter(
          (r) =>
            r.stage === stage &&
            r.explanationRevision === state?.explanation?.revision,
        )
        .at(-1)?.afterAttempt ?? 0;
    const used =
      state.attempts?.filter(
        (a) =>
          a.stage === stage &&
          a.job.inputRevisions.explanation === state?.explanation?.revision &&
          a.attempt > reset,
      ).length ?? 0;
    if (used >= 3) {
      if (!state.pending) {
        state.pending = {
          kind: "planning-recovery",
          runId,
          workspace: state.workspace,
          sessionId: owner.sessionId,
          requestId: randomUUID(),
          revision: owner.attempt,
          question: `${stage} exhausted three authoring attempts. ${state.error?.message ?? attempt.reason?.message}. Partial drafts are retained. Reset the budget and retry, or stop?`,
          options: [
            {
              label: "Reset budget and retry",
              description: "Authorize three new authoring attempts",
            },
            { label: "Stop", description: "Retain drafts and stop the run" },
          ],
        };
        if (!(await store.recordPlanning(runId, run.revision, state))) return;
        await adapter.publishStatus(
          owner.sessionId,
          state.workspace,
          state.pending.question,
        );
      }
      const request = state.pending;
      if (request.kind !== "planning-recovery") return;
      const beforeQuestion = await store.getRun(runId);
      if (
        !beforeQuestion ||
        (beforeQuestion.control?.epoch ?? 0) !== controlEpoch ||
        (beforeQuestion.control &&
          beforeQuestion.control.status !== "active") ||
        beforeQuestion.planning?.pending?.requestId !== request.requestId ||
        !beforeQuestion.planning.owner?.retired ||
        beforeQuestion.planning.owner.attempt !== attempt.attempt
      )
        return;
      const answer = await adapter.requestUserInput(request);
      run = await store.getRun(runId);
      state = run?.planning;
      if (
        !run ||
        (run.control?.epoch ?? 0) !== controlEpoch ||
        !state ||
        (run.control && run.control.status !== "active") ||
        state.pending?.requestId !== request.requestId
      )
        return;
      if (!answer.ok) {
        const error = {
          ...answer.error,
          message: `${stage} exhausted three attempts: ${attempt.reason?.message}. Native recovery input unavailable: ${answer.error.message}`,
        };
        if (
          state.error?.message !== error.message ||
          state.error.code !== error.code
        ) {
          state.error = error;
          if (await store.recordPlanning(runId, run.revision, state))
            await adapter.publishStatus(
              request.sessionId,
              state.workspace,
              error.message,
            );
        }
        return;
      }
      if (
        answer.source !== "user" ||
        !answer.messageId ||
        answer.sessionId !== request.sessionId ||
        answer.requestId !== request.requestId ||
        answer.revision !== request.revision ||
        state.budgetResets?.some((r) => r.answer.messageId === answer.messageId)
      )
        return;
      if (answer.text === "Stop") {
        await handleControlCommand("ralph-stop", runId, store, adapter, {
          source: "human",
          expectedRevision: run.revision,
        });
        return;
      }
      if (answer.text !== "Reset budget and retry") return;
      state.budgetResets = [
        ...(state.budgetResets ?? []),
        {
          stage,
          afterAttempt: owner.attempt,
          explanationRevision: state.explanation?.revision ?? 0,
          answer,
        },
      ];
      delete state.pending;
      if (!(await store.recordPlanning(runId, run.revision, state))) return;
    }
    run = await store.getRun(runId);
    state = run?.planning;
    if (
      !run ||
      (run.control?.epoch ?? 0) !== controlEpoch ||
      !state?.owner?.retired ||
      (run.control && run.control.status !== "active")
    )
      return;
    // A native recovery question can wait indefinitely. Its earlier idle receipt
    // cannot authorize dispatch after the user answers into a now-busy session.
    const settled = await adapter.inspectSession?.(attempt.job);
    if (
      !["idle", "missing"].includes(settled ?? "unknown") ||
      (stage === "prd" && settled === "missing")
    ) {
      state.error = {
        code: "cancelled",
        message:
          "Planning owner is not settled after recovery; retry waits for session reconciliation",
      };
      await store.recordPlanning(runId, run.revision, state);
      return;
    }
    const afterInspection = await store.getRun(runId);
    if (
      !afterInspection ||
      afterInspection.revision !== run.revision ||
      (afterInspection.control?.epoch ?? 0) !== controlEpoch ||
      (afterInspection.control && afterInspection.control.status !== "active")
    )
      return;
    const number = state.owner.attempt + 1;
    let sessionId = state.owner.sessionId;
    if (stage === "issues") {
      if (!adapter.findIssueSession || !adapter.createIssueSession) return;
      const jobId = `retry-${attempt.job.jobId}-${number}`;
      sessionId =
        (await adapter.findIssueSession(
          state.workspace,
          runId,
          jobId,
          number,
        )) ??
        (await adapter.createIssueSession(
          state.workspace,
          runId,
          jobId,
          number,
          requiredPlanningModel(state, stage),
        ));
    }
    // Re-read after external work: stop/pause/completion cannot authorize this retry.
    const latest = await store.getRun(runId);
    if (
      !latest ||
      latest.revision !== run.revision ||
      (latest.control?.epoch ?? 0) !== controlEpoch
    )
      return;
    state.owner = { stage, attempt: number, sessionId };
    state.sessionId = sessionId;
    delete state.error;
    const messageId = `msg_ralph-${stage}-retry-${randomUUID()}`;
    const prompt = `${attempt.prompt}\nRETRY AUTHORITATIVE IDENTITY: runId=${runId}, attempt=${number}. All tools MUST use attempt ${number}. Draft directory: .ralph/features/${runId}/${stage}-draft-${number}. Previous partial drafts (read only): ${JSON.stringify(state.attempts?.filter((a) => a.stage === stage).map((a) => a.draftRoot))}. Failure: ${attempt.reason?.message}. Approved explanation: ${JSON.stringify(state.explanation)}. Accepted PRD: ${JSON.stringify(state.prd)}. Product decisions: ${JSON.stringify(state.decisions ?? [])}. Final prose does not complete this stage; call ralph_complete_${stage}.`;
    if (stage === "prd")
      state.prdDelivery = { id: messageId, text: prompt, status: "intent" };
    else if (state.issueHandoff)
      state.issueHandoff = {
        ...state.issueHandoff,
        sessionId,
        attempt: number,
        messageId,
        prompt,
        queued: false,
        focused: false,
      };
    // Append the new record in the same guarded ownership transition.
    const { reason: _reason, ...previous } = attempt;
    state.attempts = [
      ...(state.attempts ?? []),
      {
        ...previous,
        attempt: number,
        sessionId,
        job: {
          ...attempt.job,
          jobId: `planning-${stage}-${randomUUID()}`,
          sessionId,
          attempt: number,
          prompt,
        },
        messageId,
        prompt,
        draftRoot: `.ralph/features/${runId}/${stage}-draft-${number}`,
        remainingMs: state.settings.agentTimeoutMs ?? state.settings.timeoutMs,
        controlEpoch: run.control?.epoch ?? 0,
        observedAt: now,
        suspended: false,
        status: "active",
      },
    ];
    if (!(await store.recordPlanning(runId, run.revision, state))) return;
    attempt = state.attempts?.at(-1);
    if (!attempt) throw new Error("Missing persisted planning attempt");
    if (!(await store.recordIntent(attempt.job))) return;
    const beforeQueue = await store.getRun(runId);
    if (
      !beforeQueue ||
      (beforeQueue.control && beforeQueue.control.status !== "active") ||
      beforeQueue.planning?.owner?.attempt !== number
    )
      return;
    await queuePlanningPrompt(
      store,
      adapter,
      runId,
      sessionId,
      messageId,
      prompt,
    );
    if (stage === "issues")
      await adapter.focusStageSession?.(
        state.workspace,
        runId,
        sessionId,
        "issues",
      );
  } finally {
    supervising.delete(key);
  }
}
function requiredPlanningModel(state: PlanningState, stage: "prd" | "issues") {
  const model = state.settings.models[stage] ?? state.settings.models.interview;
  if (!model) throw new Error("Missing planning model");
  return model;
}

/** Native question tools can also be invoked directly by the stage agent. */
export async function setPlanningQuestionWaiting(
  store: RunStore,
  runId: string,
  sessionId: string,
  id: string,
  waiting: boolean,
) {
  let run = await store.getRun(runId);
  const epoch = run?.control?.epoch ?? 0;
  while (run?.control?.status === "paused") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    run = await store.getRun(runId);
  }
  const state = run?.planning;
  if ((run?.control?.epoch ?? 0) !== epoch) return;
  if (
    !run ||
    !state ||
    state.owner?.sessionId !== sessionId ||
    state.owner.retired ||
    (run.control && run.control.status !== "active")
  )
    return;
  state.nativeQuestions = waiting
    ? [...new Set([...(state.nativeQuestions ?? []), id])]
    : (state.nativeQuestions ?? []).filter((value) => value !== id);
  for (const attempt of state.attempts ?? [])
    if (attempt.status === "active") {
      attempt.suspended = true;
      delete attempt.observedAt;
    }
  await savePlanning(store, runId, run.revision, state);
}

/** Injectable scheduling and time keep native waits independent of authoring time. */
export function startPlanningSupervision(
  store: RunStore,
  adapter: OpenCodeAdapter,
  options: { clock?: Clock; onError?: (cause: unknown) => void } = {},
) {
  const clock = options.clock ?? systemClock;
  let disposed = false;
  let cancel = () => {};
  const report =
    options.onError ??
    ((cause) => console.error("Ralph planning supervision failed", cause));
  async function tick() {
    try {
      for (const run of await store.listRuns()) {
        if (disposed) return;
        void supervisePlanning(
          store,
          adapter,
          run.runId,
          clock.now?.() ?? Date.now(),
        ).catch(report);
      }
    } catch (cause) {
      if (!disposed) report(cause);
    } finally {
      if (!disposed)
        cancel = clock.schedule(250, () => {
          void tick();
        });
    }
  }
  cancel = clock.schedule(250, () => {
    void tick();
  });
  return () => {
    disposed = true;
    cancel();
  };
}

/** Check authority on both sides of inbox delivery, which may outlive stop cleanup. */
export async function queuePlanningPrompt(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  sessionId: string,
  messageId: string,
  prompt: string,
) {
  const run = await store.getRun(runId);
  const attempt = run?.planning?.attempts?.find(
    (a) => a.messageId === messageId && a.sessionId === sessionId,
  );
  if (
    !run ||
    !attempt ||
    attempt.status !== "active" ||
    run.planning?.owner?.retired ||
    (run.control && run.control.status !== "active") ||
    attempt.controlEpoch !== (run.control?.epoch ?? 0)
  )
    throw new Error("Stale planning prompt authority");
  if (!adapter.queueStagePrompt)
    throw new Error("Native stage queue is unavailable");
  await adapter.queueStagePrompt(sessionId, messageId, prompt);
  const latest = await store.getRun(runId);
  const current = latest?.planning?.attempts?.find(
    (a) => a.job.jobId === attempt.job.jobId,
  );
  if (current?.status === "accepted") return;
  if (
    !latest ||
    current?.status !== "active" ||
    (latest.control?.epoch ?? 0) !== attempt.controlEpoch ||
    (latest.control && !["active", "paused"].includes(latest.control.status))
  ) {
    const cancelled = await adapter.cancelJob(attempt.job);
    if (!cancelled.ok)
      throw new Error(
        "Late planning delivery cancellation is unconfirmed; reconcile the owned session",
      );
    throw new Error("Planning authority retired during prompt delivery");
  }
}
