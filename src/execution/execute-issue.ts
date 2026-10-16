import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  correlatedResult,
  parseExecutorQuestion,
  parseSubmission,
  type Submission,
} from "../agents/results.js";
import { loadRoleInstructions } from "../agents/skills.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import type {
  Failure,
  JobEnvelope,
  JobResult,
  RunRecord,
} from "../core/types.js";
import {
  createOwnedWorktree,
  gitOutput,
  inspectWorktree,
} from "../git/worktrees.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import { artifactHash, issueBundleHash } from "../planning/artifacts.js";
import { assertNativeExecutionInputs } from "../planning/eligibility.js";
import {
  createApprovedEnvironment,
  disposeEnvironment,
  prepareEnvironment,
} from "../process/environment.js";
import { currentRepair, executionIssue } from "../review/repair-context.js";
import { parseFindingDispute } from "../review/repairs.js";
import type { RunStore } from "../state/run-store.js";
import {
  type AttemptOptions,
  beginAttempt,
  dispatchAttempt,
  failAttempt,
  reconcileAttempt,
  repairContext,
} from "./attempts.js";
import {
  reserveExecutorAdmission,
  withExecutorSlot,
} from "./executor-slots.js";
import type { ValidationSummary } from "./validation.js";

export { parseSubmission };
export interface IssueAttempt {
  issueId: string;
  attempt: number;
  agentTimeoutMs?: number;
  remainingAgentMs?: number;
  status:
    | "executing"
    | "submitted"
    | "merging"
    | "failed"
    | "integrated"
    | "exhausted"
    | "waiting"
    | "resume_ready";
  findingDispute?: { findingIds: string[]; evidenceRefs: string[] };
  question?: import("./questions.js").ExecutorQuestion;
  questions?: import("./questions.js").ExecutorQuestion[];
  history?: Omit<IssueAttempt, "history">[];
  operationId: string;
  job: JobEnvelope;
  submission?: Submission;
  executionResult?: JobResult;
  candidate?: {
    operationId: string;
    job: JobEnvelope;
    ref: string;
    commit?: string;
    result?: JobResult;
  };
  validation?: ValidationSummary;
  integratedCommit?: string;
  mergerSessionId?: string;
  feedback?: string;
  error?: Failure;
  cleanupErrors?: string[];
  environment?: {
    lease?: import("../process/environment.js").EnvironmentLease;
    lifecycle: import("../process/runner.js").CommandResult[];
  };
  reconciledWork?: Awaited<ReturnType<typeof reconcileAttempt>>;
}

