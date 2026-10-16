import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunControl } from "../core/types.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { disposeRunEnvironments } from "../process/environment.js";
import { terminateOwnedProcess } from "../process/ownership.js";
import type { RunStore } from "../state/run-store.js";

export async function assertDispatchAllowed(store: RunStore, runId: string) {
  const run = await store.getRun(runId);
  if (run?.planning && run.planning.protocol !== "native-interview-v1")
    throw new Error("Unsupported saved workflow; a fresh workflow is required");
  if (run?.control && run.control.status !== "active")
    throw new Error(
      `Run ${runId} is ${run.control.status}; explicit resume required`,
    );
}
/** In-flight work settles; the next scheduling boundary waits for human resume. */
export async function waitForDispatch(store: RunStore, runId: string) {
  while ((await store.getRun(runId))?.control?.status === "paused")
    await new Promise((resolve) => setTimeout(resolve, 20));
  await assertDispatchAllowed(store, runId);
}
export async function handleControlCommand(
  command: "ralph-pause" | "ralph-resume" | "ralph-stop",
  runId: string,
  store: RunStore,
  adapter?: OpenCodeAdapter,
  options: {
    source?: RunControl["source"];
    cleanup?: () => Promise<void>;
    timeoutMs?: number;
    expectedRevision?: number;
  } = {},
) {
  const run = await store.getRun(runId);
  if (!run) throw new Error("Unknown run");
  if (
    command === "ralph-resume" &&
    run.planning &&
    run.planning.protocol !== "native-interview-v1"
  )
    throw new Error("Unsupported saved workflow; a fresh workflow is required");
  if (
    options.expectedRevision !== undefined &&
    run.revision !== options.expectedRevision
  )
    throw new Error(
      "Control authority changed; inspect the current run before retrying",
    );
  const reviewRetry =
    run.reviewWorkflow?.status === "terminal" &&
    run.reviewWorkflow.report?.outcome === "unverified" &&
    run.reviewWorkflow.rounds.length < 3;
  if (
    command === "ralph-resume" &&
    !reviewRetry &&
    Object.values(run.operations).some(
      (op) => op.kind === "run.release" && op.status !== "failed",
    )
  )
    throw new Error(
      "Run ownership was released or release is pending; a fresh workflow is required",
    );
  if (
    command === "ralph-resume" &&
    run.planning?.protocol === "native-interview-v1" &&
    !reviewRetry
  ) {
    const owner = JSON.parse(
      await readFile(join(store.root, "active-run.lock", "owner.json"), "utf8"),
    );
    if (owner.runId !== runId || owner.repositoryId !== store.repositoryId)
      throw new Error("Repository ownership differs; resume blocked");
  }
  if (run.control?.cleanupPending)
    throw new Error("Stop cleanup is pending; wait or reconcile after restart");
  if (
    command === "ralph-pause" &&
    run.control &&
    !["active", "paused"].includes(run.control.status)
  )
    throw new Error(`Run is ${run.control.status}; reconcile or resume first`);
  if (
    command === "ralph-resume" &&
    run.control?.status === "stopped" &&
    run.control.facts?.length
  )
    throw new Error("Stop cleanup uncertain; recovery reconciliation required");
  if (command === "ralph-resume" && run.control?.status === "blocked")
    throw new Error(`Recovery blocked: ${run.control.facts?.join("; ")}`);
  const status =
    command === "ralph-pause"
      ? "paused"
      : command === "ralph-stop"
        ? "stopped"
        : "active";
  // Stopping resources does not resolve an ambiguous recovery or prior cleanup.
  const retainedFacts =
    command === "ralph-stop" &&
    ["blocked", "stopped"].includes(run.control?.status ?? "")
      ? (run.control?.facts ?? [])
      : [];
  if (
    !(await store.recordControl(
      runId,
      {
        status,
        source: options.source ?? "human",
        facts: retainedFacts,
        ...(command === "ralph-stop" ? { cleanupPending: true } : {}),
      },
      run.revision,
    ))
  )
    throw new Error("Control state changed; retry command");
  if (command === "ralph-stop") {
    const current = await store.getRun(runId);
    const cleanup = Promise.allSettled([
      disposeRunEnvironments(runId, [
        ...Object.values(current?.jobs ?? {}).map(
          (job) => job.envelope.workspace,
        ),
        ...Object.values(current?.operations ?? {}).map(
          (op) => op.job.workspace,
        ),
      ]),
      ...Object.values(current?.jobs ?? {})
        .filter((job) => job.status !== "terminal")
        .map(async ({ envelope }) => {
          if (adapter) {
            const result = await adapter.cancelJob(envelope);
            if (!result.ok)
              throw new Error(result.error?.message ?? "Cancellation failed");
          } else {
            await store.recordResult({
              ...envelope,
              outcome: "cancelled",
              evidence: [],
              error: { code: "cancelled", message: "Stop requested" },
            });
          }
        }),
      ...Object.values(current?.operations ?? {})
        .filter((op) => op.ownedProcess)
        .map(async (op) => {
          if (
            op.ownedProcess &&
            !(await terminateOwnedProcess(op.ownedProcess))
          )
            throw new Error(
              `Process ownership/cleanup uncertain: ${op.operationId}`,
            );
        }),
      ...(current?.planning?.protocol === "native-interview-v1"
        ? [
            (async () => {
              const state = current.planning;
              if (!state)
                throw new Error("Planning state disappeared during cleanup");
              const sessions = new Set([state.owner?.sessionId]);
              const handoff = state.issueHandoff;
              if (handoff?.creationStarted && !handoff.sessionId) {
                if (!adapter?.findIssueSession)
                  throw new Error("Stage cleanup metadata unavailable");
                sessions.add(
                  await adapter.findIssueSession(
                    state.workspace,
                    runId,
                    handoff.jobId,
                    handoff.attempt,
                  ),
                );
              }
              sessions.add(handoff?.sessionId);
              for (const sessionId of sessions) {
                if (!sessionId) continue;
                const job = {
                  runId,
                  jobId: "stage-cleanup",
                  role: "completion",
                  attempt: state.owner?.attempt ?? 1,
                  sessionId,
                  workspace: state.workspace,
                  baseCommit: state.approval?.sha ?? "",
                  inputRevisions: {},
                  prompt: "Settle stopped planning session",
                };
                const result = await adapter?.cancelStageSession?.(job);
                if (
                  !result?.ok ||
                  !["idle", "missing"].includes(
                    (await adapter?.inspectSession?.(job)) ?? "unknown",
                  )
                )
                  throw new Error(
                    "Stage cleanup unconfirmed; reconcile the retained session",
                  );
              }
            })(),
          ]
        : []),
      ...(options.cleanup ? [options.cleanup()] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        cleanup,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(
            () => resolve(undefined),
            options.timeoutMs ?? 2000,
          );
        }),
      ]);
      const facts =
        settled === undefined
          ? [
              "Cleanup deadline reached; retained resources require reconciliation",
            ]
          : settled
              .filter((r) => r.status === "rejected")
              .map((r) => String(r.reason));
      const afterCleanup = await store.getRun(runId);
      if (afterCleanup?.control?.status !== "stopped")
        throw new Error(
          "Control changed during cleanup; reconciliation required",
        );
      await store.recordControl(
        runId,
        {
          status: "stopped",
          source: options.source ?? "human",
          facts: [...new Set([...retainedFacts, ...facts])],
        },
        afterCleanup.revision,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return JSON.stringify((await store.getRun(runId))?.control);
}
