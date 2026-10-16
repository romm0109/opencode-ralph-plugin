import { runIssue } from "../core/orchestrator.js";
import type { RunRecord } from "../core/types.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { reviewIntegratedExecution } from "../review/after-execution.js";
import type { RunStore } from "../state/run-store.js";
import type { AttemptOptions } from "./attempts.js";
import { integrationQueue } from "./integration-queue.js";
import { reconcileReadiness } from "./readiness.js";

export { reconcileReadiness } from "./readiness.js";

const active = new Map<string, Promise<RunRecord | undefined>>();
export function scheduleReadyIssues(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  options: AttemptOptions = {},
) {
  const key = `${store.repositoryId}:${runId}`;
  const existing = active.get(key);
  if (existing) return existing;
  const promise = schedule(store, adapter, runId, options).finally(() => {
    active.delete(key);
  });
  active.set(key, promise);
  return promise;
}
async function schedule(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  options: AttemptOptions,
) {
  const initial = await store.getRun(runId);
  if (initial?.planning && initial.planning.protocol !== "native-interview-v1")
    throw new Error("Unsupported saved workflow; a fresh workflow is required");
  if (
    initial?.review &&
    !initial.review.superseded &&
    initial.execution?.issues.every((i) => i.status === "integrated")
  )
    return reviewIntegratedExecution(store, adapter, runId);
  const concurrency = initial?.planning?.settings.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency <= 0)
    throw new Error("Executor concurrency must be a positive integer");
  if (
    !initial?.baseline ||
    !["passed", "passed_with_omissions"].includes(initial.baseline.status) ||
    initial.planning?.phase !== "execution_approved"
  )
    throw new Error("Validated baseline and approved graph required");
  const epoch = initial.control?.epoch ?? 0;
  const queue = integrationQueue(store, runId);
  const workers = new Map<string, Promise<void>>();
  let fatal: unknown;
  let projection: Promise<unknown> = Promise.resolve();
  const publish = () => {
    const update = projection.then(async () => {
      for (;;) {
        const run = await store.getRun(runId);
        if (
          !run ||
          run.planning?.phase !== "execution_approved" ||
          (run.control && run.control.status !== "active") ||
          (run.control?.epoch ?? 0) !== epoch ||
          run.planning?.graph?.hash !== initial.planning?.graph?.hash
        )
          return;
        const evidence = reconcileReadiness(run, queue.positions);
        // Passing execution checks cannot attest the still-pending review phases.
        if (evidence.issues.every((issue) => issue.status === "integrated")) {
          evidence.verification = "incomplete";
          evidence.reviewPending = true;
        }
        if (JSON.stringify(run.execution) === JSON.stringify(evidence)) return;
        if (await store.recordExecution(runId, run.revision, evidence)) return;
      }
    });
    projection = update.catch(() => {});
    return update;
  };
  queue.listeners.add(publish);
  try {
    for (;;) {
      await publish();
      const run = await store.getRun(runId);
      if (
        !run ||
        run.planning?.phase !== "execution_approved" ||
        (run.control && run.control.status !== "active") ||
        (run.control?.epoch ?? 0) !== epoch ||
        run.planning?.graph?.hash !== initial.planning?.graph?.hash
      )
        break;
      const ready = reconcileReadiness(run, queue.positions).issues.filter(
        (i) =>
          i.status === "ready" ||
          (i.status === "integration_queued" &&
            run.issueAttempts?.[i.id]?.status === "submitted" &&
            !workers.has(i.id)),
      );
      for (const issue of ready) {
        if (workers.has(issue.id)) continue;
        const worker = runIssue(store, adapter, runId, issue.id, options)
          .then(() => {})
          .catch((cause: unknown) => {
            fatal ??= cause;
          })
          .finally(async () => {
            workers.delete(issue.id);
            await publish();
          });
        workers.set(issue.id, worker);
      }
      if (fatal || !workers.size) break;
      await Promise.race(workers.values());
    }
    await Promise.all(workers.values());
    await publish();
    const latest = await store.getRun(runId);
    if (
      fatal &&
      latest?.planning?.graph?.hash === initial.planning?.graph?.hash &&
      latest?.planning?.phase === "execution_approved" &&
      (!latest?.control || latest.control.status === "active")
    )
      throw fatal;
    return reviewIntegratedExecution(store, adapter, runId);
  } finally {
    queue.listeners.delete(publish);
  }
}
