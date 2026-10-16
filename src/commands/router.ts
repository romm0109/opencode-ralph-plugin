import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  continuePlanning,
  reviewCompletedCode,
  runIssue,
  scheduleReadyIssues,
} from "../core/orchestrator.js";
import type { JobEnvelope, JobResult, UserInputResult } from "../core/types.js";
import { projectPlanning } from "../dashboard/projections.js";
import type { AttemptOptions } from "../execution/attempts.js";
import { answerExecutorQuestion } from "../execution/questions.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { CodeReviewOptions } from "../review/code-review.js";
import {
  coordinateReviewRound,
  type ReviewCoordinatorOptions,
} from "../review/coordinator.js";
import {
  type FunctionalReviewOptions,
  runFunctionalReview,
} from "../review/functional-review.js";
import type { ReviewSnapshot } from "../review/types.js";
import type { RunStore } from "../state/run-store.js";
import { assertDispatchAllowed, handleControlCommand } from "./control.js";
import { startNativeFeature } from "./orchestrator.js";
import {
  type ProjectSetupOptions,
  projectStatus,
  setupProject,
} from "./project-setup.js";
import { resumeWorkflow } from "./resume.js";
export function createCommandRouter(
  store: RunStore,
  adapter?: OpenCodeAdapter,
  dashboardUrl?: string,
  workspace?: string,
) {
  return {
    projectStatus,
    async continuePlanning(runId: string) {
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      return continuePlanning(store, adapter, runId);
    },
    async answerExecutorQuestion(
      runId: string,
      issueId: string,
      response: UserInputResult,
    ) {
      return answerExecutorQuestion(store, runId, issueId, response);
    },
    async scheduleIssues(runId: string, options: AttemptOptions = {}) {
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      await assertDispatchAllowed(store, runId);
      return scheduleReadyIssues(store, adapter, runId, options);
    },
    async executeIssue(
      runId: string,
      issueId: string,
      options: AttemptOptions = {},
    ) {
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      await assertDispatchAllowed(store, runId);
      return runIssue(store, adapter, runId, issueId, options);
    },
    async setupProject(options: ProjectSetupOptions) {
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      return setupProject({ ...options, store, adapter });
    },
    async reviewFeature(
      options: Omit<ReviewCoordinatorOptions, "store" | "adapter">,
    ) {
      await assertDispatchAllowed(store, options.runId);
      return coordinateReviewRound({
        ...options,
        store,
        ...(adapter ? { adapter } : {}),
      });
    },
    async reviewFunctional(
      snapshot: ReviewSnapshot,
      options: Omit<FunctionalReviewOptions, "store" | "adapter">,
    ) {
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      await assertDispatchAllowed(store, snapshot.runId);
      return runFunctionalReview(snapshot, { ...options, store, adapter });
    },
    async reviewCode(
      snapshot: ReviewSnapshot,
      options: Omit<CodeReviewOptions, "store" | "adapter">,
    ) {
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      await assertDispatchAllowed(store, snapshot.runId);
      return reviewCompletedCode(snapshot, { ...options, store, adapter });
    },
    async runJob(job: JobEnvelope): Promise<JobResult> {
      if (!adapter)
        return {
          ...job,
          outcome: "failed",
          evidence: [],
          error: {
            code: "unsupported",
            message: "No OpenCode adapter supplied",
          },
        };
      await store.createRun(job.runId);
      await assertDispatchAllowed(store, job.runId);
      return adapter.dispatchJob(job);
    },
    async status(runId?: string): Promise<string> {
      const projectSetup = workspace
        ? await projectStatus(workspace)
        : undefined;
      const run = runId
        ? await store.getRun(runId)
        : (await store.listRuns()).at(-1);
      const stage = run && projectPlanning(run);
      const issues = run?.execution?.issues ?? [];
      const issueSummary = {
        total: issues.length,
        pending: 0,
        ready: 0,
        running: 0,
        integration_queued: 0,
        integrated: 0,
        blocked: 0,
        failed: 0,
      };
      for (const issue of issues) issueSummary[issue.status]++;
      return run
        ? JSON.stringify(
            {
              ...(dashboardUrl ? { dashboardUrl } : {}),
              ...(projectSetup ? { projectSetup } : {}),
              runId: run.runId,
              revision: run.revision,
              phase: run.phase,
              ...(stage ? { stage } : {}),
              control: run.control ?? null,
              lastResult: run.lastResult ?? null,
              ...(run.review ? { review: run.review } : {}),
              ...(run.reviewWorkflow
                ? { reviewWorkflow: run.reviewWorkflow }
                : {}),
              ...(run.planning ? { planning: run.planning } : {}),
              ...(run.baseline
                ? {
                    baseline: run.baseline,
                    validationSkips: run.validationSkips ?? [],
                  }
                : {}),
              issueAttempts: run.issueAttempts ?? {},
              issueSummary,
              ...(run.execution ? { execution: run.execution } : {}),
              errors: run.errors,
            },
            null,
            2,
          )
        : dashboardUrl
          ? JSON.stringify({
              dashboardUrl,
              ...(projectSetup ? { projectSetup } : {}),
              message: "No Ralph run found.",
            })
          : projectSetup
            ? JSON.stringify({ projectSetup, message: "No Ralph run found." })
            : "No Ralph run found.";
    },
    async resume(
      runId?: string,
      context?: ProjectSetupOptions,
      options: { selectedCommit?: string; review?: boolean } = {},
    ) {
      const runs = runId?.trim() ? [] : await store.listRuns();
      const id =
        runId?.trim() ||
        runs.filter((run) => run.planning).at(-1)?.runId ||
        runs.at(-1)?.runId;
      if (!id) throw new Error("No Ralph run found");
      const run = await store.getRun(id);
      if (!run?.planning) {
        if (options.review || options.selectedCommit)
          throw new Error(
            "Resume options require a supported feature workflow",
          );
        return handleControlCommand("ralph-resume", id, store, adapter);
      }
      if (run.planning.protocol !== "native-interview-v1")
        throw new Error(
          "Unsupported saved workflow; a fresh workflow is required",
        );
      if (!adapter) throw new Error("No OpenCode adapter supplied");
      if (!run.planning.prdAcceptance) {
        if (options.review || options.selectedCommit)
          throw new Error(
            "An accepted PRD is required; restart discovery in a fresh session",
          );
        if (!context)
          throw new Error(
            "Discovery restart requires the main session and workspace",
          );
        if (
          Object.values(run.operations).some(
            (op) => op.kind === "run.release" && op.status !== "failed",
          )
        )
          throw new Error(
            "Run ownership was released; a fresh workflow is required",
          );
        const owner = JSON.parse(
          await readFile(
            join(store.root, "active-run.lock/owner.json"),
            "utf8",
          ),
        );
        if (owner.runId !== id || owner.repositoryId !== store.repositoryId)
          throw new Error("Repository ownership differs; resume blocked");
        return JSON.stringify(
          await startNativeFeature({ ...context, store, adapter }),
        );
      }
      await resumeWorkflow(store, adapter, id, options);
      return this.status(id);
    },
    async dispatch(command: string, args = "", context?: ProjectSetupOptions) {
      if (command === "ralph-orchestrator") {
        if (!context)
          throw new Error(
            "Feature planning requires the main session and workspace",
          );
        if (!adapter) throw new Error("No OpenCode adapter supplied");
        return JSON.stringify(
          await startNativeFeature({
            ...context,
            feature: args,
            store,
            adapter,
          }),
          null,
          2,
        );
      }
      if (command === "ralph-commands") {
        if (!context)
          throw new Error(
            "Project setup requires the main session and workspace",
          );
        return JSON.stringify(await this.setupProject(context), null, 2);
      }
      if (command === "ralph-resume") {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        let runId: string | undefined;
        const options: { selectedCommit?: string; review?: boolean } = {};
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index] as string;
          if (token === "--review" && !options.review) options.review = true;
          else if (
            token === "--base" &&
            !options.selectedCommit &&
            tokens[index + 1] &&
            !tokens[index + 1]?.startsWith("--")
          )
            options.selectedCommit = tokens[++index] as string;
          else if (!token.startsWith("--") && !runId) runId = token;
          else
            throw new Error(
              "Use /ralph-resume [run-id] [--base <commit> | --review]",
            );
        }
        if (options.review && options.selectedCommit)
          throw new Error(
            "Review-only retry cannot change the starting commit",
          );
        return this.resume(runId, context, options);
      }
      if (["ralph-pause", "ralph-stop"].includes(command)) {
        const runId = args.trim() || (await store.listRuns()).at(-1)?.runId;
        if (!runId) throw new Error("No Ralph run found");
        return handleControlCommand(
          command as "ralph-pause" | "ralph-stop",
          runId,
          store,
          adapter,
        );
      }
      if (command !== "ralph-status")
        throw new Error(`Unknown Ralph command: ${command}`);
      return this.status(args.trim() || undefined);
    },
  };
}
