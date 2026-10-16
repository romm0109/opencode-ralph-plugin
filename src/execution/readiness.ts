import type { ExecutionEvidence, RunRecord } from "../core/types.js";
import { validateIssueGraph } from "../planning/graph.js";
import { type AttemptPolicy, attemptPolicy } from "./attempts.js";

/** Pure readiness: a submission is never a dependency completion. */
export function reconcileReadiness(
  run: RunRecord,
  queue: string[] = [],
  policy: AttemptPolicy = attemptPolicy,
): ExecutionEvidence {
  const planning = run.planning;
  if (!planning?.graph || !planning.prd)
    throw new Error("Missing approved graph");
  const graph = validateIssueGraph(
    planning.graph.value,
    planning.graph.files,
    planning.prd,
  );
  const states = new Map<string, ExecutionEvidence["issues"][number]>();
  function resolve(id: string): ExecutionEvidence["issues"][number] {
    const cached = states.get(id);
    if (cached) return cached;
    const issue = graph.issues.find((item) => item.id === id);
    if (!issue) throw new Error("Unknown dependency");
    const parents = issue.dependencies.map(resolve);
    const attempt = run.issueAttempts?.[id];
    const blockers = parents
      .filter((p) => ["blocked", "failed"].includes(p.status))
      .map((p) => p.id);
    let status: ExecutionEvidence["issues"][number]["status"];
    if (attempt?.status === "integrated") status = "integrated";
    else if (
      attempt?.status === "exhausted" ||
      (attempt?.status === "failed" && attempt.attempt >= policy.maxAttempts)
    )
      status = "failed";
    else if (attempt?.status === "waiting" || blockers.length)
      status = "blocked";
    else if (attempt && ["submitted", "merging"].includes(attempt.status))
      status = "integration_queued";
    else if (attempt?.status === "executing") status = "running";
    else
      status = parents.every((p) => p.status === "integrated")
        ? "ready"
        : "pending";
    const result = {
      id,
      title: issue.title,
      dependencies: issue.dependencies,
      status,
      blockers,
    };
    states.set(id, result);
    return result;
  }
  const issues = graph.issues.map((issue) => resolve(issue.id));
  const checks: ExecutionEvidence["checks"] = Object.values(
    run.issueAttempts ?? {},
  ).flatMap((attempt) =>
    (attempt.validation?.checks ?? []).map((check) => ({
      id: check.id,
      status: check.status,
      ...(check.reason ? { reason: check.reason } : {}),
      attempt: attempt.attempt,
      candidateCommit: attempt.validation?.candidateCommit ?? "",
      commandRevision: attempt.validation?.commandRevision ?? 0,
    })),
  );
  return {
    issues,
    integrationQueue: queue,
    checks,
    verification: issues.some(
      (i) => i.status === "failed" || i.status === "blocked",
    )
      ? "failed"
      : issues.every((i) => i.status === "integrated") &&
          !run.validationSkips?.length &&
          !checks.some((c) => c.status === "skipped")
        ? "passed"
        : "incomplete",
  };
}
