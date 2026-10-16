import type { JobEnvelope, JobResult } from "../core/types.js";
import { gitOutput, inspectWorktree } from "../git/worktrees.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { terminateOwnedProcess } from "../process/ownership.js";
import type { RunStore } from "../state/run-store.js";
import type { IssueAttempt } from "./execute-issue.js";

export interface AttemptPolicy {
  maxAttempts: 3;
}
export const attemptPolicy: Readonly<AttemptPolicy> = Object.freeze({
  maxAttempts: 3,
});
export function beginAttempt(previous?: IssueAttempt): number {
  const number = (previous?.attempt ?? 0) + 1;
  if (number > attemptPolicy.maxAttempts)
    throw new Error("Issue attempt budget exhausted");
  return number;
}
export function exhaustIssue(attempt: IssueAttempt) {
  attempt.status = "exhausted";
}
export function failAttempt(attempt: IssueAttempt) {
  if (["permission-denied", "cancelled"].includes(attempt.error?.code ?? "")) {
    attempt.status = "waiting";
    return;
  }
  if (attempt.attempt >= attemptPolicy.maxAttempts) exhaustIssue(attempt);
  else attempt.status = "failed";
}
export function repairContext(previous?: IssueAttempt) {
  if (!previous) return undefined;
  const { history: _history, ...evidence } = previous;
  return evidence;
}

export interface Clock {
  now?(): number;
  schedule(ms: number, callback: () => void): () => void;
}
export const systemClock: Clock = {
  schedule(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
export interface AttemptOptions {
  clock?: Clock;
}
/** Cancellation is acknowledged before the caller can allocate a repair. */
export async function dispatchAttempt(
  store: RunStore,
  adapter: OpenCodeAdapter,
  job: JobEnvelope,
  timeoutMs: number,
  options: AttemptOptions,
): Promise<JobResult> {
  const clock = options.clock ?? systemClock;
  const timeout = Symbol("deadline");
  let dispose = () => {};
  const deadline = new Promise<typeof timeout>((resolve) => {
    dispose = clock.schedule(timeoutMs, () => resolve(timeout));
  });
  try {
    const result = await Promise.race([adapter.dispatchJob(job), deadline]);
    if (result !== timeout) return result;
    const entry = (await store.getRun(job.runId))?.jobs[job.jobId];
    const cancelled = entry
      ? await adapter.cancelJob(entry.envelope)
      : { ok: false };
    return {
      ...(entry?.envelope ?? job),
      outcome: "failed",
      evidence: [`${job.role} deadline ${timeoutMs}ms exceeded`],
      error: {
        code: cancelled.ok ? "agent-timeout" : "cancelled",
        message: cancelled.ok
          ? `${job.role} deadline exceeded (${timeoutMs}ms); owned job cancelled`
          : "Agent deadline exceeded; cancellation was not confirmed. Intervention required",
      },
    };
  } catch (cause) {
    const entry = (await store.getRun(job.runId))?.jobs[job.jobId];
    if (entry && entry.status !== "terminal") {
      const cancelled = await adapter.cancelJob(entry.envelope);
      if (!cancelled.ok)
        return {
          ...entry.envelope,
          outcome: "cancelled",
          evidence: [],
          error: {
            code: "cancelled",
            message:
              "Dispatch failed and owned agent cancellation was not confirmed",
            cause: String(cause),
          },
        };
    }
    throw cause;
  } finally {
    dispose();
  }
}

/** Retain failed work; verify its ownership and describe current saved facts. */
export async function reconcileAttempt(
  store: RunStore,
  adapter: OpenCodeAdapter,
  previous: IssueAttempt,
) {
  const run = await store.getRun(previous.job.runId);
  if (!run) throw new Error("Missing retry run");
  for (const entry of Object.values(run.jobs).filter(
    (entry) =>
      entry.envelope.issueId === previous.issueId &&
      entry.envelope.attempt === previous.attempt &&
      entry.status !== "terminal",
  )) {
    const cancelled = await adapter.cancelJob(entry.envelope);
    if (!cancelled.ok)
      throw new Error("Owned agent cancellation was not confirmed");
  }
  const work: {
    workspace: string;
    commit: string;
    branch: string;
    changes: string;
  }[] = [];
  for (const operation of Object.values(run.operations).filter(
    (op) =>
      op.job.issueId === previous.issueId &&
      op.job.attempt === previous.attempt,
  )) {
    if (
      operation.ownedProcess &&
      !(await terminateOwnedProcess(operation.ownedProcess))
    )
      throw new Error("Owned command cleanup was not confirmed");
    if (
      !["issue.workspace", "candidate.workspace"].includes(operation.kind) ||
      operation.status !== "completed"
    )
      continue;
    if (
      run.operations[`${operation.operationId}-cleanup`]?.status === "completed"
    )
      continue;
    const found = await inspectWorktree(operation.job.workspace);
    if (
      found.repositoryId !== store.repositoryId ||
      found.branch !== operation.ref
    )
      throw new Error("Retained retry workspace identity changed");
    work.push({
      workspace: found.workspace,
      commit: found.commit,
      branch: found.branch,
      changes: await gitOutput(found.workspace, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]),
    });
  }
  return work;
}
