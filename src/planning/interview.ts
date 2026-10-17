import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadRoleInstructions } from "../agents/skills.js";
import {
  assertProjectConfigured,
  projectStatus,
} from "../commands/project-setup.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import type { JobEnvelope, JobResult, UserInputResult } from "../core/types.js";
import {
  readReviewGit,
  verifyReviewRepository,
} from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import type { PlanningState } from "./types.js";

const output = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("question"),
      question: z.string().min(1),
      recommendation: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("explanation"),
      text: z.string().min(1),
      scope: z.array(z.string().min(1)).min(1),
      criteria: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export interface InterviewOptions {
  workspace: string;
  sessionId: string;
  feature?: string;
  store: RunStore;
  adapter: OpenCodeAdapter;
}
async function save(
  store: RunStore,
  runId: string,
  revision: number,
  state: PlanningState,
) {
  if (!(await store.recordPlanning(runId, revision, state)))
    throw new Error("Stale interview transition");
}
/** Human provenance and the persisted request are the only approval authority. */
export async function handleInterviewResponse(
  store: RunStore,
  runId: string,
  response: UserInputResult,
): Promise<boolean> {
  const run = await store.getRun(runId);
  const state = run?.planning;
  const pending = state?.pending;
  if (
    !run ||
    !state ||
    state.protocol !== "native-interview-v1" ||
    !pending ||
    !response.ok ||
    response.source !== "user" ||
    !response.messageId ||
    !response.text.trim() ||
    response.requestId !== pending.requestId ||
    response.revision !== pending.revision ||
    response.sessionId !== pending.sessionId ||
    state.transcript.some((entry) => entry.messageId === response.messageId)
  )
    return false;
  const next = structuredClone(state);
  delete next.pending;
  delete next.error;
  next.transcript.push({
    source: "user",
    text: response.text,
    messageId: response.messageId,
    requestId: response.requestId,
    revision: response.revision,
  });
  if (state.phase === "explanation_approval") {
    const explanation = state.explanation;
    if (state.protocol === "native-interview-v1") {
      const context = state.proposalContext;
      const config = await loadProjectConfig(state.workspace);
      if (
        !context ||
        state.owner?.sessionId !== response.sessionId ||
        pending.kind !== "explanation" ||
        context.sha !==
          (
            await readReviewGit(state.workspace, ["rev-parse", "HEAD"])
          ).trim() ||
        context.branch !==
          (
            await readReviewGit(state.workspace, [
              "rev-parse",
              "--abbrev-ref",
              "HEAD",
            ])
          ).trim() ||
        context.commandHash !== commandConfigHash(config.commands) ||
        context.commandRevision !== config.commands.revision
      )
        return false;
    }
    if (!explanation || explanation.revision !== response.revision)
      return false;
    if (response.text.trim() === pending.options?.[0]?.label) {
      next.phase = "explanation_approved";
      next.approval = {
        ...state.proposalContext,
        sessionId: response.sessionId,
        timestamp: new Date().toISOString(),
        revision: explanation.revision,
        hash: explanation.hash,
        messageId: response.messageId,
        requestId: response.requestId,
      };
    } else {
      next.phase = "interview";
      if (next.owner) next.owner.stage = "interview";
      delete next.prdDelivery;
      delete next.approval;
    }
  } else if (pending.kind === "feature" || !next.feature)
    next.feature = response.text;
  return store.recordPlanning(runId, run.revision, next);
}
const INTERVIEW_TICK_MS = 250;

