import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertDispatchAllowed, waitForDispatch } from "../commands/control.js";
import { attemptPolicy } from "../execution/attempts.js";
import {
  createOwnedWorktree,
  readReviewGit,
  resolveReviewCommit,
} from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import {
  buildCompletionReport,
  type ReviewWorkflow,
} from "../reporting/completion.js";
import { releaseTerminalRun } from "../state/active-run.js";
import type { RunStore } from "../state/run-store.js";
import { runCodeReview } from "./code-review.js";
import type { FunctionalReviewResult } from "./functional-results.js";
import {
  type FunctionalReviewOptions,
  runFunctionalReview,
} from "./functional-review.js";
import {
  createRepairPipeline,
  createRepairTasks,
  type RepairPipeline,
  resolveFindingDispute,
} from "./repairs.js";
import { createReviewSnapshot } from "./snapshot.js";
import type { ReviewResult, ReviewSnapshot, SnapshotOptions } from "./types.js";

export interface ReviewCoordinatorOptions
  extends Omit<SnapshotOptions, "round"> {
  adapter?: OpenCodeAdapter;
  /** Captured by the coordinator; stop/restart invalidates live callbacks. */
  controlEpoch?: number;
  parentSessionId?: string;
  functionalOptions?: Omit<
    FunctionalReviewOptions,
    "store" | "adapter" | "directory" | "parentSessionId"
  >;
  reviewers?: {
    code(snapshot: ReviewSnapshot): Promise<ReviewResult>;
    functional(snapshot: ReviewSnapshot): Promise<FunctionalReviewResult>;
  };
  repairs?: RepairPipeline;
  /** Supplied by the lifecycle owner; called only after durable terminal reporting. */
  releaseActiveRun?: () => Promise<void>;
}
async function save(
  store: RunStore,
  runId: string,
  workflow: ReviewWorkflow,
  epoch?: number,
) {
  const run = await store.getRun(runId);
  if (
    !run ||
    (epoch !== undefined && (run.control?.epoch ?? 0) !== epoch) ||
    !(await store.recordReviewWorkflow(runId, run.revision, workflow))
  )
    throw new Error("Stale review workflow completion ignored");
}
function missing(
  snapshot: ReviewSnapshot,
  role: ReviewResult["role"],
  cause: unknown,
): ReviewResult {
  return {
    role,
    reviewedCommit: snapshot.commit,
    round: snapshot.round,
    outcome: "unverified",
    findings: [],
    evidenceRefs: [],
    error: {
      code: "unsupported",
      message: cause instanceof Error ? cause.message : String(cause),
      cause: String(cause),
    },
  };
}
const activeCoordinators = new Set<string>();
export async function coordinateReviewRound(options: ReviewCoordinatorOptions) {
  const key = `${options.store.repositoryId}:${options.runId}`;
  if (activeCoordinators.has(key))
    throw new Error("Review workflow already active");
  activeCoordinators.add(key);
  try {
    return await coordinate(options);
  } finally {
    activeCoordinators.delete(key);
  }
}
async function coordinate(options: ReviewCoordinatorOptions) {
  await assertDispatchAllowed(options.store, options.runId);
  const prior = await options.store.getRun(options.runId);
  options = { ...options, controlEpoch: prior?.control?.epoch ?? 0 };
  if (
    !options.repairs &&
    options.adapter &&
    prior?.planning?.executionEligibility
  )
    options.repairs = createRepairPipeline(
      options.store,
      options.adapter,
      options.runId,
    );
  if (
    prior?.reviewWorkflow?.status === "terminal" &&
    prior.reviewWorkflow.report
  )
    return prior.reviewWorkflow.report;
  if (prior?.reviewWorkflow && prior.control?.source !== "human")
    throw new Error(
      "Existing workflow requires explicit recovery before resume",
    );
  if (
    prior?.reviewWorkflow?.rounds.some((r) =>
      r.repairs.some((t) =>
        t.attempts.some((a) => ["intent", "integrating"].includes(a.status)),
      ),
    )
  )
    throw new Error("Interrupted repair requires reconciliation before resume");
  const branch = (
    await readReviewGit(options.directory, ["symbolic-ref", "--short", "HEAD"])
  ).trim();
  const snapshot =
    prior?.reviewWorkflow?.rounds.at(-1)?.snapshot ??
    (await createReviewSnapshot({ ...options, round: 1 }));
  const initial = await options.store.getRun(options.runId);
  if (!initial?.review) throw new Error("Missing frozen review");
  const workflow: ReviewWorkflow = structuredClone(
    prior?.reviewWorkflow ?? {
      ownerId: randomUUID(),
      branch,
      commit: snapshot.commit,
      status: "running",
      rounds: [
        {
          snapshot,
          repairs: [],
          disputes: [],
          validation: initial.review.inputs.execution,
        },
      ],
    },
  );
  // Scheduling keeps verification provisional until review. Qualify the frozen
  // validation from commit-bound checks without treating a pending-review flag
  // as a permanent omission. Missing/failed/skipped checks remain incomplete.
  const validation = workflow.rounds.at(-1)?.validation;
  if (
    initial.planning?.executionEligibility &&
    validation?.verification === "incomplete" &&
    validation.reviewPending === true &&
    validation.issues.length > 0 &&
    validation.issues.every((issue) => issue.status === "integrated") &&
    validation.integrationQueue.length === 0 &&
    !initial.validationSkips?.length &&
    validation.checks.length > 0 &&
    validation.checks.every(
      (check) =>
        check.status === "passed" && check.candidateCommit === snapshot.commit,
    )
  ) {
    validation.verification = "passed";
    validation.reviewPending = false;
  }
  await save(options.store, options.runId, workflow, options.controlEpoch);
  const common = () => {
    if (!options.adapter || !options.parentSessionId)
      throw new Error("No coordinated OpenCode adapter/session supplied");
    return {
      store: options.store,
      adapter: options.adapter,
      directory: options.directory,
      parentSessionId: options.parentSessionId,
      model:
        initial.planning?.settings.models["code-review"] ??
        initial.planning?.settings.models.interview,
    };
  };
  for (let number = workflow.rounds.length; number <= 3; number++) {
    await waitForDispatch(options.store, options.runId);
    const round = workflow.rounds.at(-1);
    if (!round) throw new Error("Missing round");
    const frozen = round.snapshot;
    const infrastructureUsed = workflow.rounds
      .slice(0, -1)
      .flatMap((r) => r.functional?.attempts ?? [])
      .filter(
        (a) =>
          a.blocker?.code === "unsupported" ||
          a.blocker?.code === "sdk-error" ||
          a.blocker?.code === "missing-output" ||
          a.blocker?.code === "permission-denied",
      ).length;
    const infrastructureRemaining = Math.max(0, 3 - infrastructureUsed);
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        round.code
          ? round.code
          : options.reviewers
            ? options.reviewers.code(frozen)
            : runCodeReview(frozen, common()),
      ),
      Promise.resolve().then(() => {
        if (round.functional) return round.functional;
        if (!infrastructureRemaining)
          return {
            ...missing(
              frozen,
              "functional-review",
              "Functional infrastructure budget exhausted after three attempts",
            ),
            role: "functional-review" as const,
            criteria: [],
            evidence: [],
            attempts: [],
          };
        if (options.reviewers) return options.reviewers.functional(frozen);
        if (!options.functionalOptions)
          throw new Error("No approved functional environment supplied");
        return runFunctionalReview(frozen, {
          ...common(),
          ...options.functionalOptions,
          infrastructureAttemptLimit: infrastructureRemaining,
        });
      }),
    ]);
    const persisted = await options.store.getRun(options.runId);
    const c = results[0];
    const f = results[1];
    round.code =
      c.status === "fulfilled"
        ? c.value
        : (persisted?.review?.result ??
          missing(frozen, "code-review", c.reason));
    round.functional =
      f.status === "fulfilled"
        ? f.value
        : (persisted?.review?.functionalResult ?? {
            ...missing(frozen, "functional-review", f.reason),
            role: "functional-review",
            criteria: [],
            evidence: [],
            attempts: [],
          });
    if (
      round.code.role !== "code-review" ||
      round.functional.role !== "functional-review"
    )
      throw new Error("Stale reviewer role completion ignored");
    for (const result of [round.code, round.functional]) {
      for (const finding of result.findings)
        if (["style", "refactor"].includes(finding.category))
          finding.blocking = false;
      if (
        result.reviewedCommit !== frozen.commit ||
        result.round !== frozen.round
      )
        throw new Error("Stale reviewer completion ignored");
      if (result.outcome === "passed" && !result.evidenceRefs.length) {
        result.outcome = "unverified";
        result.error = {
          code: "missing-output",
          message: "Reviewer supplied no verification evidence",
        };
      }
    }
    await assertCurrent(
      options,
      frozen,
      workflow.commit,
      workflow.commit !== frozen.commit,
    );
    await save(options.store, options.runId, workflow, options.controlEpoch);
    const current = await options.store.getRun(options.runId);
    const tasks = round.repairs.length
      ? round.repairs
      : createRepairTasks(
          frozen,
          [...round.code.findings, ...round.functional.findings],
          current?.execution?.issues ?? [],
          {
            prd: current?.review?.inputs.prd ?? "",
            graph: current?.review?.inputs.graph ?? "",
          },
        );
    if (!tasks.length || number === 3) break;
    round.repairs = tasks;
    await save(options.store, options.runId, workflow, options.controlEpoch);
    if (!options.repairs) {
      for (const task of tasks) task.status = "unresolved";
      await save(options.store, options.runId, workflow, options.controlEpoch);
      break;
    }
    for (const task of tasks) {
      if (task.status !== "pending") continue;
      for (
        let attempt = task.attempts.length + 1;
        attempt <= attemptPolicy.maxAttempts;
        attempt++
      ) {
        await waitForDispatch(options.store, options.runId);
        await assertCurrent(
          options,
          frozen,
          workflow.commit,
          workflow.commit !== frozen.commit,
        );
        const workspace = join(
          options.store.root,
          "repair-workspaces",
          randomUUID(),
        );
        const baseCommit = workflow.commit;
        const record = {
          attempt,
          workspace,
          baseCommit,
          status: "intent" as
            | "intent"
            | "integrating"
            | "failed"
            | "integrated"
            | "disputed",
          evidenceRefs: [] as string[],
        };
        task.attempts.push(record);
        await save(
          options.store,
          options.runId,
          workflow,
          options.controlEpoch,
        ); // Intent precedes worktree creation and executor dispatch.
        try {
          if (!options.repairs.ownsWorkspaces)
            await createOwnedWorktree(options.directory, workspace, baseCommit);
          await waitForDispatch(options.store, options.runId);
          const response = await options.repairs.executeIssue(task, {
            snapshot: frozen,
            workspace,
            attempt,
            baseCommit,
          });
          record.evidenceRefs.push(...response.evidenceRefs);
          await assertCurrent(
            options,
            frozen,
            baseCommit,
            baseCommit !== frozen.commit,
          );
          if (response.outcome === "failed") {
            Object.assign(record, { status: "failed", error: response.error });
            if (
              ["permission-denied", "cancelled"].includes(response.error.code)
            )
              task.status = "unresolved"; // Intervention does not authorize a new attempt.
          } else if (response.outcome === "disputed") {
            record.status = "disputed";
            for (const finding of task.sources) {
              const key = `${finding.reviewerRole}:${finding.id}`;
              if (
                !response.findingIds.includes(key) ||
                round.disputes.some(
                  (d) =>
                    d.finding.reviewerRole === finding.reviewerRole &&
                    d.finding.id === finding.id,
                )
              )
                continue;
              // Reserve the one exchange before invoking the originating reviewer.
              const disposition = {
                finding,
                executorEvidence: response.evidenceRefs,
                disposition: "retained" as const,
                reviewerEvidence: [] as string[],
                justification: "Clarification pending or interrupted",
              };
              round.disputes.push(disposition);
              await save(
                options.store,
                options.runId,
                workflow,
                options.controlEpoch,
              );
              await waitForDispatch(options.store, options.runId);
              const resolved = await resolveFindingDispute(
                finding,
                response.evidenceRefs,
                frozen,
                options.repairs.clarifyFinding,
              );
              Object.assign(disposition, resolved);
            }
            task.status = task.sources.every((finding) =>
              round.disputes.some(
                (d) =>
                  d.finding.id === finding.id &&
                  d.finding.reviewerRole === finding.reviewerRole &&
                  d.disposition === "withdrawn",
              ),
            )
              ? "withdrawn"
              : "unresolved";
          } else {
            await resolveReviewCommit(workspace, response.commit);
            if (
              (await readReviewGit(workspace, ["rev-parse", "HEAD"])).trim() !==
                response.commit ||
              (
                await readReviewGit(workspace, ["status", "--porcelain"])
              ).trim() ||
              !response.evidenceRefs.length
            )
              throw new Error(
                "Repair candidate lacks a clean correlated commit or TDD evidence",
              );
            await readReviewGit(workspace, [
              "merge-base",
              "--is-ancestor",
              baseCommit,
              response.commit,
            ]);
            Object.assign(record, {
              status: "integrating",
              candidateCommit: response.commit,
            });
            await save(
              options.store,
              options.runId,
              workflow,
              options.controlEpoch,
            );
            await waitForDispatch(options.store, options.runId);
            const integrated = await options.repairs.integrateIssue(
              task,
              response.commit,
              { workspace, attempt, baseCommit },
            );
            record.evidenceRefs.push(...integrated.evidenceRefs);
            if (integrated.outcome === "failed") {
              Object.assign(record, {
                status: "failed",
                error: integrated.error,
              });
              if (
                ["permission-denied", "cancelled"].includes(
                  integrated.error.code,
                )
              )
                task.status = "unresolved";
            } else {
              await resolveReviewCommit(options.directory, integrated.commit);
              const required =
                current?.execution?.checks.map((c) => c.id) ?? [];
              if (
                !integrated.checks.length ||
                required.some(
                  (id) => !integrated.checks.some((c) => c.id === id),
                ) ||
                integrated.checks.some(
                  (c) =>
                    c.candidateCommit !== integrated.commit ||
                    !["passed", "skipped"].includes(c.status),
                ) ||
                !integrated.evidenceRefs.length
              )
                throw new Error(
                  "Integrated repair lacks complete candidate check evidence",
                );
              if (
                (
                  await readReviewGit(options.directory, ["rev-parse", "HEAD"])
                ).trim() !== integrated.commit
              )
                throw new Error(
                  "Merger did not advance the feature branch to its checked commit",
                );
              await readReviewGit(options.directory, [
                "merge-base",
                "--is-ancestor",
                baseCommit,
                integrated.commit,
              ]);
              Object.assign(record, { checks: integrated.checks });
              workflow.commit = integrated.commit;
              record.status = "integrated";
              task.status = "integrated";
              const run = await options.store.getRun(options.runId);
              if ((run?.control?.epoch ?? 0) !== options.controlEpoch)
                throw new Error("Stale integration completion ignored");
              if (!run?.execution)
                throw new Error("Missing execution evidence");
              // Keep the approved graph intact. Repair tasks live only in the review workflow.
              if (
                !(await options.store.recordExecution(
                  options.runId,
                  run.revision,
                  {
                    ...run.execution,
                    verification: integrated.checks.every(
                      (c) => c.status === "passed",
                    )
                      ? "passed"
                      : "incomplete",
                    checks: integrated.checks,
                  },
                ))
              )
                throw new Error("Stale integration evidence ignored");
            }
          }
        } catch (cause) {
          Object.assign(record, {
            status: "failed",
            error: {
              code: "sdk-error",
              message: cause instanceof Error ? cause.message : String(cause),
              cause: String(cause),
            },
          });
        }
        await save(
          options.store,
          options.runId,
          workflow,
          options.controlEpoch,
        );
        if (task.status !== "pending") break;
      }
      if (task.status === "pending") task.status = "unresolved";
      await save(options.store, options.runId, workflow, options.controlEpoch);
      if (task.status === "unresolved") break;
    }
    if (tasks.some((t) => t.status === "unresolved" || t.status === "pending"))
      break;
    if (tasks.every((t) => t.status === "withdrawn")) break; // A dispute does not buy another review round.
    await waitForDispatch(options.store, options.runId);
    const next = await createReviewSnapshot({
      ...options,
      round: number + 1,
      commit: workflow.commit,
    });
    const nextRun = await options.store.getRun(options.runId);
    if (!nextRun?.review) throw new Error("Missing frozen repair review");
    workflow.rounds.push({
      snapshot: next,
      repairs: [],
      disputes: [],
      validation: nextRun.review.inputs.execution,
    });
    await save(options.store, options.runId, workflow, options.controlEpoch);
  }
  const run = await options.store.getRun(options.runId);
  if (!run) throw new Error("Missing run");
  const finalSnapshot = workflow.rounds.at(-1)?.snapshot;
  if (!finalSnapshot) throw new Error("Missing final review snapshot");
  await assertCurrent(
    options,
    finalSnapshot,
    workflow.commit,
    workflow.commit !== finalSnapshot.commit,
  );
  const report = buildCompletionReport(run);
  workflow.status = "terminal";
  workflow.report = report;
  await save(options.store, options.runId, workflow, options.controlEpoch);
  await releaseTerminalRun(options.store, options.runId, options.directory);
  await options.releaseActiveRun?.();
  if (options.adapter && options.parentSessionId) {
    const operation = {
      operationId: "review-completion-publish",
      kind: "review.publish" as const,
      status: "intent" as const,
      job: {
        runId: options.runId,
        jobId: "review-completion-publish",
        role: "completion",
        attempt: 1,
        workspace: options.directory,
        inputRevisions: { round: workflow.rounds.length },
        baseCommit: workflow.commit,
        prompt: "Publish final review report",
      },
    };
    await waitForDispatch(options.store, options.runId);
    if (!(await options.store.recordOperation(operation))) return report;
    const published = await options.adapter.publishStatus(
      options.parentSessionId,
      options.directory,
      JSON.stringify(report),
    );
    await options.store.recordOperation({
      ...operation,
      status: published.ok ? "completed" : "failed",
      ...(published.error ? { error: published.error } : {}),
    });
  }
  return report;
}

async function assertCurrent(
  options: ReviewCoordinatorOptions,
  snapshot: ReviewSnapshot,
  commit: string,
  repaired = false,
) {
  const run = await options.store.getRun(options.runId);
  if (
    (run?.control?.epoch ?? 0) !== options.controlEpoch ||
    ["stopped", "interrupted", "blocked"].includes(
      run?.control?.status ?? "",
    ) ||
    (!repaired && run?.review?.superseded) ||
    run?.review?.snapshot.commit !== snapshot.commit ||
    run.review.snapshot.round !== snapshot.round ||
    run.reviewWorkflow?.status !== "running"
  )
    throw new Error("Superseded coordinated review ignored");
  const branch = (
    await readReviewGit(options.directory, ["symbolic-ref", "--short", "HEAD"])
  ).trim();
  const head = (
    await readReviewGit(options.directory, ["rev-parse", "HEAD"])
  ).trim();
  if (branch !== run.reviewWorkflow.branch || head !== commit)
    throw new Error(
      "Feature branch changed outside the coordinated repair pipeline",
    );
}