/** Approval and control identity remain fixed throughout one attempt. */
export function assertCurrentAttempt(
  initial: RunRecord,
  current: RunRecord | undefined,
  attempt: IssueAttempt,
): asserts current is RunRecord {
  if (
    !current ||
    (current.control &&
      !["active", "paused"].includes(current.control.status)) ||
    (current.control?.epoch ?? 0) !== (initial.control?.epoch ?? 0) ||
    current.planning?.executionEligibility?.requestId !==
      initial.planning?.executionEligibility?.requestId ||
    current.planning?.prd?.hash !== initial.planning?.prd?.hash ||
    current.planning?.graph?.hash !== initial.planning?.graph?.hash ||
    current.planning?.commandHash !== initial.planning?.commandHash ||
    current.baseline?.operationId !== initial.baseline?.operationId ||
    (currentRepair(initial, attempt.issueId) &&
      (current.reviewWorkflow?.ownerId !== initial.reviewWorkflow?.ownerId ||
        current.reviewWorkflow?.rounds.length !==
          initial.reviewWorkflow?.rounds.length ||
        !currentRepair(current, attempt.issueId))) ||
    current.issueAttempts?.[attempt.issueId]?.job.jobId !== attempt.job.jobId ||
    current.issueAttempts?.[attempt.issueId]?.operationId !==
      attempt.operationId
  )
    throw new Error("Stale issue completion");
}
export async function saveIssueAttempt(
  store: RunStore,
  initial: RunRecord,
  attempt: IssueAttempt,
) {
  for (;;) {
    const current = await store.getRun(initial.runId);
    assertCurrentAttempt(initial, current, attempt);
    if (
      await store.recordIssueAttempt(initial.runId, current.revision, attempt)
    )
      return;
  }
}
async function executeAttempt(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  issueId: string,
  options: AttemptOptions = {},
): Promise<IssueAttempt> {
  const initial = await store.getRun(runId);
  const planning = initial?.planning;
  const baseline = initial?.baseline;
  if (
    !initial ||
    planning?.phase !== "execution_approved" ||
    !planning.executionEligibility ||
    !executionEligibilityMatchesRevision(planning) ||
    !planning.prd ||
    !planning.graph ||
    !baseline?.workspace ||
    !baseline.branch ||
    !["passed", "passed_with_omissions"].includes(baseline.status) ||
    baseline.approvalRequestId !== planning.executionEligibility.requestId ||
    baseline.candidateCommit !== planning.executionEligibility.selectedCommit
  )
    throw new Error("An approved graph and validated baseline are required");
  if (initial.control && initial.control.status !== "active")
    throw new Error("Run is inactive");
  await assertNativeExecutionInputs(planning, runId);
  const previous = initial.issueAttempts?.[issueId];
  if (previous && !["failed", "resume_ready"].includes(previous.status))
    return previous;
  const resuming = previous?.status === "resume_ready";
  const number = resuming ? previous.attempt : beginAttempt(previous);
  const context = executionIssue(initial, issueId);
  const issue = context?.issue;
  const repair = currentRepair(initial, issueId);
  const reserved = repair?.attempts.at(-1);
  if (repair && (reserved?.attempt !== number || reserved.status !== "intent"))
    throw new Error(
      "Repair attempt must be reserved by the review coordinator",
    );
  if (
    !issue ||
    issue.dependencies.some(
      (id) => initial.issueAttempts?.[id]?.status !== "integrated",
    )
  )
    throw new Error("Issue is not dependency ready");
  const operationId = resuming ? previous.operationId : `issue-${randomUUID()}`;
  let job: JobEnvelope = {
    runId,
    issueId,
    jobId: operationId,
    role: "executor",
    attempt: number,
    workspace:
      reserved?.workspace ?? join(store.root, "worktrees", operationId),
    baseCommit:
      baseline.candidateCommit ??
      planning.executionEligibility.selectedCommit ??
      "",
    inputRevisions: {
      prd: planning.prd.revision,
      graph: planning.graph.revision,
      commands: baseline.commandRevision,
      skill: 1,
    },
    ...(planning.settings.models.executor
      ? { model: planning.settings.models.executor }
      : {}),
    prompt: "Reserved issue attempt",
  };
  let attempt: IssueAttempt = {
    issueId,
    attempt: number,
    agentTimeoutMs: planning.settings.agentTimeoutMs ?? 1800000,
    status: "executing",
    operationId,
    job,
    history: previous
      ? [
          ...(previous.history ?? []),
          (({ history: _history, ...entry }) => entry)(previous),
        ]
      : [],
  };
  if (resuming) {
    attempt = { ...structuredClone(previous), status: "executing" };
    if (!attempt.question?.answer)
      throw new Error("Missing continuation answer");
    attempt.questions = [...(attempt.questions ?? []), attempt.question];
    job = { ...attempt.job, jobId: `continuation-${randomUUID()}` };
    delete job.sessionId;
    job.inputRevisions = {
      ...job.inputRevisions,
      prd: planning.prd.revision,
      graph: planning.graph.revision,
    };
    job.prompt += `\nClarification context: ${JSON.stringify(attempt.question)}\nCurrent approved PRD: ${JSON.stringify(planning.prd)}\nCurrent approved issue: ${JSON.stringify(issue)}\n${context?.text}`;
    attempt.job = job;
    delete attempt.question;
    delete attempt.executionResult;
  }
  if (!(await store.recordIssueAttempt(runId, initial.revision, attempt)))
    return executeAttempt(store, adapter, runId, issueId, options);
  let environment: ReturnType<typeof createApprovedEnvironment> | undefined;
  try {
    if (previous && !resuming) {
      try {
        attempt.reconciledWork = await reconcileAttempt(
          store,
          adapter,
          previous,
        );
      } catch (cause) {
        attempt.error = { code: "cancelled", message: String(cause) };
        throw cause;
      }
    }
    const config = await loadProjectConfig(planning.workspace);
    if (
      commandConfigHash(config.commands) !== planning.commandHash ||
      baseline.commandHash !== planning.commandHash
    )
      throw new Error("Approved commands changed");
    const prd = await readFile(
      join(planning.workspace, planning.prd.artifactPath),
      "utf8",
    );
    if (
      artifactHash(prd) !== planning.prd.hash ||
      issueBundleHash(planning.graph.value, planning.graph.files) !==
        planning.graph.hash
    )
      throw new Error("Approved artifacts changed");
    const skill = await loadRoleInstructions(
      planning.workspace,
      "executor",
      config.skillPaths,
    );
    const base = await inspectWorktree(baseline.workspace);
    if (
      base.repositoryId !== store.repositoryId ||
      base.branch !== `refs/heads/${baseline.branch}`
    )
      throw new Error("Integration workspace identity changed");
    if (!resuming) {
      if (
        reserved &&
        (reserved.baseCommit !== base.commit ||
          initial.reviewWorkflow?.commit !== base.commit)
      )
        throw new Error("Repair base changed before dispatch");
      job.baseCommit = base.commit;
      job.inputRevisions.commands = config.commands.revision;
      job.prompt = `${skill.text}\nSkill: ${JSON.stringify({ path: skill.path, hash: skill.hash })}\nPRD revision: ${JSON.stringify(planning.prd)}\nPRD:\n${prd}\nIssue: ${JSON.stringify(issue)}\n${context?.text}\nRepair context: ${JSON.stringify({ previous: repairContext(previous), reconciledWork: attempt.reconciledWork })}\nCommands: ${JSON.stringify(config.commands)}\nIdentity: ${JSON.stringify({ issueId, attempt: number, baseCommit: base.commit })}`;
      await saveIssueAttempt(store, initial, attempt);
      await mkdir(dirname(job.workspace), { recursive: true });
      await createOwnedWorktree(store, planning.workspace, {
        operationId,
        kind: "issue.workspace",
        status: "intent",
        job,
        ref: `refs/heads/ralph/issues/${runId}/${operationId}`,
        expectedNew: base.commit,
      });
    }
    environment = createApprovedEnvironment(
      {
        store,
        adapter,
        job,
        config: config.commands,
        sourceWorkspace: planning.workspace,
        permissionSessionId: planning.sessionId,
        ...(options.clock ? { clock: options.clock } : {}),
      },
      { skipChecks: true },
    );
    attempt.environment = { lifecycle: environment.results };
    attempt.environment.lease = await prepareEnvironment(environment, job);
    job.prompt += `\nAllocated environment: ${JSON.stringify(job.environment)}`;
    await saveIssueAttempt(store, initial, attempt);
    if (resuming) job.prompt += `\nCurrent approved PRD content:\n${prd}`;
    const budget =
      attempt.remainingAgentMs ?? attempt.agentTimeoutMs ?? 1800000;
    const started = options.clock?.now?.() ?? Date.now();
    const result = await dispatchAttempt(
      store,
      adapter,
      job,
      Math.max(1, budget),
      options,
    );
    assertCurrentAttempt(initial, await store.getRun(runId), attempt);
    attempt.remainingAgentMs = Math.max(
      0,
      budget - ((options.clock?.now?.() ?? Date.now()) - started),
    );
    attempt.executionResult = result;
    if (!["completed", "needs_input"].includes(result.outcome)) {
      attempt.error = result.error ?? {
        code:
          result.outcome === "denied"
            ? "permission-denied"
            : result.outcome === "cancelled"
              ? "cancelled"
              : "missing-output",
        message: "Executor did not complete",
      };
      throw new Error(attempt.error.message);
    }
    const dispute = repair
      ? parseFindingDispute(correlatedResult(job, result), repair)
      : undefined;
    if (dispute) {
      attempt.findingDispute = dispute;
      attempt.status = "waiting";
      await saveIssueAttempt(store, initial, attempt);
      return attempt;
    }
    const question = parseExecutorQuestion(result, job);
    if (question) {
      const { createExecutorQuestion } = await import("./questions.js");
      attempt.question = createExecutorQuestion(initial, attempt, question);
      attempt.status = "waiting";
      await saveIssueAttempt(store, initial, attempt);
      return attempt;
    }
    const submission = parseSubmission(result, job);
    const found = await inspectWorktree(job.workspace);
    if (
      found.branch !== `refs/heads/ralph/issues/${runId}/${operationId}` ||
      found.repositoryId !== store.repositoryId ||
      found.commit !== submission.submittedCommit ||
      (
        await gitOutput(job.workspace, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])
      ).trim()
    )
      throw new Error(
        "Submission must be committed and clean on the owned issue branch",
      );
    await gitOutput(job.workspace, [
      "merge-base",
      "--is-ancestor",
      job.baseCommit,
      submission.submittedCommit,
    ]);
    const cleanup = await disposeEnvironment(environment, job);
    if (cleanup.status !== "completed")
      throw new Error(cleanup.reason ?? "Executor environment cleanup failed");
    attempt.submission = submission;
    attempt.status = "submitted";
    await saveIssueAttempt(store, initial, attempt);
  } catch (cause) {
    const waiting = environment?.results.find((result) =>
      ["permission_denied", "cancelled"].includes(result.status),
    );
    if (waiting)
      attempt.error ??= {
        code:
          waiting.status === "permission_denied"
            ? "permission-denied"
            : "cancelled",
        message: waiting.cause?.message ?? waiting.status,
        cause: waiting,
      };
    attempt.error ??= {
      code: "setup-failed",
      message: String(cause),
      cause: String(cause),
    };
    if (attempt.status !== "integrated") failAttempt(attempt);
    await saveIssueAttempt(store, initial, attempt).catch(() => {});
  } finally {
    if (environment) {
      const cleanup = await disposeEnvironment(environment, job).catch(
        (cause) => ({ status: "failed" as const, reason: String(cause) }),
      );
      if (cleanup.status !== "completed") {
        attempt.cleanupErrors ??= [];
        attempt.cleanupErrors.push(
          cleanup.reason ?? "Environment cleanup failed",
        );
      }
      await saveIssueAttempt(store, initial, attempt).catch(() => {});
    }
  }
  return attempt;
}

/** Lease only execution/setup/cleanup, never the submission's integration wait. */
export async function executeIssue(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  issueId: string,
  options: AttemptOptions = {},
): Promise<IssueAttempt> {
  const release = await reserveExecutorAdmission(store, runId);
  try {
    const run = await store.getRun(runId);
    const previous = run?.issueAttempts?.[issueId];
    if (previous && !["failed", "resume_ready"].includes(previous.status))
      return executeAttempt(store, adapter, runId, issueId, options);
    // Do not await execution while holding the admission ticket. The pool has
    // already reserved this arrival or queued it in FIFO order synchronously.
    return withExecutorSlot(
      store,
      runId,
      run?.planning?.settings.concurrency ?? 2,
      () => executeAttempt(store, adapter, runId, issueId, options),
    );
  } finally {
    release();
  }
}
