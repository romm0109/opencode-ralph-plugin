import type { PlanningState } from "../planning/types.js";
import type { OwnedProcess } from "../process/ownership.js";
import type { ReviewWorkflow } from "../reporting/completion.js";
import type { StoredReview } from "../review/types.js";
export type CheckStatus =
  | "waiting"
  | "running"
  | "failed"
  | "skipped"
  | "passed";
/** Evidence supplied by execution; the dashboard never computes scheduler policy. */
export interface ExecutionEvidence {
  /** Execution must attest that the required validation set is complete. */
  verification?: "incomplete" | "failed" | "passed";
  /** Scheduler attestation: checks settled; final review is still pending. */
  reviewPending?: boolean;
  issues: {
    id: string;
    title: string;
    dependencies: string[];
    status:
      | "pending"
      | "ready"
      | "running"
      | "integration_queued"
      | "integrated"
      | "blocked"
      | "failed";
    blockers: string[];
  }[];
  integrationQueue: string[];
  checks: {
    id: string;
    status: CheckStatus;
    reason?: string;
    attempt: number;
    candidateCommit: string;
    commandRevision: number;
  }[];
}
export interface JobEnvelope {
  runId: string;
  jobId: string;
  attempt: number;
  role: string;
  issueId?: string;
  sessionId?: string;
  workspace: string;
  inputRevisions: Record<string, number>;
  baseCommit: string;
  prompt: string;
  readOnly?: boolean;
  observationTools?: string[];
  /** Values allocated by the approved lifecycle for this owned job. */
  environment?: Record<string, string>;
  model?: { providerID: string; modelID: string };
}
export interface Failure {
  code:
    | "agent-timeout"
    | "setup-failed"
    | "baseline-blocked"
    | "invalid-review"
    | "permission-denied"
    | "sdk-error"
    | "missing-output"
    | "unsupported"
    | "cancelled";
  message: string;
  cause?: unknown;
}
export interface JobResult extends JobEnvelope {
  outcome: "completed" | "needs_input" | "failed" | "denied" | "cancelled";
  question?: {
    kind: "needs_input";
    question: string;
    recommendedAnswer: string;
    affectedRequirement: string;
  };
  text?: string;
  evidence: string[];
  producedCommit?: string;
  error?: Failure;
}
export interface RunControl {
  epoch?: number;
  cleanupPending?: boolean;
  status: "active" | "paused" | "stopped" | "interrupted" | "blocked";
  source: "human" | "shutdown" | "recovery";
  facts?: string[];
}
export interface RunOperation {
  operationId: string;
  kind:
    | "issue.workspace"
    | "candidate.workspace"
    | "issue.cleanup"
    | "candidate.cleanup"
    | "baseline.workspace"
    | "baseline.cleanup"
    | "project.commands"
    | "process.spawn"
    | "integration.advance"
    | "validation.check"
    | "session.abort"
    | "run.release"
    | "review.pin"
    | "review.workspace"
    | "review.publish"
    | "execution.environment"
    | "execution.environment.cleanup"
    | "review.environment"
    | "review.cleanup";
  job: JobEnvelope;
  status: "intent" | "completed" | "failed";
  error?: Failure;
  ownedProcess?: OwnedProcess;
  environment?: {
    ownerId: string;
    directory: string;
    values: Record<string, string>;
    exclusiveResources: string[];
  };
  ref?: string;
  expectedOld?: string;
  expectedNew?: string;
  checks?: ExecutionEvidence["checks"];
}
export interface RunRecord {
  issueAttempts?: Record<
    string,
    import("../execution/execute-issue.js").IssueAttempt
  >;
  baseline?: import("../execution/preflight.js").BaselineState;
  validationSkips?: string[];
  planning?: PlanningState;
  schemaVersion: 1;
  runId: string;
  repositoryId: string;
  revision: number;
  phase: "ready" | "running" | "completed" | "failed" | "cancelled";
  jobs: Record<
    string,
    {
      envelope: JobEnvelope;
      status: "intent" | "running" | "terminal";
      result?: JobResult;
      nativeEvidence?: import("../opencode/adapter.js").JobToolEvidence;
    }
  >;
  control?: RunControl;
  execution?: ExecutionEvidence;
  review?: StoredReview;
  reviewWorkflow?: ReviewWorkflow;
  lastResult?: JobResult;
  errors: Failure[];
  operations: Record<string, RunOperation>;
}
export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  revision: number;
  eventId: string;
  type:
    | "issue.changed"
    | "baseline.changed"
    | "planning.changed"
    | "run.control"
    | "review.workflow"
    | "review.snapshot"
    | "review.result"
    | "execution.observed"
    | "run.created"
    | "job.intent"
    | "job.session"
    | "job.result"
    | "job.evidence"
    | "operation.intent"
    | "operation.result";
  timestamp: string;
  jobId?: string;
  attempt?: number;
  sessionId?: string;
  commit?: string;
  snapshot: RunRecord;
}
export interface UserInputRequest {
  kind?:
    | "feature"
    | "interview"
    | "explanation"
    | "product"
    | "planning-recovery"
    | "existing-run";
  options?: { label: string; description: string }[];
  recommendation?: string;
  runId: string;
  sessionId: string;
  workspace: string;
  requestId: string;
  revision: number;
  /** Kept short: OpenCode forms do not scroll, so long text hides the options. */
  question: string;
  /** Full context shown in the chat right before the form, when it is long. */
  details?: string;
}
export type UserInputResult =
  | {
      ok: true;
      requestId: string;
      revision: number;
      sessionId: string;
      messageId: string;
      text: string;
      source: "user";
    }
  | { ok: false; error: Failure };
