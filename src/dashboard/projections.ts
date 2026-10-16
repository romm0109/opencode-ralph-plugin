import { sanitizeDisplay } from "../state/sanitize.js";

export { sanitizeDisplay } from "../state/sanitize.js";

import type { ExecutionEvidence, RunEvent, RunRecord } from "../core/types.js";

export type { CheckStatus, ExecutionEvidence } from "../core/types.js";
export interface RunSnapshot {
  schemaVersion: 1;
  runId: string;
  phase: string;
  planning: {
    stage: string;
    status: "writing" | "waiting" | "retrying" | "blocked" | "completed";
    owner: { sessionId: string; attempt: number; retired: boolean };
    waitingReason: string | null;
    attempts: {
      stage: string;
      attempt: number;
      sessionId: string;
      status: string;
      reason: string | null;
    }[];
  } | null;
  control?: { status: string; facts: string[] };
  revision: number;
  sequence: number;
  verification: "unavailable" | "incomplete" | "failed" | "passed";
  executionAvailable: boolean;
  completion: {
    outcome: string;
    branch: string;
    commit: string;
    repairCount: number;
    completedIssues: string[];
    blockedIssues: string[];
    repairedIssues: string[];
    attempts: { issueId: string; used: number }[];
    evidenceRefs: string[];
    skippedChecks: string[];
    unavailableReview: string[];
    retainedResourceCount: number;
    cleanupFailures: string[];
  } | null;
  reviewRounds: {
    round: number;
    commit: string;
    code: string;
    functional: string;
    findings: {
      id: string;
      role: string;
      criterion: string;
      blocking: boolean;
      disposition: string;
      evidence: string[];
    }[];
    criteria: {
      id: string;
      criterion: string;
      status: string;
      evidenceRefs: string[];
      reason: string;
    }[];
    infrastructureAttempts: number;
    repairs: { id: string; status: string; attempts: number }[];
  }[];
  issues: ExecutionEvidence["issues"];
  integrationQueue: string[];
  checks: ExecutionEvidence["checks"];
  agents: {
    jobId: string;
    issueId: string | null;
    role: string;
    attempt: number;
    sessionId: string | null;
    baseCommit: string;
    inputRevisions: Record<string, number>;
    status: string;
    logId: string | null;
    evidence: string[];
    error: { code: string; message: string } | null;
  }[];
  errors: { code: string; message: string }[];
}
export interface DashboardEvent {
  sequence: number;
  type: RunEvent["type"];
  timestamp: string;
  snapshot: RunSnapshot;
}
export interface LogPage {
  logId: string;
  offset: number;
  nextOffset: number | null;
  total: number;
  truncated: boolean;
  content: string;
}
export const MAX_LOG_CHARS = 64 * 1024;
export const MAX_PAGE_CHARS = 4096;
/** Never send prompts, environment, paths or raw SDK causes to the browser. */
export function logId(jobId: string, attempt: number): string {
  return `${jobId}--${attempt}`;
}
export function projectRunSnapshot(
  run: RunRecord,
  sequence = 0,
  secrets: readonly string[] = [],
): RunSnapshot {
  const execution = run.execution;
  const checks = execution?.checks ?? [];
  const safe = (s: string) =>
    sanitizeDisplay(s, secrets).slice(0, MAX_LOG_CHARS);
  const report = run.reviewWorkflow?.report;
  return {
    schemaVersion: 1,
    runId: run.runId,
    phase: run.phase,
    planning: projectPlanning(run, secrets),
    ...(run.control
      ? {
          control: {
            status: run.control.status,
            facts: (run.control.facts ?? []).map(safe),
          },
        }
      : {}),
    revision: run.revision,
    sequence,
    verification: report
      ? report.outcome === "verified"
        ? "passed"
        : report.outcome === "unresolved"
          ? "failed"
          : "incomplete"
      : !checks.length
        ? "unavailable"
        : execution?.verification === "failed" ||
            checks.some((c) => c.status === "failed")
          ? "failed"
          : execution?.verification === "passed" &&
              checks.every((c) => c.status === "passed")
            ? "passed"
            : "incomplete",
    completion: report
      ? {
          outcome: report.outcome,
          branch: safe(report.branch),
          commit: report.commit,
          repairCount: report.repairCount,
          completedIssues: report.completedIssues.map(safe),
          blockedIssues: report.blockedIssues.map(safe),
          repairedIssues: report.repairedIssues.map(safe),
          attempts: report.attempts.map((a) => ({
            issueId: safe(a.issueId),
            used: a.used,
          })),
          evidenceRefs: report.evidenceRefs.map(safe),
          skippedChecks: report.skippedChecks.map(
            (c) => `${safe(c.id)}: ${safe(c.reason ?? "missing validation")}`,
          ),
          unavailableReview: report.unavailableReview.map(safe),
          retainedResourceCount: report.retainedResources.length,
          cleanupFailures: report.cleanupFailures.map(safe),
        }
      : null,
    reviewRounds: (run.reviewWorkflow?.rounds ?? []).map((r) => ({
      round: r.snapshot.round,
      commit: r.snapshot.commit,
      code: r.code?.outcome ?? "waiting",
      functional: r.functional?.outcome ?? "waiting",
      findings: [
        ...(r.code?.findings ?? []),
        ...(r.functional?.findings ?? []),
      ].map((f) => ({
        id: safe(f.id),
        role: f.reviewerRole,
        criterion: safe(f.criterion),
        blocking: f.blocking,
        disposition: r.disputes.some(
          (d) =>
            d.finding.id === f.id &&
            d.finding.reviewerRole === f.reviewerRole &&
            d.disposition === "withdrawn",
        )
          ? "withdrawn"
          : f.disposition,
        evidence: f.evidence.map(safe),
      })),
      criteria:
        r.functional?.criteria.map((c) => ({
          id: safe(c.id),
          criterion: safe(c.criterion),
          status: c.status,
          evidenceRefs: c.evidenceRefs.map(safe),
          reason: safe(c.reason ?? ""),
        })) ?? [],
      infrastructureAttempts: r.functional?.attempts.length ?? 0,
      repairs: r.repairs.map((t) => ({
        id: t.id,
        status: t.status,
        attempts: t.attempts.length,
      })),
    })),
    executionAvailable: !!execution,
    issues:
      execution?.issues.map((i) => ({
        id: i.id,
        title: safe(i.title),
        dependencies: [...i.dependencies],
        status: i.status,
        blockers: [...i.blockers],
      })) ?? [],
    integrationQueue: [...(execution?.integrationQueue ?? [])],
    checks: checks.map((c) => ({
      id: c.id,
      status: c.status,
      attempt: c.attempt,
      candidateCommit: c.candidateCommit,
      commandRevision: c.commandRevision,
      ...(c.reason !== undefined ? { reason: safe(c.reason) } : {}),
    })),
    agents: Object.values(run.jobs).map(({ envelope: j, status, result }) => ({
      jobId: j.jobId,
      issueId: j.issueId ?? null,
      role: safe(j.role),
      attempt: j.attempt,
      sessionId: j.sessionId ?? null,
      baseCommit: j.baseCommit,
      inputRevisions: { ...j.inputRevisions },
      status: result?.outcome ?? (status === "intent" ? "waiting" : status),
      logId: result?.text !== undefined ? logId(j.jobId, j.attempt) : null,
      evidence: result?.evidence.map(safe) ?? [],
      error: result?.error
        ? { code: result.error.code, message: safe(result.error.message) }
        : null,
    })),
    errors: run.errors.map((e) => ({ code: e.code, message: safe(e.message) })),
  };
}

