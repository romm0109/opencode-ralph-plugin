import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  OpenCode,
  type OpenCodeClient,
  type SessionApi,
  type V2Event,
} from "@opencode/client";
import { executorQuestionSchema } from "../agents/results.js";
import type {
  Failure,
  JobEnvelope,
  JobResult,
  UserInputRequest,
  UserInputResult,
} from "../core/types.js";
import { artifactHash } from "../planning/artifacts.js";
import type { RunStore } from "../state/run-store.js";
import { runtimeSecretValues, sanitizeValue } from "../state/sanitize.js";
import { ralphBridge } from "./bridge.js";

export interface JobToolEvidence {
  source: "opencode.session.context";
  sessionId: string;
  promptMessageId?: string;
  resultMessageId?: string;
  observations: {
    messageId: string;
    callId: string;
    tool: string;
    input: string;
    output: string;
    exitCode?: number;
    truncated: boolean;
  }[];
  unavailableReason?: string;
  omittedObservationCount?: number;
}

export interface OpenCodeAdapter {
  inspectStagePrompt?(
    sessionId: string,
    messageId: string,
    text: string,
  ): Promise<"present" | "missing" | "unknown">;
  cancelStageSession?(
    job: JobEnvelope,
  ): Promise<{ ok: boolean; error?: Failure }>;
  findIssueSession?(
    workspace: string,
    runId: string,
    jobId: string,
    attempt: number,
  ): Promise<string | undefined>;
  createIssueSession?(
    workspace: string,
    runId: string,
    jobId: string,
    attempt: number,
    model: NonNullable<JobEnvelope["model"]>,
  ): Promise<string>;
  inspectPlanningTurn?(
    sessionId: string,
    messageId: string,
  ): Promise<
    | "running"
    | "settled"
    | "failed"
    | "unknown"
    | { status: "failed"; error: Failure }
  >;
  queueStagePrompt?(sessionId: string, id: string, text: string): Promise<void>;
  createInterviewSession?(
    workspace: string,
    runId: string,
    model: NonNullable<JobEnvelope["model"]>,
  ): Promise<string>;
  focusStageSession?(
    workspace: string,
    runId: string,
    sessionId: string,
    stage?: "interview" | "issues",
  ): Promise<void>;
  observeJob?(
    job: JobEnvelope,
    options?: { persist?: boolean },
  ): Promise<JobToolEvidence>;
  finalizeExecution?(
    snapshot: import("../review/types.js").ReviewSnapshot,
  ): Promise<unknown>;
  getSessionModel?(sessionId: string): Promise<JobEnvelope["model"]>;
  /** Explicit host permission; no SDK denial may fall back to direct execution. */
  authorizeCommand?(request: {
    job: JobEnvelope;
    command: import("../config/commands.js").CommandSpec;
    hash: string;
  }): Promise<{ ok: boolean; error?: Failure }>;
  inspectSession?(
    job: JobEnvelope,
  ): Promise<"idle" | "busy" | "missing" | "unknown">;
  discoverTools?(workspace: string): Promise<string[]>;
  dispatchJob(job: JobEnvelope): Promise<JobResult>;
  cancelJob(job: JobEnvelope): Promise<{ ok: boolean; error?: Failure }>;
  requestUserInput(request: UserInputRequest): Promise<UserInputResult>;
  publishProgress?(
    runId: string,
    sessionId: string,
    workspace: string,
    id: string,
    text: string,
  ): Promise<{ ok: boolean; error?: Failure }>;
  publishStatus(
    sessionId: string,
    workspace: string,
    text: string,
  ): Promise<{ ok: boolean; error?: Failure }>;
  receiveEvent(event: V2Event): Promise<void>;
}

export interface AdapterHost {
  focusStageSession?(
    workspace: string,
    runId: string,
    sessionId: string,
    stage?: "interview" | "issues",
  ): Promise<void>;
  requestUserInput?(request: UserInputRequest): Promise<UserInputResult>;
  assertCommandPermission?(
    sessionId: string,
    command: import("../config/commands.js").CommandSpec,
    hash: string,
  ): Promise<void>;
  session: Pick<
    SessionApi,
    "create" | "get" | "prompt" | "wait" | "context" | "interrupt"
  > &
    Partial<Pick<SessionApi, "active" | "list" | "inbox" | "synthetic">>;
  tools(workspace: string): Promise<string[]>;
  prepareReview(workspace: string, tools: string[]): Promise<void>;
  notify(workspace: string, text: string): Promise<void>;
}

