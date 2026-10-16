import { join } from "node:path";
import type { ExecutionEvidence, RunRecord } from "../core/types.js";
import type { FunctionalReviewResult } from "../review/functional-results.js";
import type { FindingDispute, RepairTask } from "../review/repairs.js";
import type {
  ReviewFinding,
  ReviewResult,
  ReviewSnapshot,
} from "../review/types.js";
export interface ReviewRound {
  snapshot: ReviewSnapshot;
  code?: ReviewResult;
  functional?: FunctionalReviewResult;
  repairs: RepairTask[];
  disputes: FindingDispute[];
  validation: ExecutionEvidence;
}
export interface ReviewWorkflow {
  ownerId: string;
  branch: string;
  commit: string;
  status: "running" | "terminal";
  rounds: ReviewRound[];
  report?: CompletionReport;
}
export interface CompletionReport {
  outcome: "verified" | "incomplete-validation" | "unverified" | "unresolved";
  branch: string;
  commit: string;
  rounds: ReviewRound[];
  completedIssues: string[];
  blockedIssues: string[];
  repairCount: number;
  repairedIssues: string[];
  attempts: { issueId: string; used: number }[];
  findings: ReviewFinding[];
  evidenceRefs: string[];
  skippedChecks: ExecutionEvidence["checks"];
  unavailableReview: string[];
  retainedResources: string[];
  cleanupFailures: string[];
}
export function buildCompletionReport(run: RunRecord): CompletionReport {
  const workflow = run.reviewWorkflow;
  if (!workflow) throw new Error("No coordinated review evidence");
  const last = workflow.rounds.at(-1);
  const withdrawn = new Set(
    last?.disputes
      .filter((d) => d.disposition === "withdrawn")
      .map((d) => `${d.finding.reviewerRole}:${d.finding.id}`),
  );
  const findings = [
    ...(last?.code?.findings ?? []),
    ...(last?.functional?.findings ?? []),
  ].map((f) => ({
    ...f,
    disposition: withdrawn.has(`${f.reviewerRole}:${f.id}`)
      ? ("withdrawn" as const)
      : f.disposition,
  }));
  const cleanedWorkspaces = new Set(
    Object.values(run.operations)
      .filter(
        (o) =>
          ["issue.cleanup", "candidate.cleanup", "baseline.cleanup"].includes(
            o.kind,
          ) && o.status === "completed",
      )
      .map((o) => o.job.workspace),
  );
  const checks = run.execution?.checks ?? [];
  const skippedChecks = [
    ...checks,
    ...workflow.rounds.flatMap((r) => [
      ...r.validation.checks,
      ...r.repairs.flatMap((task) =>
        task.attempts.flatMap((attempt) => attempt.checks ?? []),
      ),
    ]),
  ].filter((c) => c.status === "skipped");
  const unavailableReview = [
    ...(!last?.code || last.code.outcome === "unverified" || last.code.error
      ? [`Code review: ${last?.code?.error?.message ?? "missing verification"}`]
      : []),
    ...(!last?.functional ||
    last.functional.outcome === "unverified" ||
    last.functional.error
      ? [
          `Functional review: ${last?.functional?.error?.message ?? "missing verification"}`,
        ]
      : []),
    ...(last?.functional?.criteria
      .filter((c) => c.status === "unverified")
      .map((c) => `${c.id}: ${c.reason}`) ?? []),
  ];
  const repairs = workflow.rounds.flatMap((r) => r.repairs);
  const repairIds = new Set(repairs.map((r) => r.id));
  const blockedIssues =
    run.execution?.issues
      .filter((i) => i.status !== "integrated")
      .map((i) => i.id) ?? [];
  const unresolved =
    blockedIssues.length ||
    findings.some((f) => f.blocking && f.disposition === "open") ||
    last?.functional?.criteria.some(
      (c) => c.status === "fail" && !withdrawn.has(`functional-review:${c.id}`),
    ) ||
    repairs.some((r) => r.status === "unresolved") ||
    checks.some((c) => c.status === "failed");
  const incomplete =
    skippedChecks.length > 0 ||
    last?.validation.verification !== "passed" ||
    !checks.length ||
    checks.some(
      (c) => c.status !== "passed" || c.candidateCommit !== workflow.commit,
    ) ||
    run.execution?.verification === "failed" ||
    !last?.functional?.criteria.length;
  return {
    outcome: unresolved
      ? "unresolved"
      : unavailableReview.length
        ? "unverified"
        : incomplete
          ? "incomplete-validation"
          : "verified",
    branch: workflow.branch,
    commit: workflow.commit,
    rounds: structuredClone(workflow.rounds),
    completedIssues:
      run.execution?.issues
        .filter((i) => i.status === "integrated")
        .map((i) => i.id) ?? [],
    blockedIssues,
    repairCount: repairs.length,
    repairedIssues: repairs
      .filter((r) => r.status === "integrated")
      .map((r) => r.id),
    attempts: [
      ...new Map(
        [
          ...Object.values(run.jobs)
            .filter(
              (j) =>
                j.envelope.role === "executor" &&
                !repairIds.has(j.envelope.issueId ?? ""),
            )
            .map((j) => ({
              issueId: j.envelope.issueId ?? j.envelope.jobId,
              used: j.envelope.attempt,
            })),
          ...repairs.map((r) => ({ issueId: r.id, used: r.attempts.length })),
        ]
          .sort((a, b) => a.used - b.used)
          .map((a) => [a.issueId, a]),
      ).values(),
    ],
    findings,
    evidenceRefs: [
      ...new Set(
        workflow.rounds.flatMap((r) => [
          ...r.snapshot.evidenceRefs,
          ...(r.code?.evidenceRefs ?? []),
          ...(r.functional?.evidenceRefs ?? []),
          ...r.repairs.flatMap((t) =>
            t.attempts.flatMap((a) => a.evidenceRefs),
          ),
        ]),
      ),
    ],
    skippedChecks: [
      ...new Map(skippedChecks.map((c) => [JSON.stringify(c), c])).values(),
    ],
    unavailableReview,
    retainedResources: [
      ...new Set(
        [
          ...Object.values(run.operations)
            .filter(
              (o) =>
                [
                  "review.workspace",
                  "baseline.workspace",
                  "issue.workspace",
                  "candidate.workspace",
                ].includes(o.kind) && o.status === "completed",
            )
            .map((o) => o.job.workspace),
          ...repairs.flatMap((r) => r.attempts.map((a) => a.workspace)),
          ...(run.baseline?.workspace ? [run.baseline.workspace] : []),
          join(run.repositoryId, "ralph", "runs"),
        ].filter((workspace) => !cleanedWorkspaces.has(workspace)),
      ),
    ],
    cleanupFailures: [
      ...new Set([
        ...Object.values(run.operations)
          .filter((o) => o.kind.endsWith(".cleanup") && o.status === "failed")
          .map((o) => o.error?.message ?? o.operationId),
        ...Object.values(run.issueAttempts ?? {}).flatMap(
          (a) => a.cleanupErrors ?? [],
        ),
      ]),
    ],
  };
}
