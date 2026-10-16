import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { readReviewGit } from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { createReviewSnapshot } from "./snapshot.js";

/** Explicit human review retry consumes a round; it never resets attempts/skips. */
export async function retryUnverifiedReview(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  if (!adapter.finalizeExecution)
    throw new Error("Host final review coordinator is unavailable");
  const run = await store.getRun(runId);
  const workflow = run?.reviewWorkflow;
  const planning = run?.planning;
  if (
    !run ||
    !planning?.prd ||
    !planning.graph ||
    !run.baseline?.workspace ||
    workflow?.status !== "terminal" ||
    workflow.report?.outcome !== "unverified" ||
    workflow.rounds.length >= 3 ||
    workflow.report.cleanupFailures.length ||
    run.control?.status !== "active" ||
    run.control.source !== "human"
  )
    throw new Error(
      "Review-only retry requires an explicitly resumed unverified report, clean cleanup, and a remaining review round",
    );
  if (
    Object.values(run.jobs).some((job) => job.status !== "terminal") ||
    Object.values(run.operations).some(
      (op) =>
        op.status === "intent" ||
        (op.kind === "run.release" && op.status !== "completed"),
    )
  )
    throw new Error("Review cleanup or publication is still pending");
  const config = await loadProjectConfig(planning.workspace);
  if (commandConfigHash(config.commands) !== planning.commandHash)
    throw new Error("Approved commands changed");
  const directory = run.baseline.workspace;
  const head = (await readReviewGit(directory, ["rev-parse", "HEAD"])).trim();
  const branch = (
    await readReviewGit(directory, ["symbolic-ref", "--short", "HEAD"])
  ).trim();
  if (
    head !== workflow.commit ||
    branch !== workflow.branch ||
    (
      await readReviewGit(directory, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    ).trim()
  )
    throw new Error("Reviewed feature branch or checkout changed");
  const lock = join(store.root, "active-run.lock");
  try {
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ runId, repositoryId: store.repositoryId }),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (owner.runId !== runId || owner.repositoryId !== store.repositoryId)
      throw new Error("Another feature owns this repository");
  }
  const number = workflow.rounds.length + 1;
  const snapshot = await createReviewSnapshot({
    store,
    adapter,
    directory,
    runId,
    round: number,
    commit: workflow.commit,
    baseCommit: run.review?.inputs.baseCommit ?? run.baseline.candidateCommit,
    prdRevision: planning.prd.hash,
    graph: {
      revision: planning.graph.hash,
      issues: planning.graph.value.issues,
    },
    evidenceRefs: [
      ...(workflow.rounds.at(-1)?.snapshot.evidenceRefs ?? []),
      `explicit-review-retry:${number}`,
    ],
    approvedPlanning: true,
  });
  const current = await store.getRun(runId);
  if (!current || !(await store.reopenReview(runId, current.revision)))
    throw new Error(
      "Review retry changed before reservation; reconcile and retry explicitly",
    );
  await adapter.finalizeExecution(snapshot);
  return store.getRun(runId);
}
