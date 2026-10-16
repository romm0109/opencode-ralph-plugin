import type { Failure } from "../core/types.js";
import type { ReviewResult, ReviewSnapshot } from "./types.js";
export interface FunctionalCriterion {
  id: string;
  criterion: string;
  coverage: ("browser" | "http" | "log")[];
}
export interface FunctionalCriterionResult extends FunctionalCriterion {
  status: "pass" | "fail" | "not-applicable" | "unverified";
  evidenceRefs: string[];
  reason?: string;
}
export interface FunctionalEvidence {
  id: string;
  kind: "browser" | "http" | "log";
  summary: string;
  reviewedCommit: string;
  screenshot?: string;
}
export interface FunctionalReviewResult extends ReviewResult {
  evidence: FunctionalEvidence[];
  role: "functional-review";
  criteria: FunctionalCriterionResult[];
  attempts: { attempt: number; evidenceRefs: string[]; blocker?: Failure }[];
}
export function createFunctionalChecklist(
  prd: string,
  graph: string,
  surfaces: { ui: boolean; http: boolean },
): FunctionalCriterion[] {
  const coverage: FunctionalCriterion["coverage"] = [];
  if (surfaces.ui) coverage.push("browser");
  if (surfaces.http) coverage.push("http");
  if (!coverage.length) coverage.push("log");
  const criteria: FunctionalCriterion[] = [];
  let acceptance = false;
  for (const line of prd.split("\n")) {
    if (/^#{1,6}\s/.test(line)) acceptance = /acceptance/i.test(line);
    const match =
      /^\s*[-*]\s+\[[ xX]\]\s+(.+)/.exec(line) ??
      (acceptance ? /^\s*(?:[-*]|\d+[.)])\s+(.+)/.exec(line) : null);
    if (match?.[1])
      criteria.push({
        id: `prd-${criteria.length + 1}`,
        criterion: match[1],
        coverage: [...coverage],
      });
  }
  const issues = JSON.parse(graph).issues;
  for (const issue of issues ?? []) {
    for (const [index, criterion] of (
      issue.acceptanceCriteria ?? []
    ).entries()) {
      if (typeof criterion !== "string" || !criterion.trim())
        throw new Error("Invalid issue acceptance criterion");
      criteria.push({
        id: `issue-${issue.id}-${index + 1}`,
        criterion,
        coverage: [...coverage],
      });
    }
  }
  if (
    !criteria.length ||
    new Set(criteria.map((c) => c.id)).size !== criteria.length
  )
    throw new Error("No complete acceptance checklist available");
  return criteria;
}
export function parseFunctionalReviewResult(
  text: string,
  snapshot: ReviewSnapshot,
  checklist: FunctionalCriterion[],
): FunctionalReviewResult {
  const raw = JSON.parse(text);
  if (
    raw.reviewedCommit !== snapshot.commit ||
    raw.round !== snapshot.round ||
    !Array.isArray(raw.criteria) ||
    raw.criteria.length !== checklist.length
  )
    throw new Error("Functional result does not match snapshot/checklist");
  const evidence: FunctionalEvidence[] = raw.evidence ?? [];
  if (
    !Array.isArray(evidence) ||
    new Set(evidence.map((e) => e.id)).size !== evidence.length ||
    evidence.some(
      (e) =>
        typeof e.id !== "string" ||
        !e.id.trim() ||
        !["browser", "http", "log"].includes(e.kind) ||
        typeof e.summary !== "string" ||
        !e.summary.trim() ||
        e.reviewedCommit !== snapshot.commit ||
        (e.screenshot !== undefined &&
          (typeof e.screenshot !== "string" || !e.screenshot.trim())),
    )
  )
    throw new Error("Invalid observation evidence");
  const criteria = checklist.map((criterion) => {
    const matches = raw.criteria.filter(
      (item: { id?: string }) => item.id === criterion.id,
    );
    const item = matches[0];
    if (
      matches.length !== 1 ||
      !["pass", "fail", "not-applicable", "unverified"].includes(item.status) ||
      !Array.isArray(item.evidenceRefs) ||
      item.evidenceRefs.some(
        (ref: unknown) => typeof ref !== "string" || !ref.trim(),
      )
    )
      throw new Error("Invalid criterion result");
    if (["pass", "fail"].includes(item.status)) {
      if (
        !item.evidenceRefs.length ||
        !Array.isArray(item.coverage) ||
        !item.coverage.length ||
        item.coverage.some(
          (surface: "browser" | "http" | "log") =>
            !criterion.coverage.includes(surface),
        ) ||
        (item.status === "pass" &&
          criterion.coverage.some(
            (surface) => !item.coverage.includes(surface),
          ))
      )
        throw new Error(
          "Observed criterion needs evidence and planned coverage",
        );
      if (
        item.coverage.some(
          (surface: string) =>
            !evidence.some(
              (e) => item.evidenceRefs.includes(e.id) && e.kind === surface,
            ),
        )
      )
        throw new Error(
          "Criterion evidence does not support observation coverage",
        );
    }
    if (
      item.evidenceRefs.some(
        (ref: string) => !evidence.some((e) => e.id === ref),
      )
    )
      throw new Error("Unknown observation evidence reference");
    if (
      ["not-applicable", "unverified"].includes(item.status) &&
      (typeof item.reason !== "string" || !item.reason.trim())
    )
      throw new Error("Untested criterion needs explicit justification");
    return {
      ...criterion,
      status: item.status,
      coverage: ["pass", "fail"].includes(item.status) ? item.coverage : [],
      evidenceRefs: item.evidenceRefs,
      ...(item.reason ? { reason: item.reason } : {}),
    } as FunctionalCriterionResult;
  });
  const findings = criteria
    .filter((c) => c.status === "fail")
    .map((c) => ({
      id: c.id,
      reviewerRole: "functional-review" as const,
      reviewedCommit: snapshot.commit,
      category: "acceptance" as const,
      blocking: true,
      criterion: c.criterion,
      evidence: c.evidenceRefs,
      suggestedRepair: c.reason ?? "Repair the observed acceptance failure",
      disposition: "open" as const,
    }));
  return {
    role: "functional-review",
    reviewedCommit: snapshot.commit,
    round: snapshot.round,
    outcome: findings.length
      ? "findings"
      : criteria.some((c) => c.status === "unverified")
        ? "unverified"
        : "passed",
    findings,
    criteria,
    evidence,
    evidenceRefs: criteria.flatMap((c) => c.evidenceRefs),
    attempts: [],
  };
}
