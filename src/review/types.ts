import type { ExecutionEvidence, Failure } from "../core/types.js";
import type { RunStore } from "../state/run-store.js";
import type { FunctionalReviewResult } from "./functional-results.js";

/** Review identity projection; full approved graph and issue text live in inputs. */
export interface IssueGraph {
  revision: string;
  issues: { id: string }[];
}
export type ValidationSummary = ExecutionEvidence["checks"];
export interface ReviewSnapshot {
  runId: string;
  round: number;
  commit: string;
  prdRevision: string;
  graphRevision: string;
  evidenceRefs: string[];
}
export interface ReviewFinding {
  id: string;
  reviewerRole: "code-review" | "functional-review";
  reviewedCommit: string;
  category:
    | "correctness"
    | "security"
    | "acceptance"
    | "regression"
    | "style"
    | "refactor";
  blocking: boolean;
  criterion: string;
  evidence: string[];
  suggestedRepair: string;
  disposition: "open" | "withdrawn" | "resolved";
}
export interface ReviewResult {
  role: "code-review" | "functional-review";
  reviewedCommit: string;
  round: number;
  outcome: "passed" | "findings" | "unverified";
  findings: ReviewFinding[];
  evidenceRefs: string[];
  sessionId?: string;
  error?: Failure;
}
export interface ExecutorTddEvidence {
  issueId: string;
  attempt: number;
  submittedCommit: string;
  tdd: import("../agents/results.js").Submission["tdd"];
  native?: import("../opencode/adapter.js").JobToolEvidence;
  previousAttempts?: {
    attempt: number;
    native: import("../opencode/adapter.js").JobToolEvidence;
  }[];
}
export interface ReviewInputs {
  tddEvidence?: ExecutorTddEvidence[];
  baseCommit: string;
  prd: string;
  graph: string;
  diff: string;
  tests: ValidationSummary;
  execution: ExecutionEvidence;
}
export interface StoredReview {
  snapshot: ReviewSnapshot;
  inputs: ReviewInputs;
  superseded?: boolean;
  result?: ReviewResult;
  functionalResult?: FunctionalReviewResult;
  summary?: string;
}
export interface SnapshotOptions {
  adapter?: import("../opencode/adapter.js").OpenCodeAdapter;
  store: RunStore;
  directory: string;
  runId: string;
  round: number;
  commit: string;
  baseCommit: string;
  prdRevision: string;
  graph: IssueGraph;
  evidenceRefs: string[];
  prdPath?: string;
  graphPath?: string;
  /** Read hash-verified approved planning artifacts instead of committed fixtures. */
  approvedPlanning?: boolean;
}
