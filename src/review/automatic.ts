import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import type { JobEnvelope } from "../core/types.js";
import { validateCandidate } from "../execution/validation.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { assertNativeExecutionInputs } from "../planning/eligibility.js";
import {
  type ApprovedEnvironment,
  createApprovedEnvironment,
} from "../process/environment.js";
import type { RunStore } from "../state/run-store.js";
import { coordinateReviewRound } from "./coordinator.js";
import type { ReviewSnapshot } from "./types.js";

/** Production handoff: the approved lifecycle, both independent reviewers, and reporting. */
export async function runAutomaticReview(
  store: RunStore,
  adapter: OpenCodeAdapter,
  snapshot: ReviewSnapshot,
) {
  const run = await store.getRun(snapshot.runId);
  const planning = run?.planning;
  if (
    !run ||
    !planning?.graph ||
    !planning.prd ||
    !run.baseline?.workspace ||
    !run.review
  )
    throw new Error("Missing approved review inputs");
  await assertNativeExecutionInputs(planning, snapshot.runId);
  const config = await loadProjectConfig(planning.workspace);
  if (commandConfigHash(config.commands) !== planning.commandHash)
    throw new Error("Approved review commands changed");
  const http = !!config.commands.url;
  const tools = (await adapter.discoverTools?.(planning.workspace)) ?? [];
  const environments = new Map<
    string,
    ReturnType<typeof createApprovedEnvironment>
  >();
  const key = (job: JobEnvelope) => `${job.jobId}:${job.attempt}`;
  const environment: ApprovedEnvironment = {
    revision: config.commands.revision,
    async prepare(job) {
      const context = {
        store,
        adapter,
        job,
        config: config.commands,
        sourceWorkspace: planning.workspace,
        permissionSessionId: planning.sessionId,
      };
      if (!http) {
        const validation = await validateCandidate(context);
        if (validation.status === "failed")
          throw new Error(
            validation.blocker ?? "Approved functional checks failed",
          );
        return {
          url: "",
          evidenceRefs: validation.checks.map((check) =>
            JSON.stringify({
              id: check.id,
              status: check.status,
              commit: validation.candidateCommit,
              result: check.result,
            }),
          ),
        };
      }
      const owned = createApprovedEnvironment(context, { skipChecks: true });
      environments.set(key(job), owned);
      return owned.prepare(job);
    },
    async dispose(job) {
      const owned = environments.get(key(job));
      return owned
        ? owned.dispose(job)
        : { status: "completed", evidenceRefs: [] };
    },
  };
  const report = await coordinateReviewRound({
    store,
    adapter,
    directory: run.baseline.workspace,
    runId: snapshot.runId,
    commit: snapshot.commit,
    baseCommit: run.review.inputs.baseCommit,
    prdRevision: planning.prd.hash,
    graph: {
      revision: planning.graph.hash,
      issues: planning.graph.value.issues,
    },
    evidenceRefs: snapshot.evidenceRefs,
    approvedPlanning: true,
    parentSessionId: planning.sessionId,
    functionalOptions: {
      environment,
      surfaces: { ui: false, http },
      tools: http
        ? {
            http:
              tools.find((name) => ["http", "webfetch"].includes(name)) ??
              "webfetch",
          }
        : {},
      model:
        planning.settings.models["functional-review"] ??
        planning.settings.models.interview,
    },
  });
  await adapter.publishStatus(
    planning.sessionId,
    planning.workspace,
    JSON.stringify(report, null, 2),
  );
  return store.getRun(snapshot.runId);
}
