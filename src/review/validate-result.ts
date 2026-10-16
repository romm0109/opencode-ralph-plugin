import type { ReviewFinding, ReviewResult, ReviewSnapshot } from "./types.js";

const categories = [
  "correctness",
  "security",
  "acceptance",
  "regression",
  "style",
  "refactor",
];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function refs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text);
}
/** Prose is never a verdict. Agent-controlled identity and dispositions are checked. */
export function validateReviewResult(
  raw: string,
  snapshot: ReviewSnapshot,
): ReviewResult {
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    value.role !== "code-review" ||
    value.reviewedCommit !== snapshot.commit ||
    value.round !== snapshot.round ||
    !["passed", "findings", "unverified"].includes(String(value.outcome)) ||
    !Array.isArray(value.findings) ||
    !refs(value.evidenceRefs)
  ) {
    throw new Error(
      "Malformed review result, wrong commit/round, or missing evidence",
    );
  }
  const ids = new Set<string>();
  const findings: ReviewFinding[] = value.findings.map((finding: unknown) => {
    if (
      !object(finding) ||
      !text(finding.id) ||
      ids.has(finding.id) ||
      finding.reviewerRole !== "code-review" ||
      finding.reviewedCommit !== snapshot.commit ||
      !categories.includes(String(finding.category)) ||
      typeof finding.blocking !== "boolean" ||
      !text(finding.criterion) ||
      !refs(finding.evidence) ||
      !text(finding.suggestedRepair) ||
      finding.disposition !== "open"
    )
      throw new Error(
        "Malformed finding: identity, criterion, repair and evidence are required",
      );
    ids.add(finding.id);
    const blocking = ["style", "refactor"].includes(String(finding.category))
      ? false
      : finding.blocking;
    if (
      blocking &&
      !finding.evidence.some(
        (ref) =>
          /^\S+:\d+\b/.test(ref) ||
          snapshot.evidenceRefs.some(
            (known) => ref === known || ref.startsWith(`${known}:`),
          ),
      )
    )
      throw new Error(
        "Blocking finding must cite a concrete source location or supplied evidence reference",
      );
    return {
      id: finding.id,
      reviewerRole: "code-review",
      reviewedCommit: snapshot.commit,
      category: finding.category as ReviewFinding["category"],
      blocking,
      criterion: finding.criterion,
      evidence: finding.evidence,
      suggestedRepair: finding.suggestedRepair,
      disposition: "open",
    };
  });
  const blocking = findings.some((finding) => finding.blocking);
  if (value.outcome === "passed" && blocking)
    throw new Error("Passing verdict contradicts blocking findings");
  if (value.outcome === "findings" && !findings.length)
    throw new Error("Findings verdict has no findings");
  return {
    role: "code-review",
    reviewedCommit: snapshot.commit,
    round: snapshot.round,
    outcome:
      value.outcome === "unverified"
        ? "unverified"
        : blocking
          ? "findings"
          : "passed",
    findings,
    evidenceRefs: value.evidenceRefs,
  };
}