export function createAdapterClient(
  baseUrl: string,
  fetch?: (input: Request) => Promise<Response>,
  headers?: RequestInit["headers"],
): OpenCodeClient & AdapterHost {
  const client = OpenCode.make({
    baseUrl,
    ...(headers ? { headers } : {}),
    ...(fetch
      ? {
          fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
            fetch(new Request(input, init))) as typeof globalThis.fetch,
        }
      : {}),
  });
  const bridge = client.rpc(ralphBridge);
  return Object.assign(client, {
    tools: (workspace: string) =>
      bridge.tools({}, { location: { directory: workspace } }),
    prepareReview: async (workspace: string, tools: string[]) => {
      await bridge.prepareReview(
        { tools },
        { location: { directory: workspace } },
      );
    },
    notify: async (workspace: string, text: string) => {
      await bridge.publishStatus(
        { text },
        { location: { directory: workspace } },
      );
    },
  });
}

type SessionHistory = Awaited<ReturnType<SessionApi["context"]>>;
function backgroundPending(history: SessionHistory) {
  const shells = history.flatMap((message) =>
    message.type === "assistant"
      ? message.content
          .filter(
            (part) =>
              part.type === "tool" &&
              part.state.status === "completed" &&
              part.state.metadata?.status === "running" &&
              typeof part.state.metadata.shellID === "string",
          )
          .map((part) =>
            part.type === "tool" && part.state.status === "completed"
              ? part.state.metadata?.shellID
              : undefined,
          )
      : [],
  );
  if (!shells.length) return false;
  const lastIdle = history.reduce(
    (last, message, index) => (message.type === "idle" ? index : last),
    -1,
  );
  return shells.some((id) => {
    const completed = history.reduce(
      (last, message, index) =>
        message.type === "shell" &&
        message.shellID === id &&
        message.status !== "running"
          ? index
          : last,
      -1,
    );
    return completed < 0 || lastIdle <= completed;
  });
}

function statusOf(cause: unknown): number | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const value = cause as { status?: number; cause?: unknown };
  return (
    value.status ?? (value.cause !== cause ? statusOf(value.cause) : undefined)
  );
}
function failure(cause: unknown): Failure {
  const message =
    cause instanceof Error
      ? cause.message
      : (JSON.stringify(cause) ?? "Unknown SDK failure");
  return {
    code:
      (statusOf(cause) === 403 &&
        !/provider.auth|FreeTierError/i.test(message)) ||
      /permission.*(denied|rejected)|PermissionDenied|not allowed|declined/i.test(
        message,
      )
        ? "permission-denied"
        : "sdk-error",
    message,
    cause:
      cause instanceof Error
        ? { name: cause.name, message: cause.message, status: statusOf(cause) }
        : cause,
  };
}

// Only observation tools may execute in review sessions. Shell and delegation
// remain excluded even if supplied as observation tools.
export function reviewTools(job: JobEnvelope): Set<string> {
  return new Set([
    "read",
    "glob",
    "grep",
    "list",
    ...(job.role === "functional-review"
      ? (job.observationTools ?? []).filter(
          (name) =>
            ![
              "edit",
              "write",
              "patch",
              "apply_patch",
              "bash",
              "shell",
              "subagent",
              "opencode",
              "execute",
              "ralph_control",
            ].includes(name),
        )
      : []),
  ]);
}
export function reviewToolAlias(name: string) {
  return `ralph_review_${name}`;
}