export async function continueInterview(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
  instructions: string,
) {
  for (;;) {
    const run = await store.getRun(runId);
    if (!run?.planning) throw new Error("Unknown planning run");
    if (run.planning.protocol !== "native-interview-v1")
      throw new Error(
        "Unsupported saved workflow; a fresh workflow is required",
      );
    const state = structuredClone(run.planning);
    if (
      createHash("sha256").update(instructions).digest("hex") !==
      state.settings.skills.interview?.hash
    )
      throw new Error(
        "Interview instructions differ from the captured run hash. Restore the selected skill before continuing.",
      );
    if (
      state.phase === "explanation_approved" ||
      (state.protocol === "native-interview-v1" &&
        state.owner?.stage === "prd") ||
      (run.control && run.control.status !== "active")
    )
      return run;
    if (state.pending) {
      const published = await adapter.publishStatus(
        state.sessionId,
        state.workspace,
        state.pending.question,
      );
      const response: UserInputResult = published.ok
        ? await adapter.requestUserInput(state.pending)
        : {
            ok: false,
            error: published.error ?? {
              code: "sdk-error",
              message: "Could not publish question",
            },
          };
      if (!response.ok) {
        const latest = await store.getRun(runId);
        if (latest?.planning?.pending?.requestId === state.pending.requestId)
          await save(store, runId, latest.revision, {
            ...latest.planning,
            error: response.error ?? {
              code: "sdk-error",
              message: "Could not publish question",
            },
          });
        return store.getRun(runId);
      }
      if (!(await handleInterviewResponse(store, runId, response)))
        return store.getRun(runId);
      continue;
    }
    state.turn++;
    await save(store, runId, run.revision, state);
    const selectedModel = state.settings.models.interview;
    if (!selectedModel)
      throw new Error("Planning run has no captured interview model");
    const job: JobEnvelope = {
      runId,
      jobId: `interview-${state.turn}`,
      attempt: 1,
      role: "interview",
      workspace: state.workspace,
      baseCommit: "",
      inputRevisions: {
        interview: state.turn,
        explanation: state.explanation?.revision ?? 0,
      },
      readOnly: true,
      sessionId: state.sessionId,
      model: selectedModel,
      prompt: `${instructions}\nFeature: ${state.feature}\nTranscript: ${JSON.stringify(state.transcript)}\nPrevious explanation: ${JSON.stringify(state.explanation ?? null)}\nStage identity: runId=${runId}, attempt=${state.owner?.attempt ?? 1}. Finish with ralph_complete_interview.`,
    };
    // The interviewer waits for human answers inside its turn. Only time spent
    // without a pending native question counts toward the turn deadline.
    let timer: ReturnType<typeof setInterval> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      let active = 0;
      timer = setInterval(async () => {
        const planning = (await store.getRun(runId))?.planning;
        if (planning?.nativeQuestions?.length || planning?.pending) return;
        active += INTERVIEW_TICK_MS;
        if (active >= state.settings.timeoutMs) resolve(undefined);
      }, INTERVIEW_TICK_MS);
    });
    let result: JobResult | undefined;
    try {
      result = await Promise.race([
        adapter.dispatchJob(job).catch(
          (cause): JobResult => ({
            ...job,
            outcome: "failed",
            evidence: [],
            error: {
              code: "sdk-error",
              message: "Interview dispatch failed",
              cause: String(cause),
            },
          }),
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearInterval(timer);
    }
    if (!result) {
      const timed = await store.getRun(runId);
      if (
        timed?.planning &&
        timed.planning.turn === state.turn &&
        (!timed.control || timed.control.status === "active")
      ) {
        await save(store, runId, timed.revision, {
          ...timed.planning,
          error: {
            code: "cancelled",
            message: `Interview timed out after ${state.settings.timeoutMs}ms`,
          },
        });
        await store.recordControl(runId, {
          status: "interrupted",
          source: "recovery",
          facts: [
            "Interview timed out; inspect the correlated session before resuming.",
          ],
        });
        await adapter.cancelJob(job);
      }
      return store.getRun(runId);
    }
    const latest = await store.getRun(runId);
    if (
      !latest?.planning ||
      latest.planning.turn !== state.turn ||
      latest.planning.pending ||
      latest.planning.phase !== "interview" ||
      (latest.control && latest.control.status !== "active")
    )
      return latest;
    const next = structuredClone(latest.planning);
    if (result.outcome !== "completed" || !result.text) {
      next.error = result.error ?? {
        code: "missing-output",
        message: "Interview returned no output",
      };
      await save(store, runId, latest.revision, next);
      return store.getRun(runId);
    }
    let parsed: z.infer<typeof output>;
    try {
      parsed = output.parse(JSON.parse(result.text));
      if (
        parsed.kind === "explanation" &&
        /(?:ASD[\s-]*)?STE[\s-]*100/i.test(
          [parsed.text, ...parsed.scope, ...parsed.criteria].join(" "),
        )
      )
        throw new Error(
          "Use simplified English without formal STE compliance claims.",
        );
    } catch (cause) {
      next.error = {
        code: "missing-output",
        message: `Invalid interview output. Return a recommended question or an explanation with scope and criteria. ${String(cause)}`,
        cause: String(cause),
      };
      await save(store, runId, latest.revision, next);
      return store.getRun(runId);
    }
    if (parsed.kind === "explanation") return latest;
    next.transcript.push({ source: "interviewer", text: result.text });
    const question = `${parsed.question}\nRecommended: ${parsed.recommendation}`;
    next.pending = {
      runId,
      sessionId: next.sessionId,
      workspace: next.workspace,
      requestId: randomUUID(),
      revision: next.explanation?.revision ?? 0,
      question,
      kind: "interview",
      recommendation: parsed.recommendation,
    };
    await save(store, runId, latest.revision, next);
  }
}
export async function startInterview(options: InterviewOptions) {
  const { store, adapter, sessionId } = options;
  const workspace = await realpath(options.workspace);
  await verifyReviewRepository(workspace, store.repositoryId);
  await assertProjectConfigured(workspace);
  const config = await loadProjectConfig(workspace);
  const skill = await loadRoleInstructions(
    workspace,
    "interview",
    config.skillPaths,
  );
  const model =
    config.models.interview ?? (await adapter.getSessionModel?.(sessionId));
  if (!model)
    throw new Error(
      "Main session model is unavailable. Set models.interview in .ralph/project.json.",
    );
  if (
    !adapter.createInterviewSession ||
    !(await adapter.discoverTools?.(workspace))?.includes("question")
  )
    throw new Error(
      "OpenCode native question capability is unavailable. Enable the question tool before starting /ralph-orchestrator.",
    );
  for (const existing of await store.listRuns()) {
    if (
      existing.planning &&
      existing.control?.status !== "stopped" &&
      existing.phase !== "completed" &&
      !Object.values(existing.operations).some(
        (op) => op.kind === "run.release" && op.status === "completed",
      )
    ) {
      if (existing.planning.protocol !== "native-interview-v1")
        throw new Error(
          "Unsupported planning protocol owns this repository. Inspect /ralph-status and settle /ralph-stop before starting fresh; no migration is available.",
        );
      throw new Error(
        `Interview ${existing.runId} already owns this repository (${existing.planning.phase}). Inspect /ralph-status; use /ralph-stop before starting a fresh interview.`,
      );
    }
  }
  const lock = join(store.root, "active-run.lock");
  try {
    await mkdir(lock);
  } catch (cause) {
    throw new Error(
      "A feature run already owns this repository. Inspect /ralph-status; interrupted locks require reconciliation.",
      { cause },
    );
  }
  const runId = `feature-${randomUUID()}`;
  let created = false;
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ runId, repositoryId: store.repositoryId }),
    );
    await assertProjectConfigured(workspace);
    const setup = await projectStatus(workspace);
    if (!setup.hash || setup.hash !== commandConfigHash(config.commands))
      throw new Error(
        "Configuration changed during interview startup; verify project commands again",
      );
    const run = await store.createRun(runId);
    created = true;
    const interviewSession = await adapter.createInterviewSession(
      workspace,
      runId,
      model,
    );
    await save(store, runId, run.revision, {
      protocol: "native-interview-v1" as const,
      owner: {
        stage: "interview" as const,
        sessionId: interviewSession,
        attempt: 1,
      },
      pending: {
        kind: "feature" as const,
        runId,
        workspace,
        sessionId: interviewSession,
        requestId: randomUUID(),
        revision: 0,
        options: options.feature?.trim()
          ? [
              {
                label: options.feature.trim(),
                description: "Confirm this feature, or enter your changes",
              },
            ]
          : [],
        question:
          "What feature should we build? Describe the result you need." +
          (options.feature?.trim()
            ? `\nSuggested feature: ${options.feature.trim()}\nConfirm this description or enter your changes.`
            : ""),
      },
      phase: "interview",
      workspace,
      sessionId: interviewSession,
      feature: "",
      commandHash: setup.hash,
      settings: {
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        agentTimeoutMs: config.agentTimeoutMs,
        models: {
          ...Object.fromEntries(
            ["executor", "merger", "code-review", "functional-review"].map(
              (role) => [role, model],
            ),
          ),
          ...config.models,
          interview: model,
        },
        skills: { interview: { path: skill.path, hash: skill.hash } },
      },
      transcript: [],
      turn: 0,
    });
    await adapter.focusStageSession?.(workspace, runId, interviewSession);
    return await continueInterview(store, adapter, runId, skill.text);
  } catch (cause) {
    if (!created) await rm(lock, { recursive: true, force: true });
    else {
      const current = await store.getRun(runId);
      if (!current?.control || current.control.status === "active")
        await store.recordControl(
          runId,
          {
            status: "interrupted",
            source: "recovery",
            facts: [
              `Interview startup interrupted: ${String(cause)}. Inspect /ralph-status and settle /ralph-stop before restarting.`,
            ],
          },
          current?.revision,
        );
    }
    throw cause;
  }
}
