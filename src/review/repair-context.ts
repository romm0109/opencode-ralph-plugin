import type { RunRecord } from "../core/types.js";
import type { IssueSpec } from "../planning/graph.js";

/** Repairs are authorized by a completed dual review, outside the approved graph. */
export function currentRepair(run: RunRecord, issueId: string) {
  const workflow = run.reviewWorkflow;
  const round = workflow?.rounds.at(-1);
  if (
    workflow?.status !== "running" ||
    !round?.code ||
    !round.functional ||
    round.snapshot.round >= 3 ||
    run.planning?.graph?.value.issues.some((issue) => issue.id === issueId)
  )
    return undefined;
  return round.repairs.find(
    (task) => task.id === issueId && task.status === "pending",
  );
}
export function executionIssue(
  run: RunRecord,
  issueId: string,
):
  | {
      issue: IssueSpec;
      text: string;
    }
  | undefined {
  const original = run.planning?.graph?.value.issues.find(
    (i) => i.id === issueId,
  );
  if (original)
    return {
      issue: original,
      text: run.planning?.graph?.files[original.artifactPath] ?? "",
    };
  const repair = currentRepair(run, issueId);
  if (!repair) return undefined;
  return {
    issue: {
      id: repair.id,
      title: `Repair ${repair.findingIds.join(", ")}`,
      artifactPath: `issues/${repair.id}.md`,
      dependencies: repair.dependencies,
      acceptanceCriteria: repair.acceptanceCriteria,
      testableBehaviors: repair.testBehaviors,
    },
    text: `Dedicated TDD repair (do not expand approved scope):\n${JSON.stringify(repair)}\nA finding may be disputed with {"kind":"finding_dispute","findingIds":["role:id"],"evidenceRefs":["counterexample evidence"]}.`,
  };
}
