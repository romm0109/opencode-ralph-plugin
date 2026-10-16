import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunStore } from "./run-store.js";

/** Only durable terminal reporting relinquishes the matching repository owner. */
export async function releaseTerminalRun(
  store: RunStore,
  runId: string,
  directory: string,
) {
  const run = await store.getRun(runId);
  if (run?.reviewWorkflow?.status !== "terminal" || !run.reviewWorkflow.report)
    throw new Error("Cannot release a nonterminal review run");
  const lock = join(store.root, "active-run.lock");
  let raw: string;
  try {
    raw = await readFile(join(lock, "owner.json"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  const owner = JSON.parse(raw);
  if (owner.runId !== runId || owner.repositoryId !== store.repositoryId)
    return;
  const operation = {
    operationId: `terminal-release-${run.reviewWorkflow.ownerId}`,
    kind: "run.release" as const,
    status: "intent" as const,
    job: {
      runId,
      jobId: "terminal-release",
      role: "completion",
      attempt: 1,
      workspace: directory,
      inputRevisions: { round: run.reviewWorkflow.rounds.length },
      baseCommit: run.reviewWorkflow.commit,
      prompt: "Release terminal active-run ownership",
    },
  };
  if (!(await store.recordOperation(operation))) return;
  try {
    if ((await readFile(join(lock, "owner.json"), "utf8")) !== raw)
      throw new Error("Active-run ownership changed before release");
    await rm(lock, { recursive: true });
    await store.recordOperation({ ...operation, status: "completed" });
  } catch (cause) {
    await store.recordOperation({
      ...operation,
      status: "failed",
      error: { code: "sdk-error", message: String(cause) },
    });
    throw cause;
  }
}

/** A stopped planning run relinquishes ownership only after verified cleanup. */
export async function releaseStoppedPlanningRun(
  store: RunStore,
  runId: string,
) {
  const run = await store.getRun(runId);
  if (
    !run?.planning ||
    run.planning.protocol !== "native-interview-v1" ||
    run.control?.status !== "stopped" ||
    run.control.cleanupPending ||
    run.control.facts?.length ||
    run.baseline ||
    Object.keys(run.issueAttempts ?? {}).length ||
    Object.values(run.jobs).some((j) => j.status !== "terminal") ||
    Object.values(run.operations).some((op) => op.status === "intent")
  )
    throw new Error(
      "Stopped planning cleanup is unresolved; ownership retained",
    );
  const lock = join(store.root, "active-run.lock");
  const raw = await readFile(join(lock, "owner.json"), "utf8");
  const owner = JSON.parse(raw);
  if (owner.runId !== runId || owner.repositoryId !== store.repositoryId)
    throw new Error("Active-run ownership differs; ownership retained");
  const operation = {
    operationId: `stopped-release-${run.control.epoch}`,
    kind: "run.release" as const,
    status: "intent" as const,
    job: {
      runId,
      jobId: "stopped-release",
      role: "completion",
      attempt: 1,
      workspace: run.planning.workspace,
      baseCommit: run.planning.approval?.sha ?? "",
      inputRevisions: {},
      prompt: "Release verified stopped planning ownership",
    },
  };
  if (!(await store.recordOperation(operation)))
    throw new Error("Stopped release authority changed");
  if ((await readFile(join(lock, "owner.json"), "utf8")) !== raw)
    throw new Error("Active-run ownership changed before release");
  await rm(lock, { recursive: true });
  if (!(await store.recordOperation({ ...operation, status: "completed" })))
    throw new Error("Stopped release result could not be recorded");
}