export function createOpenCodeAdapter(
  client: AdapterHost,
  store: RunStore,
): OpenCodeAdapter {
  async function finish(job: JobEnvelope, error: Failure): Promise<JobResult> {
    const result: JobResult = {
      ...job,
      outcome: error.code === "permission-denied" ? "denied" : "failed",
      error,
      evidence: [],
    };
    await store.recordResult(result);
    const current = (await store.getRun(job.runId))?.jobs[job.jobId];
    return current?.envelope.attempt === job.attempt && current.result
      ? current.result
      : { ...job, outcome: "cancelled", evidence: [] };
  }
  async function abortSession(
    job: JobEnvelope,
  ): Promise<{ ok: boolean; error?: Failure }> {
    if (!job.sessionId) return { ok: true };
    // Keep the durable operation name so old journals remain readable.
    const operation = {
      operationId: randomUUID(),
      kind: "session.abort" as const,
      job,
      status: "intent" as const,
    };
    await store.recordOperation(operation);
    let error: Failure | undefined;
    try {
      await client.session.interrupt({ sessionID: job.sessionId });
    } catch (cause) {
      error = failure(cause);
    }
    await store.recordOperation({
      ...operation,
      status: error ? "failed" : "completed",
      ...(error ? { error } : {}),
    });
    return error ? { ok: false, error } : { ok: true };
  }
  const adapter: OpenCodeAdapter = {
    cancelStageSession: abortSession,
    async inspectStagePrompt(sessionId, messageId, text) {
      if (!client.session.inbox) return "unknown";
      try {
        const queued = await client.session.inbox.list({
          sessionID: sessionId,
        });
        const history = await client.session.context({ sessionID: sessionId });
        const matches = [...queued, ...history].filter(
          (m) => m.id === messageId,
        );
        if (!matches.length) return "missing";
        // Stable IDs correlate effects; the host owns message bytes and provenance.
        return matches.every(
          (m) =>
            m.type === "user" &&
            ("payload" in m ? m.payload.text : m.text) === text,
        )
          ? "present"
          : "unknown";
      } catch {
        return "unknown";
      }
    },
    async findIssueSession(workspace, runId, jobId, attempt) {
      if (!client.session.list)
        throw new Error("Session metadata reconciliation is unavailable");
      let cursor: string | undefined;
      const matches: string[] = [];
      do {
        const page = await client.session.list({
          directory: workspace,
          ...(cursor ? { cursor } : {}),
        });
        for (const session of page.data) {
          const metadata = session.metadata?.ralph as
            | { runId?: string; jobId?: string; attempt?: number }
            | undefined;
          if (
            metadata?.runId === runId &&
            metadata.jobId === jobId &&
            metadata.attempt === attempt
          )
            matches.push(session.id);
        }
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      if (matches.length > 1)
        throw new Error(
          "Multiple correlated issue sessions; inspect /ralph-status",
        );
      return matches[0];
    },
    async createIssueSession(workspace, runId, jobId, attempt, model) {
      const session = await client.session.create({
        id: `ses_${artifactHash(JSON.stringify([runId, jobId, attempt])).slice(0, 32)}`,
        location: { directory: workspace },
        title: `Ralph issues ${runId}`,
        model: { providerID: model.providerID, id: model.modelID },
        metadata: {
          ralph: { runId, jobId, attempt },
          ralphStage: { runId, stage: "issues", attempt },
        },
      });
      return session.id;
    },
    async createInterviewSession(workspace, runId, model) {
      const session = await client.session.create({
        location: { directory: workspace },
        title: `Ralph interview ${runId}`,
        model: { providerID: model.providerID, id: model.modelID },
        metadata: { ralphStage: { runId, stage: "interview", attempt: 1 } },
      });
      return session.id;
    },
    async focusStageSession(workspace, runId, sessionId, stage = "interview") {
      await client.focusStageSession?.(workspace, runId, sessionId, stage);
    },
    async authorizeCommand({ job, command, hash }) {
      if (!job.sessionId || !client.assertCommandPermission)
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Host command permission assertion is unavailable",
          },
        };
      try {
        await client.assertCommandPermission(job.sessionId, command, hash);
        return { ok: true };
      } catch (cause) {
        return { ok: false, error: failure(cause) };
      }
    },
    async inspectSession(job) {
      if (!job.sessionId) return "missing";
      try {
        const session = await client.session.get({ sessionID: job.sessionId });
        const history = await client.session.context({
          sessionID: job.sessionId,
        });
        if (backgroundPending(history)) return "busy";
        if (client.session.active) {
          const active = await client.session.active();
          return active[job.sessionId] ? "busy" : "idle";
        }
        if (session.outcome) return "idle";
        return history.at(-1)?.type === "idle" ? "idle" : "unknown";
      } catch (cause) {
        return statusOf(cause) === 404 ? "missing" : "unknown";
      }
    },
    async observeJob(job, options = {}) {
      const entry = (await store.getRun(job.runId))?.jobs[job.jobId];
      const evidence: JobToolEvidence = {
        source: "opencode.session.context",
        sessionId: entry?.envelope.sessionId ?? "",
        observations: [],
      };
      if (
        !entry?.envelope.sessionId ||
        entry.envelope.attempt !== job.attempt ||
        entry.envelope.role !== "executor" ||
        entry.envelope.baseCommit !== job.baseCommit ||
        entry.envelope.workspace !== job.workspace ||
        entry.result?.outcome !== "completed" ||
        entry.result.sessionId !== entry.envelope.sessionId
      )
        return {
          ...evidence,
          unavailableReason: "No correlated completed executor session",
        };
      if (entry.nativeEvidence) return entry.nativeEvidence;
      try {
        const history = await client.session.context({
          sessionID: entry.envelope.sessionId,
        });
        const end = history.findIndex(
          (message) =>
            message.type === "assistant" &&
            entry.result?.evidence.includes(message.id),
        );
        let start = -1;
        for (let index = 0; index < end; index++)
          if (history[index]?.type === "user") start = index;
        if (start < 0 || end <= start)
          return {
            ...evidence,
            unavailableReason:
              "Delivered prompt or attested final message is absent from native history",
          };
        const promptMessageId = history[start]?.id;
        const resultMessageId = history[end]?.id;
        if (!promptMessageId || !resultMessageId)
          return {
            ...evidence,
            unavailableReason: "Attested native message IDs are absent",
          };
        evidence.promptMessageId = promptMessageId;
        evidence.resultMessageId = resultMessageId;
        for (const message of history.slice(start + 1, end + 1)) {
          if (message.type !== "assistant") continue;
          for (const part of message.content) {
            if (
              part.type !== "tool" ||
              !["completed", "error"].includes(part.state.status)
            )
              continue;
            const input = "input" in part.state ? part.state.input : undefined;
            if (!input || typeof input !== "object") continue;
            const command = "command" in input ? input.command : undefined;
            const path = "path" in input ? input.path : undefined;
            const relevant =
              (part.name === "shell" &&
                typeof command === "string" &&
                /\bbun\s+(?:(?:run\s+)?test\b|--version\b)/.test(command) &&
                !command.includes("--help")) ||
              (["read", "ralph_review_read"].includes(part.name) &&
                typeof path === "string" &&
                /(?:red|green|tdd).*\.(?:log|md|txt)$/i.test(path));
            if (!relevant) continue;
            const output =
              part.state.status === "error"
                ? part.state.error.message
                : part.state.status === "completed"
                  ? part.state.content
                      .filter((item) => item.type === "text")
                      .map((item) => item.text)
                      .join("\n")
                  : "";
            const rawInput = JSON.stringify(input);
            const exit =
              part.state.status === "completed"
                ? part.state.metadata?.exit
                : undefined;
            evidence.observations.push({
              messageId: message.id,
              callId: part.id,
              tool: part.name,
              input: rawInput.slice(0, 4096),
              output:
                output.length > 8192
                  ? output.slice(0, 4096) +
                    "\n[...truncated...]\n" +
                    output.slice(-4096)
                  : output,
              ...(typeof exit === "number" ? { exitCode: exit } : {}),
              truncated: output.length > 8192 || rawInput.length > 4096,
            });
          }
        }
        if (evidence.observations.length > 32) {
          evidence.omittedObservationCount = evidence.observations.length - 32;
          evidence.observations = [
            ...evidence.observations.slice(0, 16),
            ...evidence.observations.slice(-16),
          ];
        }
        if (options.persist && evidence.observations.length)
          await store.recordJobEvidence(entry.envelope, evidence);
        return evidence;
      } catch (cause) {
        return {
          ...evidence,
          unavailableReason: `Native tool history unavailable: ${String(cause)}`,
        };
      }
    },
    async getSessionModel(sessionId) {
      const session = await client.session.get({ sessionID: sessionId });
      return session.model
        ? { providerID: session.model.providerID, modelID: session.model.id }
        : undefined;
    },
    async inspectPlanningTurn(sessionId, messageId) {
      try {
        const history = await client.session.context({ sessionID: sessionId });
        const index = history.findIndex((message) => message.id === messageId);
        if (index < 0) return "unknown";
        const turn = history.slice(index + 1);
        const idle = turn.find((message) => message.type === "idle");
        if (idle?.type === "idle") {
          if (idle.outcome === "succeeded") return "settled";
          return {
            status: "failed",
            error: idle.error
              ? failure(idle.error)
              : {
                  code:
                    idle.outcome === "interrupted" ? "cancelled" : "sdk-error",
                  message: `OpenCode planning turn ${idle.outcome}`,
                },
          };
        }
        const failed = turn.find(
          (message) => message.type === "assistant" && message.error,
        );
        if (failed?.type === "assistant" && failed.error)
          return { status: "failed", error: failure(failed.error) };
        return "running";
      } catch {
        return "unknown";
      }
    },
    async queueStagePrompt(sessionId, id, text) {
      // Reconcile a lost inbox receipt before resending the stable message ID.
      if (id.startsWith("msg_ralph-issues-")) {
        if (!client.session.inbox)
          throw new Error("Stage inbox reconciliation unavailable");
        const queued = await client.session.inbox.list({
          sessionID: sessionId,
        });
        if (queued.some((message) => message.id === id)) return;
        const history = await client.session.context({ sessionID: sessionId });
        if (history.some((message) => message.id === id)) return;
      }
      // prompt returns an inbox receipt, not completion of the active turn.
      await client.session.prompt({
        sessionID: sessionId,
        id,
        text,
        delivery: "queue",
        metadata: { ralphCommand: true },
      });
    },
    discoverTools: (workspace) => client.tools(workspace),
    async dispatchJob(job) {
      const saved = await store.getRun(job.runId);
      if (saved?.planning && saved.planning.protocol !== "native-interview-v1")
        return {
          ...job,
          outcome: "failed",
          evidence: [],
          error: {
            code: "unsupported",
            message: "Unsupported saved workflow; a fresh workflow is required",
          },
        };
      if (!(await store.recordIntent(job))) {
        const existing = (await store.getRun(job.runId))?.jobs[job.jobId];
        if (existing?.envelope.attempt === job.attempt && existing.result)
          return existing.result;
        return {
          ...job,
          outcome: "failed",
          error: {
            code: "sdk-error",
            message: "Duplicate or stale dispatch; no side effect performed",
          },
          evidence: [],
        };
      }
      let bound = job;
      try {
        const planning = (await store.getRun(job.runId))?.planning;
        const interviewSession =
          job.role === "interview" &&
          planning?.protocol === "native-interview-v1" &&
          planning.owner?.sessionId === job.sessionId &&
          planning.owner?.attempt === job.attempt
            ? job.sessionId
            : undefined;
        if (
          planning?.protocol === "native-interview-v1" &&
          job.role === "interview" &&
          !interviewSession
        )
          throw new Error("Stale interview session ownership");
        if (job.readOnly && !interviewSession)
          await client.prepareReview(job.workspace, [...reviewTools(job)]);
        const created = interviewSession
          ? { id: interviewSession }
          : await client.session.create({
              location: { directory: job.workspace },
              title: `Ralph ${job.runId}/${job.jobId}/${job.attempt}`,
              ...(job.model
                ? {
                    model: {
                      providerID: job.model.providerID,
                      id: job.model.modelID,
                    },
                  }
                : {}),
              metadata: {
                ralph: {
                  runId: job.runId,
                  jobId: job.jobId,
                  attempt: job.attempt,
                },
              },
            });
        bound = { ...job, sessionId: created.id };
        if (!(await store.attachSession(job, created.id))) {
          const abort = await abortSession(bound);
          return {
            ...bound,
            outcome: "cancelled",
            evidence: [],
            ...(abort.error ? { error: abort.error } : {}),
          };
        }
        const textInput =
          job.readOnly && !interviewSession
            ? `${job.prompt}\nUse the observation tools prefixed ralph_review_ (for example ralph_review_read). Other tools are unavailable in this review session.`
            : job.prompt;
        async function cancelled(interrupt = true) {
          const current = (await store.getRun(job.runId))?.jobs[job.jobId];
          if (
            current?.envelope.attempt === job.attempt &&
            current.status === "running"
          )
            return;
          if (interrupt) await abortSession(bound);
          return (
            current?.result ?? {
              ...bound,
              outcome: "cancelled" as const,
              evidence: [],
            }
          );
        }
        const beforePrompt = await cancelled();
        if (beforePrompt) return beforePrompt;
        const prompt = await client.session.prompt({
          sessionID: created.id,
          text: textInput,
        });
        const afterPrompt = await cancelled();
        if (afterPrompt) return afterPrompt;
        if (prompt.sessionID !== created.id)
          return finish(bound, {
            code: "missing-output",
            message: "OpenCode returned an uncorrelated prompt receipt",
          });
        // v2 acknowledges the inbox item immediately. Waiting is a barrier, not
        // success evidence; inspect the completed turn behind the same receipt.
        let history: SessionHistory;
        for (;;) {
          await client.session.wait({ sessionID: created.id });
          history = await client.session.context({ sessionID: created.id });
          const cancellation = await cancelled(false);
          if (cancellation) return cancellation;
          if (!backgroundPending(history)) break;
          await Bun.sleep(100);
        }
        const start = history.findIndex(
          (message) => message.id === prompt.id && message.type === "user",
        );
        if (start < 0)
          return finish(bound, {
            code: "missing-output",
            message: "No correlated delivered prompt in session context",
          });
        const turn = history.slice(start + 1);
        if (
          turn.some(
            (message) =>
              message.type === "user" || message.type === "synthetic",
          )
        )
          return finish(bound, {
            code: "missing-output",
            message: "Session received another input before result collection",
          });
        const assistants = turn.filter(
          (message) => message.type === "assistant",
        );
        const tools = assistants
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool");
        const denied = tools.find(
          (part) =>
            part.state.status === "error" &&
            failure(part.state.error).code === "permission-denied",
        );
        if (denied && denied.state.status === "error")
          return finish(bound, failure(denied.state.error));
        const failedTool = tools.find(
          (part) =>
            (part.state.status === "error" &&
              !(
                (["read", "ralph_review_read"].includes(part.name) ||
                  (bound.role === "command-discovery" &&
                    bound.readOnly &&
                    [
                      "grep",
                      "glob",
                      "list",
                      "ralph_review_grep",
                      "ralph_review_glob",
                      "ralph_review_list",
                    ].includes(part.name))) &&
                /File not found|ENOENT|No such file|^Search path does not exist:/i.test(
                  part.state.error.message,
                )
              )) ||
            part.name === "invalid" ||
            (part.state.status === "completed" &&
              (part.state.metadata?.error === true ||
                (Array.isArray(part.state.metadata?.toolCalls) &&
                  part.state.metadata.toolCalls.some(
                    (call) =>
                      call &&
                      typeof call === "object" &&
                      "status" in call &&
                      call.status === "error",
                  )))),
        );
        if (failedTool)
          return finish(bound, {
            code: "sdk-error",
            message:
              failedTool.state.status === "error"
                ? failedTool.state.error.message
                : "OpenCode reported an invalid or failed tool call",
            cause: failedTool,
          });
        const idle = [...turn]
          .reverse()
          .find((message) => message.type === "idle");
        if (idle?.type === "idle" && idle.outcome !== "succeeded")
          return finish(
            bound,
            idle.error
              ? failure(idle.error)
              : {
                  code:
                    idle.outcome === "interrupted" ? "cancelled" : "sdk-error",
                  message: `OpenCode session ${idle.outcome}`,
                },
          );
        const assistant = assistants.at(-1);
        if (assistant?.error) return finish(bound, failure(assistant.error));
        const text = assistant?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (
          !assistant?.time.completed ||
          !text ||
          assistant.finish !== "stop" ||
          idle?.type !== "idle" ||
          idle.outcome !== "succeeded"
        )
          return finish(bound, {
            code: "missing-output",
            message: "No completed correlated assistant text response",
          });
        let question: JobResult["question"];
        if (job.role === "executor") {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            /* Submission parsing owns other output validation. */
          }
          if (
            raw &&
            typeof raw === "object" &&
            "kind" in raw &&
            raw.kind === "needs_input"
          )
            question = executorQuestionSchema.parse(raw);
        }
        const result: JobResult = {
          ...bound,
          outcome: question ? "needs_input" : "completed",
          ...(question ? { question } : {}),
          text,
          evidence: [assistant.id],
        };
        await store.recordResult(result);
        if (job.role === "executor")
          await adapter.observeJob?.(bound, { persist: true });
        const current = (await store.getRun(job.runId))?.jobs[job.jobId];
        return current?.envelope.attempt === job.attempt && current.result
          ? current.result
          : { ...bound, outcome: "cancelled", evidence: [] };
      } catch (cause) {
        return finish(bound, failure(cause));
      }
    },
    async cancelJob(job) {
      const entry = (await store.getRun(job.runId))?.jobs[job.jobId];
      if (!entry || entry.envelope.attempt !== job.attempt)
        return {
          ok: false,
          error: { code: "sdk-error", message: "Unknown or stale job" },
        };
      if (entry.status === "terminal")
        return entry.result?.outcome === "cancelled"
          ? abortSession(entry.envelope)
          : { ok: true };
      await store.recordResult({
        ...entry.envelope,
        outcome: "cancelled",
        evidence: [],
        error: { code: "cancelled", message: "Cancellation requested" },
      });
      return abortSession(entry.envelope);
    },
    async requestUserInput(request) {
      if (client.requestUserInput) {
        try {
          return await client.requestUserInput(request);
        } catch (cause) {
          return { ok: false, error: failure(cause) };
        }
      }
      return {
        ok: false,
        error: {
          code: "unsupported",
          message:
            "This host adapter has no native human-input channel. Supply requestUserInput or use the installed OpenCode plugin. Assistant or API-created messages cannot approve a gate.",
        },
      };
    },
    async publishProgress(runId, sessionId, workspace, id, text) {
      const run = await store.getRun(runId);
      if (
        run?.planning?.protocol !== "native-interview-v1" ||
        run.planning.owner?.sessionId !== sessionId
      )
        return {
          ok: false,
          error: {
            code: "permission-denied",
            message: "Visible workflow session ownership changed",
          },
        };
      if (!client.session.synthetic)
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Host synthetic progress unavailable",
          },
        };
      try {
        if (
          (await realpath(run.planning.workspace)) !==
          (await realpath(workspace))
        )
          return {
            ok: false,
            error: {
              code: "permission-denied",
              message: "Progress belongs to another project location",
            },
          };
        await client.session.synthetic({
          sessionID: sessionId,
          id,
          text: sanitizeValue(text, runtimeSecretValues()).slice(0, 16000),
          description: "Ralph workflow progress",
          resume: false,
        });
        return { ok: true };
      } catch (cause) {
        return { ok: false, error: failure(cause) };
      }
    },
    async publishStatus(_sessionId, workspace, text) {
      try {
        await client.notify(
          workspace,
          sanitizeValue(text, runtimeSecretValues()).slice(0, 16000),
        );
        return { ok: true };
      } catch (cause) {
        return { ok: false, error: failure(cause) };
      }
    },
    async receiveEvent(event) {
      if (event.type !== "permission.replied" || event.data.reply !== "reject")
        return;
      for (const run of await store.listRuns()) {
        for (const entry of Object.values(run.jobs)) {
          if (
            entry.status !== "terminal" &&
            entry.envelope.sessionId === event.data.sessionID
          )
            await finish(entry.envelope, {
              code: "permission-denied",
              message: "OpenCode permission rejected",
              cause: event.data,
            });
        }
      }
    },
  };
  return adapter;
}
