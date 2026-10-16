import { randomUUID } from "node:crypto";
import { z } from "zod";
import { correlatedResult } from "../agents/results.js";
import { loadRoleInstructions } from "../agents/skills.js";
import { waitForDispatch } from "../commands/control.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import type { JobEnvelope } from "../core/types.js";
import {
  compareAndAdvanceRef,
  createOwnedWorktree,
  gitOutput,
  inspectWorktree,
  removeOwnedWorktree,
} from "../git/worktrees.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { executionIssue } from "../review/repair-context.js";
import type { RunStore } from "../state/run-store.js";
import {
  type AttemptOptions,
  dispatchAttempt,
  failAttempt,
} from "./attempts.js";
import {
  assertCurrentAttempt,
  type IssueAttempt,
  saveIssueAttempt,
} from "./execute-issue.js";
import { integrationQueue } from "./integration-queue.js";
import { validateCandidate } from "./validation.js";

export type IntegrationResult = IssueAttempt;
const mergeResult = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("merged"),
      candidateCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("behavior_conflict"),
      feedback: z.string().trim().min(1),
    })
    .strict(),
]);
export async function integrateSubmission(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  issueId: string,
  options: AttemptOptions = {},
): Promise<IntegrationResult> {
  await waitForDispatch(store, runId);
  const initial = await store.getRun(runId);
  const stored = initial?.issueAttempts?.[issueId];
  if (!initial || !stored) throw new Error("Missing issue submission");
  if (stored.status !== "submitted") return stored;
  const attempt = structuredClone(stored);
  const submission = attempt.submission;
  const planning = initial.planning;
  const baseline = initial.baseline;
  if (!submission || !planning || !baseline?.workspace || !baseline.branch)
    throw new Error("Missing integration inputs");
  assertCurrentAttempt(initial, initial, attempt);
  attempt.status = "merging";
  // Reserve before dispatch: another integrator may not dispatch this attempt again.
  await saveIssueAttempt(store, initial, attempt);
  try {
    const config = await loadProjectConfig(planning.workspace);
    if (commandConfigHash(config.commands) !== planning.commandHash)
      throw new Error("Approved commands changed");
    const skill = await loadRoleInstructions(
      planning.workspace,
      "merger",
      config.skillPaths,
    );
    for (let rebuild = 0; rebuild < 3; rebuild++) {
      const base = await inspectWorktree(baseline.workspace);
      if (
        base.repositoryId !== store.repositoryId ||
        base.branch !== `refs/heads/${baseline.branch}`
      )
        throw new Error("Integration identity changed");
      const operationId = `candidate-${randomUUID()}`;
      const job: JobEnvelope = {
        ...attempt.job,
        jobId: operationId,
        role: "merger",
        workspace: `${attempt.job.workspace}-${operationId}`,
        baseCommit: base.commit,
        ...(planning.settings.models.merger
          ? { model: planning.settings.models.merger }
          : {}),
        prompt: `${skill.text}\nSkill: ${JSON.stringify({ path: skill.path, hash: skill.hash })}\nApproved PRD: ${JSON.stringify(planning.prd)}\nApproved issue: ${JSON.stringify(executionIssue(initial, issueId))}\nLatest integration: ${base.commit}\nSUBMISSION\n${JSON.stringify(submission)}`,
      };
      delete job.sessionId;
      delete job.environment;
      if (!planning.settings.models.merger) delete job.model;
      attempt.candidate = {
        operationId,
        job,
        ref: `refs/heads/ralph/candidates/${runId}/${operationId}`,
      };
      await saveIssueAttempt(store, initial, attempt);
      await createOwnedWorktree(store, planning.workspace, {
        operationId,
        kind: "candidate.workspace",
        status: "intent",
        job,
        ref: attempt.candidate.ref,
        expectedNew: base.commit,
      });
      const result = await dispatchAttempt(
        store,
        adapter,
        job,
        attempt.agentTimeoutMs ?? planning.settings.agentTimeoutMs ?? 1800000,
        options,
      );
      assertCurrentAttempt(initial, await store.getRun(runId), attempt);
      attempt.candidate.result = result;
      if (result.outcome !== "completed") {
        attempt.error = result.error ?? {
          code:
            result.outcome === "denied"
              ? "permission-denied"
              : result.outcome === "cancelled"
                ? "cancelled"
                : "missing-output",
          message: "Merger did not complete",
        };
        throw new Error(attempt.error.message);
      }
      const output = mergeResult.parse(correlatedResult(job, result));
      attempt.mergerSessionId = result.sessionId as string;
      if (result.sessionId === submission.sessionId)
        throw new Error("Merger must use a separate session");
      if (output.kind === "behavior_conflict") {
        attempt.feedback = output.feedback;
        throw new Error("Merge requires behavior repair");
      }
      const found = await inspectWorktree(job.workspace);
      if (
        found.repositoryId !== store.repositoryId ||
        found.branch !== attempt.candidate.ref ||
        found.commit !== output.candidateCommit ||
        (
          await gitOutput(job.workspace, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ])
        ).trim()
      )
        throw new Error(
          "Merger output must be clean and committed on the owned candidate branch",
        );
      await gitOutput(job.workspace, [
        "merge-base",
        "--is-ancestor",
        base.commit,
        found.commit,
      ]);
      await gitOutput(job.workspace, [
        "merge-base",
        "--is-ancestor",
        submission.submittedCommit,
        found.commit,
      ]);
      attempt.candidate.commit = found.commit;
      await saveIssueAttempt(store, initial, attempt);
      const validationJob = {
        ...job,
        baseCommit: found.commit,
        sessionId: result.sessionId as string,
      };
      await waitForDispatch(store, runId);
      assertCurrentAttempt(initial, await store.getRun(runId), attempt);
      attempt.validation = await validateCandidate({
        store,
        adapter,
        job: validationJob,
        config: config.commands,
        sourceWorkspace: planning.workspace,
        ...(options.clock ? { clock: options.clock } : {}),
      });
      await saveIssueAttempt(store, initial, attempt);
      if (attempt.validation.status === "failed") {
        if (attempt.validation.failureCause)
          attempt.error = attempt.validation.failureCause;
        throw new Error(
          attempt.validation.blocker ?? "Candidate validation failed",
        );
      }
      assertCurrentAttempt(initial, await store.getRun(runId), attempt);
      await waitForDispatch(store, runId);
      assertCurrentAttempt(initial, await store.getRun(runId), attempt);
      const advanced = await compareAndAdvanceRef(store, planning.workspace, {
        operationId: `advance-${operationId}`,
        kind: "integration.advance",
        status: "intent",
        job,
        ref: `refs/heads/${baseline.branch}`,
        expectedOld: base.commit,
        expectedNew: found.commit,
      });
      if (!advanced) continue; // New base requires a new merger session and validation.
      attempt.status = "integrated";
      attempt.integratedCommit = found.commit;
      const advanceError = (await store.getRun(runId))?.operations[
        `advance-${operationId}`
      ]?.error;
      if (advanceError) attempt.cleanupErrors = [advanceError.message];
      await saveIssueAttempt(store, initial, attempt);
      for (const owned of [attempt.operationId, operationId]) {
        try {
          await removeOwnedWorktree(store, planning.workspace, owned);
        } catch (cause) {
          attempt.cleanupErrors ??= [];
          attempt.cleanupErrors.push(String(cause));
        }
      }
      await saveIssueAttempt(store, initial, attempt);
      return attempt;
    }
    throw new Error(
      "Integration kept changing; retained candidates require revalidation",
    );
  } catch (cause) {
    attempt.error ??= {
      code: "baseline-blocked",
      message: String(cause),
      cause: String(cause),
    };
    if (attempt.status !== "integrated") failAttempt(attempt);
    await saveIssueAttempt(store, initial, attempt).catch(() => {});
  }
  return attempt;
}

/** Every public integration caller shares the repository run's serial queue. */
export function integrateIssue(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  issueId: string,
  options: AttemptOptions = {},
) {
  return integrationQueue(store, runId).enqueue(
    store,
    adapter,
    runId,
    issueId,
    options,
  );
}
