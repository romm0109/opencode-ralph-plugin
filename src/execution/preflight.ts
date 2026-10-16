import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertProjectConfigured } from "../commands/project-setup.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import type { Failure, JobEnvelope, RunOperation } from "../core/types.js";
import { verifyReviewRepository } from "../git/review-workspace.js";
import {
  createOwnedWorktree,
  gitOutput,
  removeOwnedWorktree,
} from "../git/worktrees.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import { artifactHash, issueBundleHash } from "../planning/artifacts.js";
import { assertNativeExecutionInputs } from "../planning/eligibility.js";
import { validateIssueGraph } from "../planning/graph.js";
import type { RunStore } from "../state/run-store.js";
import { type ValidationSummary, validateCandidate } from "./validation.js";

export interface BaselineState {
  status: "preparing" | "passed" | "passed_with_omissions" | "failed";
  operationId: string;
  candidateCommit: string;
  commandHash: string;
  commandRevision: number;
  approvalRequestId?: string;
  branch?: string;
  workspace?: string;
  blocker?: string;
  error?: Failure;
  validation?: ValidationSummary;
}
export async function preflightRun(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  const initial = await store.getRun(runId);
  const state = initial?.planning;
  if (!initial || !state) throw new Error("Unknown planning run");
  if (state.protocol !== "native-interview-v1")
    throw new Error("Unsupported saved workflow; a fresh workflow is required");
  if (initial.baseline?.status === "preparing") return initial;
  const epoch = initial.control?.epoch ?? 0;
  const baseline: BaselineState = {
    status: "preparing",
    operationId: `baseline-${randomUUID()}`,
    candidateCommit: state.executionEligibility?.selectedCommit ?? "",
    commandHash: state.commandHash,
    commandRevision: 0,
    ...(state.executionEligibility
      ? { approvalRequestId: state.executionEligibility.requestId }
      : {}),
  };
  async function save(expectedRevision?: number) {
    const run = await store.getRun(runId);
    if (
      !run ||
      (run.baseline?.operationId !== initial?.baseline?.operationId &&
        run.baseline?.operationId !== baseline.operationId) ||
      (run.control?.epoch ?? 0) !== epoch ||
      run.planning?.executionEligibility?.requestId !==
        state?.executionEligibility?.requestId ||
      !(await store.recordBaseline(
        runId,
        expectedRevision ?? run.revision,
        baseline,
        baseline.validation?.skippedCheckIds ?? [],
      ))
    )
      throw new Error("Stale baseline transition");
  }
  let owned: RunOperation | undefined;
  try {
    if (initial.control && initial.control.status !== "active") return initial;
    if (
      state.phase !== "execution_approved" ||
      !state.prd ||
      !state.graph ||
      !state.executionEligibility ||
      !executionEligibilityMatchesRevision(state) ||
      state.executionEligibility.prdHash !== state.prd.hash ||
      state.executionEligibility.graphHash !== state.graph.hash ||
      state.executionEligibility.revision !== state.graph.revision ||
      !baseline.candidateCommit ||
      state.selectedCommit !== baseline.candidateCommit
    )
      throw new Error(
        "Matching execution approval and selected commit are required",
      );
    await verifyReviewRepository(state.workspace, store.repositoryId);
    const lock = JSON.parse(
      await readFile(join(store.root, "active-run.lock/owner.json"), "utf8"),
    );
    if (lock.runId !== runId || lock.repositoryId !== store.repositoryId)
      throw new Error("Repository lock belongs to another run");
    await assertProjectConfigured(state.workspace);
    const config = await loadProjectConfig(state.workspace);
    baseline.commandRevision = config.commands.revision;
    if (
      commandConfigHash(config.commands) !== state.commandHash ||
      (state.protocol === "native-interview-v1" &&
        config.commands.revision !== state.executionEligibility.commandRevision)
    )
      throw new Error("Approved command configuration changed");
    validateIssueGraph(state.graph.value, state.graph.files, state.prd);
    const graph = JSON.parse(
      await readFile(join(state.workspace, state.graph.artifactPath), "utf8"),
    );
    const files: Record<string, string> = {};
    for (const path of Object.keys(state.graph.files))
      files[path] = await readFile(
        join(state.workspace, dirname(state.graph.artifactPath), path),
        "utf8",
      );
    if (
      artifactHash(
        await readFile(join(state.workspace, state.prd.artifactPath), "utf8"),
      ) !== state.prd.hash ||
      issueBundleHash(graph, files) !== state.graph.hash
    )
      throw new Error("Approved planning artifacts changed");
    await assertNativeExecutionInputs(state, runId);
    if (
      initial.baseline &&
      ["passed", "passed_with_omissions"].includes(initial.baseline.status) &&
      initial.baseline.candidateCommit === baseline.candidateCommit &&
      initial.baseline.commandHash === baseline.commandHash &&
      initial.baseline.approvalRequestId ===
        state.executionEligibility.requestId
    )
      return initial;
    try {
      await gitOutput(state.workspace, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]);
    } catch (cause) {
      throw new Error(
        "Repository HEAD is unborn or invalid; create a commit before execution",
        { cause },
      );
    }
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.candidateCommit) ||
      (
        await gitOutput(state.workspace, [
          "rev-parse",
          "--verify",
          `${baseline.candidateCommit}^{commit}`,
        ])
      ).trim() !== baseline.candidateCommit
    )
      throw new Error(
        "Selected starting commit is invalid; select and approve a committed starting point",
      );
    const dirty = (
      await gitOutput(state.workspace, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const managed =
      state.protocol === "native-interview-v1"
        ? (state.managedArtifacts ?? {})
        : {};
    if (
      dirty.some(
        (entry) =>
          !entry.startsWith("?? ") || !Object.hasOwn(managed, entry.slice(3)),
      )
    )
      throw new Error(
        "Checkout is dirty; commit or remove tracked and relevant untracked changes before execution",
      );
    baseline.branch = `ralph/${runId}`;
    baseline.workspace = join(store.root, "worktrees", runId);
    if (
      (
        await gitOutput(state.workspace, [
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/${baseline.branch}`,
        ])
      ).trim()
    )
      throw new Error(
        `Branch ${baseline.branch} already exists; inspect it and select a new feature ID`,
      );
    await save(initial.revision);
    await mkdir(dirname(baseline.workspace), { recursive: true });
    const job: JobEnvelope = {
      runId,
      jobId: baseline.operationId,
      role: "baseline",
      attempt: 0,
      workspace: baseline.workspace,
      baseCommit: baseline.candidateCommit,
      inputRevisions: {
        commands: config.commands.revision,
        approval: state.executionEligibility.revision,
      },
      prompt: "Validate approved feature baseline",
    };
    owned = {
      operationId: baseline.operationId,
      kind: "baseline.workspace",
      status: "intent",
      job,
      ref: `refs/heads/${baseline.branch}`,
      expectedOld: baseline.candidateCommit,
      expectedNew: baseline.candidateCommit,
    };
    await createOwnedWorktree(store, state.workspace, owned);
    baseline.validation = await validateCandidate({
      store,
      adapter,
      job,
      config: config.commands,
      sourceWorkspace: state.workspace,
      permissionSessionId: state.sessionId,
    });
    baseline.status = baseline.validation.status;
    if (baseline.validation.blocker) {
      baseline.blocker = baseline.validation.blocker;
      baseline.error = {
        code: "baseline-blocked",
        message: baseline.validation.blocker,
        cause: baseline.validation.blocker,
      };
    }
    if (baseline.status === "failed")
      await removeOwnedWorktree(store, state.workspace, owned.operationId);
    await save();
  } catch (cause) {
    // Revalidation failures must never erase a previously accepted baseline.
    if (
      initial.baseline &&
      ["passed", "passed_with_omissions"].includes(initial.baseline.status)
    )
      throw cause;
    baseline.status = "failed";
    baseline.blocker = String(cause);
    baseline.error = {
      code: "baseline-blocked",
      message: String(cause),
      cause: String(cause),
    };
    if (
      owned &&
      (await store.getRun(runId))?.operations[owned.operationId]?.status ===
        "completed"
    ) {
      try {
        await removeOwnedWorktree(store, state.workspace, owned.operationId);
      } catch (cleanup) {
        baseline.blocker += `; cleanup: ${String(cleanup)}`;
      }
    }
    await save().catch(() => {});
  }
  const latest = await store.getRun(runId);
  if (latest?.baseline?.operationId === baseline.operationId)
    await adapter.publishStatus(
      state.sessionId,
      state.workspace,
      JSON.stringify(latest.baseline),
    );
  return latest;
}
