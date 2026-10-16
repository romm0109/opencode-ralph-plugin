import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { waitForDispatch } from "../commands/control.js";
import { commandConfigHash, parseCommandConfig } from "../config/commands.js";
import { gitOutput } from "../git/worktrees.js";
import {
  createApprovedEnvironment,
  disposeEnvironment,
  prepareEnvironment,
} from "../process/environment.js";
import {
  type CommandContext,
  type CommandResult,
  runCommand,
} from "../process/runner.js";

export interface ValidationSummary {
  status: "passed" | "passed_with_omissions" | "failed";
  candidateCommit: string;
  commandHash: string;
  commandRevision: number;
  checks: {
    id: string;
    status: "passed" | "failed" | "skipped";
    reason?: string;
    result?: CommandResult;
  }[];
  lifecycle: CommandResult[];
  skippedCheckIds: string[];
  blocker?: string;
  failureCause?: import("../core/types.js").Failure;
}
export async function validateCandidate(
  context: CommandContext,
): Promise<ValidationSummary> {
  const { store, job, config } = context;
  const initial = await store.getRun(job.runId);
  const epoch = initial?.control?.epoch ?? 0;
  const summary: ValidationSummary = {
    status: "failed",
    candidateCommit: job.baseCommit,
    commandHash: commandConfigHash(config),
    commandRevision: config.revision,
    checks: [],
    lifecycle: [],
    skippedCheckIds: [...(initial?.validationSkips ?? [])],
  };
  const environment = createApprovedEnvironment(context, { skipChecks: true });
  try {
    const saved = parseCommandConfig(
      JSON.parse(
        await readFile(
          join(
            context.sourceWorkspace ?? job.workspace,
            ".ralph/commands.json",
          ),
          "utf8",
        ),
      ),
    );
    if (
      commandConfigHash(saved) !== summary.commandHash ||
      initial?.planning?.commandHash !== summary.commandHash
    )
      throw new Error(
        "Candidate validation requires the exact approved command configuration",
      );
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.baseCommit) ||
      (
        await gitOutput(job.workspace, ["rev-parse", "HEAD^{commit}"])
      ).trim() !== job.baseCommit
    )
      throw new Error("Candidate HEAD differs from the exact approved commit");
    await prepareEnvironment(environment, job);
    for (const command of config.commands.filter(
      (c) =>
        c.phase === "check" && c.platforms.some((p) => p === process.platform),
    )) {
      if (summary.skippedCheckIds.includes(command.id)) {
        summary.checks.push({
          id: command.id,
          status: "skipped",
          reason: "Earlier timeout in this feature run",
        });
        continue;
      }
      await waitForDispatch(store, job.runId);
      if (((await store.getRun(job.runId))?.control?.epoch ?? 0) !== epoch)
        throw new Error("Stale validation dispatch after interruption");
      const result = await runCommand(command, context);
      if (
        result.status === "timed_out" &&
        !result.cleanupError &&
        !result.cause
      ) {
        summary.skippedCheckIds.push(command.id);
        summary.checks.push({
          id: command.id,
          status: "skipped",
          reason: "Timed out; omitted for the rest of this run",
          result,
        });
        // Independent executor/session writes may advance the journal revision.
        // Retry that CAS while preserving the validation and control identity.
        for (;;) {
          const run = await store.getRun(job.runId);
          if (
            !run?.baseline ||
            run.baseline.operationId !== initial?.baseline?.operationId ||
            (run.control?.epoch ?? 0) !== epoch ||
            (run.control && run.control.status !== "active")
          )
            throw new Error("Stale timeout completion");
          if (
            await store.recordBaseline(
              job.runId,
              run.revision,
              run.baseline,
              summary.skippedCheckIds,
            )
          )
            break;
        }
      } else if (
        result.status !== "completed" ||
        result.exitCode !== 0 ||
        result.cause ||
        result.cleanupError
      ) {
        summary.checks.push({ id: command.id, status: "failed", result });
        summary.failureCause = {
          code:
            result.status === "permission_denied"
              ? "permission-denied"
              : result.status === "cancelled"
                ? "cancelled"
                : "baseline-blocked",
          message:
            result.cause?.message ??
            `Check ${command.id}: ${result.status}, exit ${result.exitCode}`,
          cause: result,
        };
        throw new Error(
          `Check ${command.id}: ${result.status}, exit ${result.exitCode}${result.cause ? `: ${result.cause.message}` : ""}`,
        );
      } else summary.checks.push({ id: command.id, status: "passed", result });
    }
    summary.status = summary.checks.some((c) => c.status === "skipped")
      ? "passed_with_omissions"
      : "passed";
  } catch (cause) {
    summary.blocker = String(cause);
  } finally {
    const cleanup = await disposeEnvironment(environment, job).catch(
      (cause) => ({
        status: "failed" as const,
        reason: String(cause),
        evidenceRefs: [],
      }),
    );
    summary.lifecycle = environment.results;
    const waiting = summary.lifecycle.find((result) =>
      ["permission_denied", "cancelled"].includes(result.status),
    );
    if (waiting)
      summary.failureCause = {
        code:
          waiting.status === "permission_denied"
            ? "permission-denied"
            : "cancelled",
        message: waiting.cause?.message ?? waiting.status,
        cause: waiting,
      };
    if (cleanup.status !== "completed") {
      summary.status = "failed";
      summary.blocker = cleanup.reason ?? "Environment cleanup failed";
    }
  }
  try {
    if (
      (
        await gitOutput(job.workspace, ["rev-parse", "HEAD^{commit}"])
      ).trim() !== job.baseCommit ||
      (
        await gitOutput(job.workspace, [
          "status",
          "--porcelain",
          "--untracked-files=no",
        ])
      ).trim()
    )
      throw new Error(
        "Candidate changed during validation; evidence does not match the approved commit",
      );
  } catch (cause) {
    summary.status = "failed";
    summary.blocker = String(cause);
  }
  const latest = await store.getRun(job.runId);
  if (
    latest?.baseline?.operationId !== initial?.baseline?.operationId ||
    (latest?.control?.epoch ?? 0) !== epoch ||
    (latest?.control && !["active", "paused"].includes(latest.control.status))
  ) {
    summary.status = "failed";
    summary.blocker = "Stale validation completion";
  }
  return summary;
}
