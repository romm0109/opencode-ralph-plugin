import type { Failure, JobEnvelope, UserInputRequest } from "../core/types.js";
export interface PlanningState {
  protocol?: "native-interview-v1";
  owner?: {
    stage: "interview" | "prd" | "issues";
    sessionId: string;
    attempt: number;
    retired?: boolean;
  };
  nativeQuestions?: string[];
  attempts?: {
    stage: "prd" | "issues";
    attempt: number;
    sessionId: string;
    job: JobEnvelope;
    messageId: string;
    prompt: string;
    draftRoot: string;
    remainingMs: number;
    controlEpoch: number;
    observedAt?: number;
    suspended?: boolean;
    status: "active" | "retired" | "accepted";
    reason?: Failure;
  }[];
  budgetResets?: {
    stage: "prd" | "issues";
    afterAttempt: number;
    explanationRevision: number;
    answer: Extract<import("../core/types.js").UserInputResult, { ok: true }>;
  }[];
  phase:
    | "interview"
    | "explanation_approval"
    | "explanation_approved"
    | "prd_generation"
    | "issue_generation"
    | "execution_approval"
    | "execution_approved";
  revisionProposal?: { text: string; scope: string[]; criteria: string[] };
  history?: {
    explanation?: PlanningState["explanation"];
    approval?: PlanningState["approval"];
    prd?: PlanningState["prd"];
    graph?: PlanningState["graph"];
    executionEligibility?: PlanningState["executionEligibility"];
  }[];
  decisions?: {
    stage: "prd" | "issues";
    attempt: number;
    request: UserInputRequest;
    answer?: Extract<import("../core/types.js").UserInputResult, { ok: true }>;
    revisedExplanation?: { text: string; scope: string[]; criteria: string[] };
  }[];
  scopeChange?: {
    issueId: string;
    requestId: string;
    affectedIssueIds: string[];
    integratedIssueIds: string[];
    previousPrd: NonNullable<PlanningState["prd"]>;
    previousGraph: NonNullable<PlanningState["graph"]>;
    previousApproval: NonNullable<PlanningState["executionEligibility"]>;
    prepared?: boolean;
  };
  selectedCommit?: string;
  publication?: {
    jobId: string;
    name: string;
    hash: string;
    status: "intent" | "completed";
  };
  prdAcceptance?: {
    sessionId: string;
    attempt: number;
    path: string;
    text: string;
    revision: ArtifactRevision;
  };
  managedArtifacts?: Record<string, string>;
  issueAcceptance?: {
    sessionId: string;
    attempt: number;
    graph: NonNullable<PlanningState["graph"]>;
    result?: { outcome: "accepted"; graph: ArtifactRevision };
  };
  issueHandoff?: {
    jobId: string;
    attempt: number;
    prd: ArtifactRevision;
    prompt: string;
    messageId: string;
    sessionId?: string;
    creationStarted?: boolean;
    queued?: boolean;
    focused?: boolean;
  };
  prd?: ArtifactRevision;
  graph?: ArtifactRevision & {
    order: string[];
    value: import("./graph.js").IssueGraph;
    files: Record<string, string>;
  };
  executionEligibility?: {
    explanationHash?: string;
    commandHash?: string;
    commandRevision?: number;
    revision: number;
    selectedCommit?: string;
    prdHash: string;
    graphHash: string;
    requestId: string;
    messageId: string;
    timestamp: string;
  };
  sessionId: string;
  workspace: string;
  feature: string;
  commandHash: string;
  settings: {
    concurrency: number;
    timeoutMs: number;
    agentTimeoutMs?: number;
    models: Record<string, NonNullable<JobEnvelope["model"]>>;
    skills: Record<string, { path: string; hash: string }>;
  };
  transcript: {
    source: "user" | "interviewer";
    text: string;
    messageId?: string;
    requestId?: string;
    revision?: number;
  }[];
  turn: number;
  explanation?: {
    revision: number;
    hash: string;
    text: string;
    scope: string[];
    criteria: string[];
  };
  approval?: {
    sha?: string;
    branch?: string;
    commandHash?: string;
    commandRevision?: number;
    sessionId?: string;
    timestamp?: string;
    revision: number;
    hash: string;
    messageId: string;
    requestId: string;
  };
  proposalContext?: {
    sha: string;
    branch: string;
    commandHash: string;
    commandRevision: number;
  };
  prdDelivery?: { id: string; text: string; status: "intent" | "queued" };
  pending?: UserInputRequest;
  error?: Failure;
}

export interface ArtifactRevision {
  revision: number;
  hash: string;
  artifactPath: string;
}
