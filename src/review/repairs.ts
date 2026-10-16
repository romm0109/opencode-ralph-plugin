import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { correlatedResult } from "../agents/results.js";
import type { ExecutionEvidence, Failure } from "../core/types.js";
import { dispatchAttempt } from "../execution/attempts.js";
import { executeIssue } from "../execution/execute-issue.js";
import { integrateIssue } from "../execution/integrate-issue.js";
import {
  createReviewWorkspace,
  verifyFindingEvidence,
  verifyReviewWorkspace,
} from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import type { ReviewFinding, ReviewSnapshot } from "./types.js";

/** Dedicated repair specification; it never rewrites the approved feature graph. */
export interface IssueSpec {
  id: string;
  findingIds: string[];
  sources: ReviewFinding[];
  originalIssues: ExecutionEvidence["issues"];
  originalContext: { prd: string; graph: string };
  testBehaviors: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  tdd: true;
}
export interface RepairAttempt {
  attempt: number;
  workspace: string;
  baseCommit: string;
  candidateCommit?: string;
  checks?: ExecutionEvidence["checks"];
  status: "intent" | "integrating" | "failed" | "integrated" | "disputed";
  evidenceRefs: string[];
  error?: Failure;
}
export interface RepairTask extends IssueSpec {
  attempts: RepairAttempt[];
  status: "pending" | "integrated" | "unresolved" | "withdrawn";
}
export interface FindingDispute {
  finding: ReviewFinding;
  executorEvidence: string[];
  disposition: "withdrawn" | "retained";
  reviewerEvidence: string[];
  justification: string;
}
export interface RepairPipeline {
  /** The production executor records intent and allocates its own owned branch. */
  ownsWorkspaces?: boolean;
  /** Executes one complete TDD attempt, including expected red failures internally. */
  executeIssue(
    task: IssueSpec,
    context: {
      snapshot: ReviewSnapshot;
      workspace: string;
      attempt: number;
      baseCommit: string;
    },
  ): Promise<
    | { outcome: "candidate"; commit: string; evidenceRefs: string[] }
    | { outcome: "failed"; error: Failure; evidenceRefs: string[] }
    | { outcome: "disputed"; findingIds: string[]; evidenceRefs: string[] }
  >;
  /** Must use the normal isolated merger and approved candidate checks. */
  integrateIssue(
    task: IssueSpec,
    candidate: string,
    context: { workspace: string; attempt: number; baseCommit: string },
  ): Promise<
    | {
        outcome: "integrated";
        commit: string;
        checks: ExecutionEvidence["checks"];
        evidenceRefs: string[];
      }
    | { outcome: "failed"; error: Failure; evidenceRefs: string[] }
  >;
  clarifyFinding?(
    finding: ReviewFinding,
    evidence: string[],
    snapshot: ReviewSnapshot,
  ): Promise<{
    disposition: "withdrawn" | "retained";
    evidenceRefs: string[];
    justification: string;
  }>;
}
export function createRepairTasks(
  snapshot: ReviewSnapshot,
  findings: ReviewFinding[],
  originalIssues: ExecutionEvidence["issues"],
  originalContext: { prd: string; graph: string } = { prd: "", graph: "" },
): RepairTask[] {
  const groups = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    if (
      !finding.blocking ||
      finding.disposition !== "open" ||
      ["style", "refactor"].includes(finding.category)
    )
      continue;
    if (finding.reviewedCommit !== snapshot.commit)
      throw new Error("Finding is not tied to the frozen commit");
    // Conservative equivalence: same criterion and proposed behavior change, never prose similarity alone.
    const key = JSON.stringify([
      finding.criterion.trim().toLowerCase(),
      finding.suggestedRepair.trim().toLowerCase(),
    ]);
    const group = groups.get(key) ?? [];
    group.push(structuredClone(finding));
    groups.set(key, group);
  }
  const usedIds = new Set(originalIssues.map((issue) => issue.id));
  let sequence = 0;
  const nextId = () => {
    let id: string;
    do {
      id = `repair-${snapshot.round}-${++sequence}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  return [...groups.values()].map((sources) => ({
    id: nextId(),
    findingIds: sources.map((f) => `${f.reviewerRole}:${f.id}`),
    sources,
    originalIssues: structuredClone(originalIssues),
    originalContext: structuredClone(originalContext),
    testBehaviors: [...new Set(sources.map((f) => f.criterion))],
    acceptanceCriteria: [...new Set(sources.map((f) => f.suggestedRepair))],
    dependencies: [],
    tdd: true,
    attempts: [],
    status: "pending",
  }));
}
export async function resolveFindingDispute(
  finding: ReviewFinding,
  executorEvidence: string[],
  snapshot: ReviewSnapshot,
  clarify?: RepairPipeline["clarifyFinding"],
): Promise<FindingDispute> {
  const retained: FindingDispute = {
    finding,
    executorEvidence,
    disposition: "retained",
    reviewerEvidence: [],
    justification: "No evidence-based reviewer withdrawal",
  };
  if (!executorEvidence.length || !clarify) return retained;
  try {
    const response = await clarify(finding, executorEvidence, snapshot);
    if (
      !["withdrawn", "retained"].includes(response.disposition) ||
      !response.justification.trim() ||
      !response.evidenceRefs.length ||
      response.evidenceRefs.some((e) => !e.trim())
    )
      return retained;
    return {
      finding,
      executorEvidence,
      disposition: response.disposition,
      reviewerEvidence: response.evidenceRefs,
      justification: response.justification,
    };
  } catch {
    return retained;
  }
}

const findingDispute = z
  .object({
    kind: z.literal("finding_dispute"),
    findingIds: z.array(z.string().trim().min(1)).min(1),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
export function parseFindingDispute(raw: unknown, task: IssueSpec) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("kind" in raw) ||
    raw.kind !== "finding_dispute"
  )
    return undefined;
  const value = findingDispute.parse(raw);
  if (value.findingIds.some((id) => !task.findingIds.includes(id)))
    throw new Error("Dispute references an unrelated finding");
  return { findingIds: value.findingIds, evidenceRefs: value.evidenceRefs };
}

/** Reuse normal executor slots, TDD submission validation, merger queue and checks. */
export function createRepairPipeline(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
): RepairPipeline {
  return {
    ownsWorkspaces: true,
    async clarifyFinding(finding, evidence, snapshot) {
      const run = await store.getRun(runId);
      const round = run?.reviewWorkflow?.rounds.at(-1);
      if (
        !round ||
        round.snapshot.commit !== snapshot.commit ||
        round.snapshot.round !== snapshot.round
      )
        throw new Error("Stale dispute clarification");
      const origin =
        finding.reviewerRole === "code-review" ? round.code : round.functional;
      const operationId = `finding-clarify-${randomUUID()}`;
      const job = {
        runId,
        jobId: operationId,
        role: finding.reviewerRole,
        attempt: 1,
        workspace: join(store.root, "review-workspaces", operationId),
        baseCommit: snapshot.commit,
        readOnly: true,
        inputRevisions: { round: snapshot.round },
        ...(run?.planning?.settings.models[finding.reviewerRole]
          ? { model: run.planning.settings.models[finding.reviewerRole] }
          : {}),
        prompt: `Reconsider this finding as the originating reviewer role. One clarification exchange only. Inspect the frozen commit and supplied counterexample; withdraw only with evidence. Return JSON {disposition: "withdrawn" | "retained", evidenceRefs: string[], justification: string}.\n${JSON.stringify({ snapshot, finding, executorEvidence: evidence, originalReview: origin, inputs: run?.review?.inputs })}`,
      };
      const operation = {
        operationId,
        kind: "review.workspace" as const,
        status: "intent" as const,
        job,
      };
      if (!(await store.recordOperation(operation)))
        throw new Error("Dispute intent rejected");
      try {
        await createReviewWorkspace(
          run?.baseline?.workspace ?? job.workspace,
          job.workspace,
          snapshot.commit,
        );
        await store.recordOperation({ ...operation, status: "completed" });
      } catch (cause) {
        await store.recordOperation({
          ...operation,
          status: "failed",
          error: { code: "setup-failed", message: String(cause) },
        });
        throw cause;
      }
      const result = await dispatchAttempt(
        store,
        adapter,
        job,
        run?.planning?.settings.agentTimeoutMs ?? 1800000,
        {},
      );
      await verifyReviewWorkspace(job.workspace, snapshot.commit);
      const clarification = z
        .object({
          disposition: z.enum(["withdrawn", "retained"]),
          evidenceRefs: z.array(z.string().trim().min(1)).min(1),
          justification: z.string().trim().min(1),
        })
        .strict()
        .parse(correlatedResult(job, result));
      await verifyFindingEvidence(
        job.workspace,
        snapshot.commit,
        clarification.evidenceRefs,
        [...snapshot.evidenceRefs, ...(origin?.evidenceRefs ?? [])],
      );
      return clarification;
    },
    async executeIssue(task, context) {
      const attempt = await executeIssue(store, adapter, runId, task.id);
      if (
        attempt.attempt !== context.attempt ||
        attempt.job.workspace !== context.workspace ||
        attempt.job.baseCommit !== context.baseCommit
      )
        throw new Error("Repair execution identity mismatch");
      if (attempt.findingDispute)
        return { outcome: "disputed", ...attempt.findingDispute };
      if (attempt.status === "submitted" && attempt.submission)
        return {
          outcome: "candidate",
          commit: attempt.submission.submittedCommit,
          evidenceRefs: [
            `executor:${attempt.job.jobId}:TDD`,
            ...(attempt.executionResult?.evidence ?? []),
          ],
        };
      return {
        outcome: "failed",
        error:
          attempt.error ??
          (attempt.status === "waiting"
            ? {
                code: "cancelled",
                message: "Repair executor awaits human input",
                cause: attempt.question,
              }
            : {
                code: "missing-output",
                message: "Repair executor did not submit a TDD candidate",
              }),
        evidenceRefs: attempt.executionResult?.evidence ?? [],
      };
    },
    async integrateIssue(task, candidate, context) {
      const before = (await store.getRun(runId))?.issueAttempts?.[task.id];
      if (
        before?.submission?.submittedCommit !== candidate ||
        before.attempt !== context.attempt
      )
        throw new Error("Repair integration identity mismatch");
      const attempt = await integrateIssue(store, adapter, runId, task.id);
      if (
        attempt.status === "integrated" &&
        attempt.integratedCommit &&
        attempt.validation
      )
        return {
          outcome: "integrated",
          commit: attempt.integratedCommit,
          checks: attempt.validation.checks.map((check) => ({
            id: check.id,
            status: check.status,
            ...(check.reason ? { reason: check.reason } : {}),
            attempt: attempt.attempt,
            candidateCommit: attempt.integratedCommit as string,
            commandRevision: attempt.validation?.commandRevision ?? 0,
          })),
          evidenceRefs: [`merger:${attempt.candidate?.job.jobId}:checks`],
        };
      return {
        outcome: "failed",
        error: attempt.error ?? {
          code: "missing-output",
          message: "Repair candidate was not integrated",
        },
        evidenceRefs: attempt.candidate?.result?.evidence ?? [],
      };
    },
  };
}
