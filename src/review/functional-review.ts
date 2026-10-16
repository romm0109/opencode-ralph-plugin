import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { waitForDispatch } from "../commands/control.js";
import type { Failure, JobEnvelope } from "../core/types.js";
import {
  createOwnedWorktree,
  verifyFunctionalWorkspace,
  verifyReviewRepository,
} from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import {
  type ApprovedEnvironment,
  type CommandResult,
  disposeEnvironment,
  prepareEnvironment,
} from "../process/environment.js";
import { loadRoleInstructions } from "../roles/instructions.js";
import type { RunStore } from "../state/run-store.js";
import { runtimeSecretValues, sanitizeValue } from "../state/sanitize.js";
import {
  createFunctionalChecklist,
  type FunctionalReviewResult,
  parseFunctionalReviewResult,
} from "./functional-results.js";
import type { ReviewSnapshot } from "./types.js";

export interface FunctionalReviewOptions {
  store: RunStore;
  adapter: OpenCodeAdapter;
  directory: string;
  parentSessionId: string;
  environment: ApprovedEnvironment;
  surfaces: { ui: boolean; http: boolean };
  /** Dedicated observation tool IDs registered in OpenCode; shell/edit tools are forbidden. */
  tools: { browser?: string; http?: string };
  requiredEnvRefs?: string[];
  /** Remaining feature-wide infrastructure budget, supplied by the coordinator. */
  infrastructureAttemptLimit?: number;
  model?: JobEnvelope["model"];
}
function assertCleanup(result: CommandResult) {
  if (result.status !== "completed")
    throw new Error(result.reason ?? `Cleanup ${result.status}`);
}
export async function runFunctionalReview(
  snapshot: ReviewSnapshot,
  options: FunctionalReviewOptions,
): Promise<FunctionalReviewResult> {
  await waitForDispatch(options.store, snapshot.runId);
  const limit = options.infrastructureAttemptLimit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new Error("Invalid functional infrastructure attempt budget");
  await verifyReviewRepository(options.directory, options.store.repositoryId);
  const current = async () => {
    const run = await options.store.getRun(snapshot.runId);
    if (
      !run?.review ||
      run.review.superseded ||
      !isDeepStrictEqual(run.review.snapshot, snapshot) ||
      run.operations[`review-pin-${snapshot.round}`]?.status !== "completed" ||
      !run.execution?.issues.length ||
      run.execution.issues.some((issue) => issue.status !== "integrated") ||
      run.execution.integrationQueue.length
    )
      throw new Error("Unknown or superseded functional review snapshot");
    return run;
  };
  const run = await current();
  if (run.review?.functionalResult) return run.review.functionalResult;
  if (!run.review) throw new Error("Missing frozen review inputs");
  const checklist = createFunctionalChecklist(
    run.review.inputs.prd,
    run.review.inputs.graph,
    options.surfaces,
  );
  const result: FunctionalReviewResult = {
    role: "functional-review",
    reviewedCommit: snapshot.commit,
    round: snapshot.round,
    outcome: "unverified",
    findings: [],
    evidence: [],
    evidenceRefs: [],
    criteria: checklist.map((c) => ({
      ...c,
      status: "unverified",
      evidenceRefs: [],
      reason: "Review has not run",
    })),
    attempts: [],
  };
  const requested = [
    ...(options.surfaces.ui ? [options.tools.browser] : []),
    ...(options.surfaces.http ? [options.tools.http] : []),
  ];
  const workspace = join(options.store.root, "review-workspaces", randomUUID());
  const job: JobEnvelope = {
    runId: snapshot.runId,
    jobId: `functional-review-${snapshot.round}`,
    attempt: 1,
    role: "functional-review",
    readOnly: true,
    observationTools: requested.filter((tool): tool is string => !!tool),
    workspace,
    baseCommit: snapshot.commit,
    inputRevisions: {
      round: snapshot.round,
      commands: options.environment.revision,
    },
    prompt: "",
    ...(options.model ? { model: options.model } : {}),
  };
  const workspaceIntent = {
    operationId: `functional-workspace-${snapshot.round}`,
    kind: "review.workspace" as const,
    status: "intent" as const,
    job,
  };
  if (!(await options.store.recordOperation(workspaceIntent)))
    throw new Error(
      "Functional review already started; reconcile existing operation before resume",
    );
  let workspaceReady = false;
  for (let attempt = 1; attempt <= limit; attempt++) {
    await waitForDispatch(options.store, snapshot.runId);
    await current();
    job.attempt = attempt;
    const evidenceRefs: string[] = [];
    let blocker: Failure | undefined;
    let invalid = false;
    const operation = {
      operationId: `functional-environment-${snapshot.round}-${attempt}`,
      kind: "review.environment" as const,
      status: "intent" as const,
      job: { ...job },
    };
    if (!(await options.store.recordOperation(operation)))
      throw new Error("Environment intent rejected");
    try {
      if (!workspaceReady) {
        await createOwnedWorktree(
          options.directory,
          workspace,
          snapshot.commit,
        );
        workspaceReady = true;
        await options.store.recordOperation({
          ...workspaceIntent,
          status: "completed",
        });
      }
      const lease = await prepareEnvironment(options.environment, job);
      evidenceRefs.push(...lease.evidenceRefs);
      await options.store.recordOperation({
        ...operation,
        status: "completed",
      });
      await verifyFunctionalWorkspace(workspace, snapshot.commit);
      const url =
        options.surfaces.ui || options.surfaces.http
          ? new URL(lease.url)
          : undefined;
      if (
        url &&
        (url.username ||
          url.password ||
          !["http:", "https:"].includes(url.protocol) ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
        throw new Error("Approved review environment must be local");
      const missing = (options.requiredEnvRefs ?? []).filter(
        (ref) => !process.env[ref],
      );
      if (missing.length)
        throw new Error(
          `Missing required test access references: ${missing.join(", ")}`,
        );
      const available = await options.adapter.discoverTools?.(workspace);
      if (
        !available ||
        requested.some(
          (tool) =>
            !tool ||
            !available.includes(tool) ||
            ["bash", "edit", "write", "patch", "apply_patch"].includes(tool),
        )
      )
        throw new Error("Required browser/HTTP observation tools unavailable");
      job.prompt = `${await loadRoleInstructions("functional-review")}\nReview input:\n${JSON.stringify({ snapshot, checklist, prd: run.review.inputs.prd, graph: run.review.inputs.graph, url: lease.url, tools: options.tools, environmentEvidence: lease.evidenceRefs, tddEvidence: run.review.inputs.tddEvidence, candidateChecks: run.review.inputs.tests, changes: run.review.inputs.diff, commandPolicy: { hash: run.planning?.commandHash, revision: run.baseline?.commandRevision, executionEligibility: run.planning?.executionEligibility }, requiredEnvRefs: options.requiredEnvRefs ?? [] })}`;
      await current();
      await waitForDispatch(options.store, snapshot.runId);
      const response = await options.adapter.dispatchJob({ ...job });
      evidenceRefs.push(...response.evidence);
      if (response.outcome !== "completed" || !response.text) {
        blocker = response.error ?? {
          code: "missing-output",
          message: "No completed functional output",
        };
      } else {
        invalid = true;
        if (
          !response.sessionId ||
          response.sessionId === options.parentSessionId ||
          Object.values(run.jobs).some(
            (entry) => entry.envelope.sessionId === response.sessionId,
          ) ||
          response.runId !== job.runId ||
          response.jobId !== job.jobId ||
          response.attempt !== attempt ||
          response.workspace !== workspace ||
          response.baseCommit !== snapshot.commit
        )
          throw new Error("Uncorrelated functional reviewer response");
        await verifyFunctionalWorkspace(workspace, snapshot.commit);
        const parsed = parseFunctionalReviewResult(
          response.text,
          snapshot,
          checklist,
        );
        Object.assign(result, {
          ...parsed,
          attempts: result.attempts,
          sessionId: response.sessionId,
        });
        if (parsed.outcome === "unverified" && !parsed.findings.length) {
          // Only explicit infrastructure blockers grant another attempt.
          const raw = JSON.parse(response.text);
          if (raw.unavailable === true) {
            invalid = false;
            blocker = {
              code: "unsupported",
              message: parsed.criteria
                .filter((c) => c.status === "unverified")
                .map((c) => c.reason)
                .join("; "),
            };
          }
        }
      }
    } catch (cause) {
      blocker = {
        code: invalid ? "invalid-review" : "unsupported",
        message: cause instanceof Error ? cause.message : String(cause),
        cause:
          cause instanceof Error
            ? { name: cause.name, message: cause.message }
            : cause,
      };
      await options.store.recordOperation({
        ...operation,
        status: "failed",
        error: sanitizeValue(blocker, runtimeSecretValues()),
      });
    } finally {
      const cleanup = {
        operationId: `functional-cleanup-${snapshot.round}-${attempt}`,
        kind: "review.cleanup" as const,
        status: "intent" as const,
        job: { ...job },
      };
      await options.store.recordOperation(cleanup);
      try {
        const disposed = await disposeEnvironment(options.environment, job);
        evidenceRefs.push(...disposed.evidenceRefs);
        assertCleanup(disposed);
        await options.store.recordOperation({
          ...cleanup,
          status: "completed",
        });
      } catch (cause) {
        blocker = {
          code: "unsupported",
          message: "Owned environment cleanup failed",
          cause: String(cause),
        };
        invalid = true; // Do not start another environment while resources may still be live.
        await options.store.recordOperation({
          ...cleanup,
          status: "failed",
          error: sanitizeValue(blocker, runtimeSecretValues()),
        });
        if (!result.findings.length) result.outcome = "unverified";
      }
    }
    result.attempts.push({
      attempt,
      evidenceRefs,
      ...(blocker ? { blocker } : {}),
    });
    result.evidenceRefs.push(...evidenceRefs);
    if (blocker) {
      result.error = blocker;
      if (!result.findings.length) result.outcome = "unverified";
      result.criteria = result.criteria.map((c) =>
        c.status === "unverified"
          ? {
              ...c,
              reason: blocker.message,
              evidenceRefs: [...c.evidenceRefs, ...evidenceRefs],
            }
          : c,
      );
    } else delete result.error;
    if (!blocker || invalid || result.findings.length) break;
  }
  await current();
  const safe = sanitizeValue(result, runtimeSecretValues());
  if (
    !(await options.store.recordFunctionalReviewResult(
      snapshot.runId,
      snapshot,
      safe,
    ))
  )
    throw new Error("Superseded functional review result ignored");
  return safe;
}
