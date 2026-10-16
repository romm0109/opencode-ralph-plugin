import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ExecutionEvidence,
  RunOperation,
  RunRecord,
} from "../core/types.js";
import {
  readReviewGit,
  resolveReviewCommit,
  verifyReviewRepository,
} from "../git/review-workspace.js";
import {
  inspectWorktree,
  reconcileIntegrationCheckout,
} from "../git/worktrees.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import { readPlanningArtifact } from "../planning/artifact-writer.js";
import { artifactHash, explanationHash } from "../planning/artifacts.js";
import { assertNativeExecutionInputs } from "../planning/eligibility.js";
import {
  inspectOwnedProcess,
  terminateOwnedProcess,
} from "../process/ownership.js";
import type { RunStore } from "../state/run-store.js";

export interface RecoverySummary {
  runId: string;
  status: "interrupted" | "blocked";
  facts: string[];
  completedOperations: string[];
  requiresResume: true;
}
export interface ReconcileOptions {
  store: RunStore;
  directory: string;
  runId: string;
  adapter?: OpenCodeAdapter;
  /** Approved validation only; never discover or run arbitrary stored prose. */
  revalidate?: (
    operation: RunOperation,
  ) => Promise<ExecutionEvidence["checks"]>;
}
function validChecks(operation: RunOperation, checks = operation.checks) {
  return (
    !!checks?.length &&
    checks.every(
      (c) =>
        c.status === "passed" &&
        c.candidateCommit === operation.expectedNew &&
        Number.isInteger(c.commandRevision) &&
        c.commandRevision > 0,
    )
  );
}
/** Production validation is attached to the immutable merger attempt before advance. */
function validatedAttempt(run: RunRecord, operation: RunOperation) {
  const attempt = run.issueAttempts?.[operation.job.issueId ?? ""];
  const validation = attempt?.validation;
  return (
    !!attempt &&
    !!validation &&
    isDeepStrictEqual(attempt.candidate?.job, operation.job) &&
    attempt.attempt === operation.job.attempt &&
    attempt.candidate?.commit === operation.expectedNew &&
    operation.expectedOld === operation.job.baseCommit &&
    operation.ref === `refs/heads/${run.baseline?.branch}` &&
    run.baseline?.approvalRequestId ===
      run.planning?.executionEligibility?.requestId &&
    !!run.planning?.executionEligibility &&
    executionEligibilityMatchesRevision(run.planning) &&
    validation.candidateCommit === operation.expectedNew &&
    validation.commandHash === run.planning.commandHash &&
    validation.commandRevision === operation.job.inputRevisions.commands &&
    ["passed", "passed_with_omissions"].includes(validation.status) &&
    validation.checks.every((c) =>
      c.status === "passed"
        ? c.result?.status === "completed" &&
          c.result.exitCode === 0 &&
          !c.result.cause &&
          !c.result.cleanupError
        : c.status === "skipped" && run.validationSkips?.includes(c.id),
    )
  );
}
/** Reconciliation observes side effects; it never advances refs or repeats dispatch. */
export async function reconcileRun(
  options: ReconcileOptions,
): Promise<RecoverySummary> {
  const { store, directory, runId, adapter } = options;
  await verifyReviewRepository(directory, store.repositoryId);
  const run = await store.getRun(runId);
  if (!run) throw new Error("Unknown run");
  const summary: RecoverySummary = {
    runId,
    status: "interrupted",
    facts: [],
    completedOperations: [],
    requiresResume: true,
  };
  if (run.planning && run.planning.protocol !== "native-interview-v1") {
    summary.status = "blocked";
    summary.facts.push(
      "Unsupported saved workflow; a fresh workflow is required. Preserve artifacts and use /ralph-stop to settle ownership.",
    );
    return summary;
  }
  // Freeze all state advancement before inspecting sessions and external state.
  if (
    !(await store.recordControl(
      runId,
      { status: "interrupted", source: "recovery", cleanupPending: true },
      run.revision,
    ))
  )
    throw new Error("Recovery raced another control; retry");
  function blocked(fact: string) {
    summary.status = "blocked";
    summary.facts.push(fact);
  }
  if (
    run.planning?.protocol === "native-interview-v1" &&
    run.planning.prdAcceptance
  ) {
    try {
      const state = run.planning;
      const accepted = state.prdAcceptance;
      if (!accepted) throw new Error("Missing PRD acceptance");
      if (
        !state.explanation ||
        state.approval?.hash !== explanationHash(state.explanation) ||
        state.approval.revision !== state.explanation.revision ||
        artifactHash(accepted.text) !== accepted.revision.hash
      )
        throw new Error("Accepted PRD or explanation authorization differs");
      if (
        state.prd &&
        (state.prd.hash !== accepted.revision.hash ||
          artifactHash(
            await readFile(
              await readPlanningArtifact(
                state.workspace,
                state.prd.artifactPath,
              ),
              "utf8",
            ),
          ) !== state.prd.hash)
      )
        throw new Error("Accepted PRD bytes changed");
    } catch (cause) {
      blocked(`Accepted planning inputs unavailable: ${String(cause)}`);
    }
  }
  if (run.planning?.executionEligibility) {
    try {
      await assertNativeExecutionInputs(run.planning, runId);
    } catch (cause) {
      blocked(`Execution inputs changed: ${String(cause)}`);
    }
  }
  try {
    const owner = JSON.parse(
      await readFile(join(store.root, "active-run.lock", "owner.json"), "utf8"),
    );
    if (owner.runId !== runId || owner.repositoryId !== store.repositoryId)
      blocked(
        "Repository active-run lock identity differs; ownership retained for inspection",
      );
    else
      summary.facts.push(
        "Matching repository active-run lock retained; no replacement or budget reset",
      );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      blocked(
        `Repository active-run lock cannot be verified: ${String(cause)}`,
      );
    else {
      if (run.planning?.protocol === "native-interview-v1")
        blocked(
          "Native repository ownership is missing; no replacement authorized",
        );
      try {
        await access(join(store.root, "active-run.lock"));
        blocked(
          "Repository active-run lock lacks owner evidence; retained for inspection",
        );
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT")
          blocked(
            `Repository active-run lock inspection failed: ${String(missing)}`,
          );
      }
    }
  }
  for (const { envelope, status } of Object.values(run.jobs)) {
    if (status === "terminal") continue;
    const planning = run.planning;
    if (
      planning?.protocol === "native-interview-v1" &&
      !planning.prdAcceptance &&
      ["interview", "prd"].includes(envelope.role)
    ) {
      const cancelled = await adapter?.cancelJob(envelope);
      const settled = envelope.sessionId
        ? await adapter?.inspectSession?.(envelope)
        : "unknown";
      if (cancelled?.ok && ["idle", "missing"].includes(settled ?? "unknown"))
        summary.facts.push(
          `${envelope.jobId}: unfinished discovery/PRD settled; retained history requires fresh discovery, not continuation`,
        );
      else
        blocked(
          `${envelope.jobId}: unfinished planning cleanup unconfirmed; retain ownership until reconciliation`,
        );
      continue;
    }
    const authoring =
      planning?.protocol === "native-interview-v1" && planning.prdAcceptance
        ? planning.attempts?.find(
            (a) =>
              a.job.jobId === envelope.jobId &&
              a.attempt === envelope.attempt &&
              a.sessionId === envelope.sessionId &&
              a.status === "active" &&
              !planning.owner?.retired &&
              planning.owner?.sessionId === a.sessionId &&
              planning.owner.attempt === a.attempt,
          )
        : undefined;
    if (authoring) {
      const receipt =
        (await adapter?.inspectStagePrompt?.(
          authoring.sessionId,
          authoring.messageId,
          authoring.prompt,
        )) ?? "unknown";
      const delivered = planning?.issueHandoff?.queued;
      if (receipt === "present" || (receipt === "missing" && !delivered)) {
        summary.facts.push(
          `${envelope.jobId}: exact planning prompt ${receipt}; retained owner and remaining budget, explicit resume required`,
        );
        continue;
      }
      blocked(
        `${envelope.jobId}: planning delivery evidence ${receipt}; no repeated dispatch`,
      );
      continue;
    }
    const observed =
      envelope.sessionId && adapter?.inspectSession
        ? await adapter.inspectSession(envelope)
        : "unknown";
    summary.facts.push(
      `${envelope.jobId}/${envelope.attempt}: session ${envelope.sessionId ?? "not recorded"} is ${observed}`,
    );
    if (adapter) {
      const cancelled = await adapter.cancelJob(envelope);
      if (!cancelled.ok)
        blocked(`Session cancellation uncertain: ${cancelled.error?.message}`);
    }
    blocked(
      `${envelope.jobId}/${envelope.attempt}: interrupted attempt requires correlated evidence; no automatic retry`,
    );
  }
  const worktrees = await readReviewGit(directory, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  for (const operation of Object.values(run.operations)) {
    if (operation.ownedProcess) {
      if (
        operation.ownedProcess.repositoryId !== store.repositoryId ||
        operation.ownedProcess.workspace !== operation.job.workspace
      ) {
        blocked(
          `${operation.operationId}: process repository/workspace identity mismatch`,
        );
      } else {
        const ownership = await inspectOwnedProcess(operation.ownedProcess);
        summary.facts.push(
          `${operation.operationId}: process ${operation.ownedProcess.pid} is ${ownership.status}`,
        );
        if (ownership.status === "owned") {
          if (!(await terminateOwnedProcess(operation.ownedProcess)))
            blocked(
              `${operation.operationId}: owned process cleanup uncertain`,
            );
        } else if (ownership.status === "unknown")
          blocked(`${operation.operationId}: process inspection unavailable`);
      }
    }
    if (
      operation.status !== "intent" &&
      !(
        operation.kind === "integration.advance" &&
        operation.status === "completed" &&
        run.issueAttempts?.[operation.job.issueId ?? ""]?.status === "merging"
      )
    )
      continue;
    try {
      let complete = false;
      if (operation.kind === "integration.advance") {
        if (
          !operation.ref?.startsWith("refs/heads/") ||
          !operation.expectedOld ||
          !operation.expectedNew
        )
          throw new Error("Incomplete integration identity");
        await readReviewGit(directory, ["check-ref-format", operation.ref]);
        await resolveReviewCommit(directory, operation.expectedOld);
        await resolveReviewCommit(directory, operation.expectedNew);
        const actual = (
          await readReviewGit(directory, [
            "rev-parse",
            "--verify",
            operation.ref,
          ])
        ).trim();
        summary.facts.push(
          `${operation.operationId}: ${operation.ref} is ${actual}, expected ${operation.expectedOld} → ${operation.expectedNew}`,
        );
        if (actual !== operation.expectedNew)
          throw new Error(
            actual === operation.expectedOld
              ? "Ref was not advanced; retained intent needs explicit resolution"
              : "Ref identity is ambiguous",
          );
        if (
          !validatedAttempt(run, operation) &&
          !validChecks(operation) &&
          options.revalidate
        ) {
          const checks = await options.revalidate(operation);
          // A rerun must cover the recorded approved check set at the same revisions.
          if (
            !operation.checks?.length ||
            operation.checks.some(
              (old) =>
                !checks.some(
                  (c) =>
                    c.id === old.id &&
                    c.commandRevision === old.commandRevision,
                ),
            )
          )
            throw new Error("Validation rerun omitted approved checks");
          operation.checks = checks;
        }
        if (!validatedAttempt(run, operation) && !validChecks(operation))
          throw new Error(
            "Candidate validation uncertain; approved validation must be rerun",
          );
        if (validatedAttempt(run, operation) && run.baseline?.workspace)
          await reconcileIntegrationCheckout(
            run.baseline.workspace,
            store.repositoryId,
            operation.ref,
            operation.expectedOld,
            operation.expectedNew,
          );
        complete = true;
      } else if (operation.kind === "review.pin") {
        const ref = `refs/ralph/reviews/${runId}/${operation.job.inputRevisions.round}`;
        complete =
          (
            await readReviewGit(directory, ["rev-parse", "--verify", ref])
          ).trim() === operation.job.baseCommit;
      } else if (operation.kind === "review.workspace") {
        if (
          !worktrees.split("\0").includes(`worktree ${operation.job.workspace}`)
        )
          throw new Error("Owned worktree not present");
        await verifyReviewRepository(
          operation.job.workspace,
          store.repositoryId,
        );
        complete =
          (
            await readReviewGit(operation.job.workspace, ["rev-parse", "HEAD"])
          ).trim() === operation.job.baseCommit;
      } else if (
        [
          "baseline.workspace",
          "issue.workspace",
          "candidate.workspace",
        ].includes(operation.kind)
      ) {
        if (
          !worktrees.split("\0").includes(`worktree ${operation.job.workspace}`)
        )
          throw new Error("Owned worktree not present");
        const actual = await inspectWorktree(operation.job.workspace);
        complete =
          actual.repositoryId === store.repositoryId &&
          operation.ref?.startsWith("refs/heads/ralph/") === true &&
          actual.branch === operation.ref &&
          actual.commit === operation.expectedNew &&
          !(
            await readReviewGit(operation.job.workspace, [
              "status",
              "--porcelain",
              "--untracked-files=all",
            ])
          ).trim();
      } else if (operation.kind === "session.abort") {
        complete =
          !!adapter?.inspectSession &&
          ["idle", "missing"].includes(
            await adapter.inspectSession(operation.job),
          );
      }
      if (!complete)
        throw new Error(
          "External completion not proven; no repeated side effect",
        );
      if (
        operation.status === "intent" &&
        (await store.recordOperation({ ...operation, status: "completed" }))
      )
        summary.completedOperations.push(operation.operationId);
      if (operation.kind === "integration.advance" && operation.job.issueId) {
        const current = await store.getRun(runId);
        const attempt = current?.issueAttempts?.[operation.job.issueId];
        if (attempt?.status === "merging" && current) {
          if (
            !validatedAttempt(current, operation) ||
            !(await store.recoverIssueAttempt(
              runId,
              current.revision,
              operation.job.issueId,
              operation.operationId,
            ))
          )
            throw new Error(
              "Integrated attempt identity could not be reconciled",
            );
          summary.facts.push(
            `${operation.operationId}: integrated attempt ${attempt.attempt} recovered without redispatch`,
          );
        }
      }
    } catch (cause) {
      blocked(
        `${operation.operationId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  // A cancelled executor can become a failed (consumed) attempt only after
  // all external cleanup is proven and its exact bound session is idle.
  const cleanupState = await store.getRun(runId);
  for (const operation of Object.values(cleanupState?.operations ?? {})) {
    if (
      operation.kind === "execution.environment" &&
      operation.environment &&
      !Object.values(cleanupState?.operations ?? {}).some(
        (cleanup) =>
          cleanup.kind === "execution.environment.cleanup" &&
          cleanup.status === "completed" &&
          cleanup.environment?.ownerId === operation.environment?.ownerId,
      )
    )
      blocked(
        `${operation.operationId}: environment cleanup not proven; executor retry retained`,
      );
  }
  if (summary.status !== "blocked" && adapter?.inspectSession) {
    const current = await store.getRun(runId);
    for (const attempt of Object.values(current?.issueAttempts ?? {})) {
      if (
        attempt.status !== "executing" ||
        attempt.submission ||
        attempt.candidate
      )
        continue;
      const latest = await store.getRun(runId);
      const entry = latest?.jobs[attempt.job.jobId];
      const abort = Object.values(latest?.operations ?? {}).find(
        (op) =>
          op.kind === "session.abort" &&
          op.status === "completed" &&
          op.job.jobId === entry?.envelope.jobId &&
          op.job.attempt === attempt.attempt &&
          op.job.sessionId === entry?.envelope.sessionId,
      );
      if (
        latest &&
        abort &&
        entry?.result?.outcome === "cancelled" &&
        ["idle", "missing"].includes(
          await adapter.inspectSession(entry.envelope),
        ) &&
        (await store.recoverCancelledAttempt(
          runId,
          latest.revision,
          attempt.issueId,
          abort.operationId,
        ))
      )
        summary.facts.push(
          `${attempt.issueId}/${attempt.attempt}: cancelled executor proven idle; failed attempt consumed, workspace retained for explicit retry`,
        );
    }
  }
  // Check the most recently accepted ref even when its result was fully appended.
  const recovered = await store.getRun(runId);
  const advances = new Map<string, RunOperation>();
  for (const operation of Object.values(recovered?.operations ?? {}))
    if (
      operation.kind === "integration.advance" &&
      operation.status === "completed" &&
      operation.ref
    )
      advances.set(operation.ref, operation);
  for (const [ref, operation] of advances) {
    try {
      const actual = (
        await readReviewGit(directory, ["rev-parse", "--verify", ref])
      ).trim();
      if (actual !== operation.expectedNew)
        throw new Error(`is ${actual}, expected ${operation.expectedNew}`);
      summary.facts.push(`Accepted integration ref ${ref} matches ${actual}`);
    } catch (cause) {
      blocked(
        `Accepted integration ref ${ref} differs or is unavailable: ${String(cause)}`,
      );
    }
  }
  // A terminal SDK result alone is not a committed submission or accepted merge.
  for (const attempt of Object.values(recovered?.issueAttempts ?? {})) {
    summary.facts.push(
      `${attempt.issueId}/${attempt.attempt}: ${attempt.status}; active budget ${attempt.remainingAgentMs ?? attempt.agentTimeoutMs ?? "recorded default"}`,
    );
    if (["executing", "merging"].includes(attempt.status))
      blocked(
        `${attempt.issueId}/${attempt.attempt}: ${attempt.status} completion uncertain; retained attempt requires correlated evidence, no automatic retry`,
      );
    if (attempt.question && !attempt.question.answer)
      summary.facts.push(
        `${attempt.issueId}/${attempt.attempt}: unanswered question retained; explicit resume renews its request identity`,
      );
  }
  for (const round of run.reviewWorkflow?.rounds ?? []) {
    for (const task of round.repairs) {
      for (const attempt of task.attempts) {
        summary.facts.push(
          `${task.id}/${attempt.attempt}: ${attempt.status}, workspace ${attempt.workspace}`,
        );
        if (["intent", "integrating"].includes(attempt.status))
          blocked(
            `${task.id}/${attempt.attempt}: repair completion uncertain; retained attempt will not be dispatched again`,
          );
      }
    }
  }
  if (
    run.execution?.checks.some((c) => ["running", "waiting"].includes(c.status))
  )
    blocked("Validation interrupted; missing check output is not success");
  summary.facts.push(
    "Counters, artifact revisions, approvals and recorded results retained. Explicit /ralph-resume required.",
  );
  const latest = await store.getRun(runId);
  if (
    !latest ||
    latest.control?.epoch !== (run.control?.epoch ?? 0) + 1 ||
    latest.control.source !== "recovery" ||
    !latest.control.cleanupPending ||
    !(await store.recordControl(
      runId,
      {
        status: summary.status,
        source: "recovery",
        facts: summary.facts,
      },
      latest.revision,
    ))
  )
    throw new Error(
      "Recovery state changed during inspection; reconcile again",
    );
  return summary;
}
