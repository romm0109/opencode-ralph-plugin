import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunOperation, RunRecord } from "../core/types.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import type { RunStore } from "../state/run-store.js";

export function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? accept(stdout)
        : reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`)),
    );
  });
}
export async function inspectWorktree(workspace: string) {
  return {
    workspace: await realpath(workspace),
    repositoryId: await realpath(
      resolve(
        workspace,
        (await gitOutput(workspace, ["rev-parse", "--git-common-dir"])).trim(),
      ),
    ),
    commit: (
      await gitOutput(workspace, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim(),
    branch: (await gitOutput(workspace, ["symbolic-ref", "HEAD"])).trim(),
  };
}
export async function createOwnedWorktree(
  store: RunStore,
  directory: string,
  operation: RunOperation,
) {
  if (
    !["baseline.workspace", "issue.workspace", "candidate.workspace"].includes(
      operation.kind,
    ) ||
    !operation.ref?.startsWith("refs/heads/ralph/") ||
    !operation.expectedNew
  )
    throw new Error("Invalid baseline ownership intent");
  if (!(await store.recordOperation(operation)))
    throw new Error("Stale baseline intent");
  try {
    await gitOutput(directory, [
      "worktree",
      "add",
      "-b",
      operation.ref.slice(11),
      operation.job.workspace,
      operation.expectedNew,
    ]);
    if (!(await store.recordOperation({ ...operation, status: "completed" })))
      throw new Error("Stale workspace completion");
    return inspectWorktree(operation.job.workspace);
  } catch (cause) {
    await store.recordOperation({
      ...operation,
      status: "failed",
      error: {
        code: "baseline-blocked",
        message: String(cause),
        cause: String(cause),
      },
    });
    throw cause;
  }
}
export async function removeOwnedWorktree(
  store: RunStore,
  directory: string,
  operationId: string,
) {
  const run = (await store.listRuns()).find(
    (run) => run.operations[operationId],
  );
  const owner = run?.operations[operationId];
  if (
    !owner ||
    !["baseline.workspace", "issue.workspace", "candidate.workspace"].includes(
      owner.kind,
    ) ||
    owner.status !== "completed"
  )
    throw new Error("No completed worktree ownership record");
  const found = await inspectWorktree(owner.job.workspace);
  if (
    found.repositoryId !== store.repositoryId ||
    found.branch !== owner.ref ||
    found.commit !==
      (owner.kind === "issue.workspace"
        ? run?.issueAttempts?.[owner.job.issueId ?? ""]?.submission
            ?.submittedCommit
        : owner.kind === "candidate.workspace"
          ? run?.issueAttempts?.[owner.job.issueId ?? ""]?.candidate?.commit
          : owner.expectedNew)
  )
    throw new Error("Owned worktree identity changed; inspect manually");
  const cleanup: RunOperation = {
    ...owner,
    operationId: `${operationId}-cleanup`,
    kind:
      owner.kind === "issue.workspace"
        ? "issue.cleanup"
        : owner.kind === "candidate.workspace"
          ? "candidate.cleanup"
          : "baseline.cleanup",
    status: "intent",
  };
  if (!(await store.recordOperation(cleanup)))
    throw new Error("Stale cleanup intent");
  try {
    await gitOutput(directory, ["worktree", "remove", owner.job.workspace]);
    await gitOutput(directory, [
      "update-ref",
      "-d",
      owner.ref as string,
      found.commit,
    ]);
    await store.recordOperation({ ...cleanup, status: "completed" });
  } catch (cause) {
    await store.recordOperation({
      ...cleanup,
      status: "failed",
      error: { code: "baseline-blocked", message: String(cause) },
    });
    throw cause;
  }
}

function assertValidatedIntegration(run: RunRecord, operation: RunOperation) {
  const attempt = run.issueAttempts?.[operation.job.issueId ?? ""];
  if (
    (run.control && run.control.status !== "active") ||
    run.planning?.phase !== "execution_approved" ||
    !executionEligibilityMatchesRevision(run.planning) ||
    run.baseline?.approvalRequestId !==
      run.planning.executionEligibility?.requestId ||
    attempt?.status !== "merging" ||
    attempt.candidate?.job.jobId !== operation.job.jobId ||
    attempt.candidate.job.baseCommit !== operation.expectedOld ||
    attempt.candidate.commit !== operation.expectedNew ||
    !attempt.validation ||
    attempt.validation.candidateCommit !== operation.expectedNew ||
    !["passed", "passed_with_omissions"].includes(attempt.validation.status) ||
    attempt.validation.commandHash !== run.planning.commandHash ||
    attempt.validation.commandRevision !== operation.job.inputRevisions.commands
  )
    throw new Error(
      "Integration requires current successful validation of the exact candidate",
    );
}

/** Advance only the run-owned integration ref, with an exact validated candidate. */
export async function compareAndAdvanceRef(
  store: RunStore,
  directory: string,
  operation: RunOperation,
): Promise<boolean> {
  const run = await store.getRun(operation.job.runId);
  const baseline = run?.baseline;
  const owner = baseline && run?.operations[baseline.operationId];
  if (
    !run ||
    operation.kind !== "integration.advance" ||
    !operation.expectedOld ||
    !operation.expectedNew ||
    operation.ref !== `refs/heads/${baseline?.branch}` ||
    owner?.kind !== "baseline.workspace" ||
    owner.status !== "completed" ||
    owner.ref !== operation.ref ||
    !baseline?.workspace
  )
    throw new Error("No owned integration ref");
  assertValidatedIntegration(run, operation);
  const integration = await inspectWorktree(baseline.workspace);
  const candidate = await inspectWorktree(operation.job.workspace);
  const candidateOwner = Object.values(run.operations).find(
    (item) =>
      item.kind === "candidate.workspace" &&
      item.status === "completed" &&
      item.job.jobId === operation.job.jobId &&
      item.job.workspace === candidate.workspace,
  );
  if (
    integration.repositoryId !== store.repositoryId ||
    integration.branch !== operation.ref ||
    candidate.repositoryId !== store.repositoryId ||
    candidate.branch !== candidateOwner?.ref ||
    candidate.commit !== operation.expectedNew ||
    (
      await gitOutput(candidate.workspace, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    ).trim()
  )
    throw new Error("Validated candidate identity changed");
  if (integration.commit !== operation.expectedOld) return false;
  if (
    (
      await gitOutput(integration.workspace, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    ).trim()
  )
    throw new Error("Integration checkout changed");
  await gitOutput(directory, [
    "merge-base",
    "--is-ancestor",
    operation.expectedOld,
    operation.expectedNew,
  ]);
  if (!(await store.recordOperation(operation)))
    throw new Error("Stale integration intent");
  try {
    const current = await store.getRun(operation.job.runId);
    if (
      !current ||
      (current.control?.epoch ?? 0) !== (run.control?.epoch ?? 0) ||
      current.planning?.executionEligibility?.requestId !==
        run.planning?.executionEligibility?.requestId
    )
      throw new Error("Stale integration completion");
    assertValidatedIntegration(current, operation);
    const finalCandidate = await inspectWorktree(operation.job.workspace);
    if (
      finalCandidate.commit !== operation.expectedNew ||
      finalCandidate.branch !== candidateOwner?.ref ||
      finalCandidate.repositoryId !== store.repositoryId ||
      (
        await gitOutput(operation.job.workspace, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])
      ).trim()
    )
      throw new Error("Candidate changed after validation");
    await gitOutput(directory, [
      "update-ref",
      operation.ref,
      operation.expectedNew,
      operation.expectedOld,
    ]);
  } catch (cause) {
    await store.recordOperation({
      ...operation,
      status: "failed",
      error: {
        code: "baseline-blocked",
        message: String(cause),
        cause: String(cause),
      },
    });
    if (
      (await gitOutput(directory, ["rev-parse", operation.ref])).trim() !==
      operation.expectedOld
    )
      return false;
    throw cause;
  }
  // Keep the owned baseline index consistent without another ref mutation.
  let error: RunOperation["error"];
  try {
    await gitOutput(integration.workspace, [
      "read-tree",
      "--reset",
      "-u",
      operation.expectedNew,
    ]);
  } catch (cause) {
    error = {
      code: "baseline-blocked",
      message: `Accepted integration; checkout synchronization failed: ${String(cause)}`,
      cause: String(cause),
    };
  }
  if (
    !(await store.recordOperation({
      ...operation,
      status: "completed",
      ...(error ? { error } : {}),
    }))
  )
    throw new Error(
      "Integration applied; durable completion requires reconciliation",
    );
  return true;
}

/** Finish only the proven old-index → accepted-tree transition after a ref crash. */
export async function reconcileIntegrationCheckout(
  workspace: string,
  repositoryId: string,
  ref: string,
  expectedOld: string,
  expectedNew: string,
) {
  const actual = await inspectWorktree(workspace);
  if (
    actual.repositoryId !== repositoryId ||
    actual.branch !== ref ||
    actual.commit !== expectedNew
  )
    throw new Error("Integration checkout identity changed");
  const index = (await gitOutput(workspace, ["write-tree"])).trim();
  const acceptedTree = (
    await gitOutput(workspace, ["rev-parse", `${expectedNew}^{tree}`])
  ).trim();
  await gitOutput(workspace, ["diff-files", "--quiet"]);
  if (index === acceptedTree) return;
  const oldTree = (
    await gitOutput(workspace, ["rev-parse", `${expectedOld}^{tree}`])
  ).trim();
  if (index !== oldTree)
    throw new Error("Integration index is ambiguous; retained for inspection");
  // Two-tree merge refuses local/untracked conflicts; never force-reset user edits.
  await gitOutput(workspace, [
    "read-tree",
    "-m",
    "-u",
    expectedOld,
    expectedNew,
  ]);
}