/** Deliberately excludes native question content, artifact paths and prompts. */
export function projectPlanning(
  run: RunRecord,
  secrets: readonly string[] = [],
): RunSnapshot["planning"] {
  const p = run.planning;
  if (p?.protocol !== "native-interview-v1" || !p.owner) return null;
  const safe = (text: string) =>
    sanitizeDisplay(text, secrets)
      .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;]+/g, "[path]")
      .slice(0, 1024);
  const completed =
    !!p.executionEligibility ||
    (p.owner.stage === "prd" &&
      p.prdAcceptance?.attempt === p.owner.attempt &&
      p.prdAcceptance.sessionId === p.owner.sessionId) ||
    (p.owner.stage === "issues" && !!p.issueAcceptance?.result);
  const retrying = !!p.owner.retired && !p.pending && p.owner.attempt < 3;
  const blocked = (!retrying && !!p.error) || run.control?.status === "blocked";
  const waiting =
    !!p.pending ||
    !!p.nativeQuestions?.length ||
    (run.control && run.control.status !== "active");
  return {
    stage: p.owner.stage,
    status: blocked
      ? "blocked"
      : completed
        ? "completed"
        : waiting
          ? "waiting"
          : p.owner.retired
            ? "retrying"
            : "writing",
    owner: {
      sessionId: safe(p.owner.sessionId),
      attempt: p.owner.attempt,
      retired: !!p.owner.retired,
    },
    waitingReason: p.error
      ? safe(p.error.message)
      : run.control && run.control.status !== "active"
        ? safe([run.control.status, ...(run.control.facts ?? [])].join(": "))
        : p.pending
          ? "Waiting for native question response"
          : p.nativeQuestions?.length
            ? "Waiting for native question response"
            : null,
    attempts: (p.attempts ?? []).map((a) => ({
      stage: a.stage,
      attempt: a.attempt,
      sessionId: safe(a.sessionId),
      status: a.status,
      reason: a.reason ? safe(a.reason.message) : null,
    })),
  };
}
