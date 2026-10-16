import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRoleInstructions } from "../agents/skills.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { readReviewGit } from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { readPlanningArtifact } from "./artifact-writer.js";
import { artifactHash } from "./artifacts.js";
import {
  queuePlanningPrompt,
  registerPlanningAttempt,
  savePlanning,
} from "./generation.js";

/** Durable, asynchronous stage handoff. An inbox receipt never waits for completion. */
export async function queueIssuePlanner(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  let run = await store.getRun(runId);
  if (
    !run?.planning?.prd ||
    !run.planning.prdAcceptance ||
    !run.planning.approval
  )
    throw new Error("Accepted native PRD required");
  if (run.control && run.control.status !== "active")
    throw new Error("Inactive issue handoff; inspect /ralph-status");
  const acceptedPrd = run.planning.prd;
  if (
    artifactHash(
      await readFile(
        await readPlanningArtifact(
          run.planning.workspace,
          acceptedPrd.artifactPath,
        ),
        "utf8",
      ),
    ) !== acceptedPrd.hash
  )
    throw new Error("Accepted PRD bytes changed; handoff blocked");
  const approvedConfig = await loadProjectConfig(run.planning.workspace);
  if (
    commandConfigHash(approvedConfig.commands) !==
      run.planning.approval.commandHash ||
    (
      await readReviewGit(run.planning.workspace, ["rev-parse", "HEAD"])
    ).trim() !== run.planning.approval.sha
  )
    throw new Error(
      "Approved commit or commands changed; renew explanation approval",
    );
  if (
    !adapter.findIssueSession ||
    !adapter.createIssueSession ||
    !adapter.queueStagePrompt
  )
    throw new Error(
      "Issue session creation/reconciliation or queue is unavailable",
    );
  let next = structuredClone(run.planning);
  if (!next.issueHandoff) {
    const config = await loadProjectConfig(next.workspace);
    const skill = await loadRoleInstructions(
      next.workspace,
      "issues",
      config.skillPaths,
    );
    let projectInstructions =
      "No root AGENTS.md exists; inspect repository-local instructions.";
    try {
      projectInstructions = await readFile(
        join(next.workspace, "AGENTS.md"),
        "utf8",
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const prd = run.planning.prd;
    const text = await readFile(join(next.workspace, prd.artifactPath), "utf8");
    if (artifactHash(text) !== prd.hash)
      throw new Error("Accepted PRD bytes changed");
    next.settings.skills.issues = { path: skill.path, hash: skill.hash };
    next.issueHandoff = {
      jobId: `issues-prd-${prd.revision}`,
      attempt: 1,
      prd,
      messageId: `msg_ralph-issues-${runId}-${prd.revision}`,
      prompt: `${skill.text}
Ralph issue-planning stage: runId=${runId}, attempt=1.
Repository: ${next.workspace}
Repository context: read AGENTS.md, repository instructions, docs/wiki and relevant code/tests before drafting.
Project instructions (AGENTS.md):
${projectInstructions}
PRD revision: ${JSON.stringify(prd)}
Exact accepted PRD content:
${text}
Approved explanation: ${JSON.stringify(next.explanation)}
Product decision history: ${JSON.stringify(next.decisions ?? [])}
Retained integration context: ${JSON.stringify(next.scopeChange ?? null)}
Already integrated issue IDs must remain satisfied; add follow-up issues for new work instead of repeating or rolling back integrated work.
Authorization: ${JSON.stringify(next.approval)}
Pinned HEAD: ${next.approval?.sha}
Approved commands: ${JSON.stringify(config.commands)}
Draft directory: .ralph/features/${runId}/issues-draft-1
Use ralph_write_planning_file for graph.json and issues/<number>-<slug>.md only.
graph.json is a strict object {schemaVersion:1, prdRevision:<exact PRD revision object above>, issues:[{id,title,artifactPath,dependencies,acceptanceCriteria,testableBehaviors}]}.
Dependencies are issue IDs; acceptanceCriteria and testableBehaviors are nonempty string arrays.
Explore deeply, author self-sufficient vertical slices, then call ralph_complete_issues with runId, attempt and graph path. Do not start execution or request breakdown approval. Prose cannot complete this stage.
`,
    };
    await savePlanning(store, runId, run.revision, next);
  }
  run = await store.getRun(runId);
  if (!run?.planning?.issueHandoff) throw new Error("Missing handoff intent");
  next = structuredClone(run.planning);
  let handoff = next.issueHandoff;
  if (!handoff) throw new Error("Missing handoff");
  if (!handoff.sessionId) {
    // Always inspect correlated host metadata before retrying an ambiguous creation.
    let sessionId = await adapter.findIssueSession(
      next.workspace,
      runId,
      handoff.jobId,
      handoff.attempt,
    );
    if (!sessionId) {
      handoff.creationStarted = true;
      await savePlanning(store, runId, run.revision, next);
      const model =
        next.settings.models.issues ?? next.settings.models.interview;
      if (!model) throw new Error("Missing issue planning model");
      sessionId = await adapter.createIssueSession(
        next.workspace,
        runId,
        handoff.jobId,
        handoff.attempt,
        model,
      );
    }
    const latest = await store.getRun(runId);
    if (
      !latest?.planning?.issueHandoff ||
      latest.planning.issueHandoff.jobId !== handoff.jobId
    )
      throw new Error("Stale issue-session attachment");
    next = structuredClone(latest.planning);
    if (!next.issueHandoff) throw new Error("Missing handoff");
    next.issueHandoff.sessionId = sessionId;
    await savePlanning(store, runId, latest.revision, next);
  }
  run = await store.getRun(runId);
  if (!run?.planning?.issueHandoff?.sessionId)
    throw new Error("Missing attached issue session");
  next = structuredClone(run.planning);
  handoff = next.issueHandoff;
  if (!handoff?.sessionId) throw new Error("Missing handoff session");
  if (next.owner?.stage !== "issues") {
    next.owner = {
      stage: "issues",
      sessionId: handoff.sessionId,
      attempt: handoff.attempt,
    };
    next.sessionId = handoff.sessionId;
    next.phase = "issue_generation";
    await savePlanning(store, runId, run.revision, next);
  }
  if (!handoff.queued) {
    await registerPlanningAttempt(
      store,
      runId,
      handoff.messageId,
      handoff.prompt,
    );
    await queuePlanningPrompt(
      store,
      adapter,
      runId,
      handoff.sessionId,
      handoff.messageId,
      handoff.prompt,
    );
    const latest = await store.getRun(runId);
    if (
      !latest?.planning?.issueHandoff ||
      latest.planning.owner?.sessionId !== handoff.sessionId
    )
      throw new Error("Stale issue prompt receipt");
    next = structuredClone(latest.planning);
    if (!next.issueHandoff) throw new Error("Missing handoff");
    next.issueHandoff.queued = true;
    await savePlanning(store, runId, latest.revision, next);
  }
  if (!handoff.focused) {
    await adapter.focusStageSession?.(
      next.workspace,
      runId,
      handoff.sessionId,
      "issues",
    );
    const latest = await store.getRun(runId);
    if (!latest?.planning?.issueHandoff) throw new Error("Stale issue focus");
    next = structuredClone(latest.planning);
    if (!next.issueHandoff) throw new Error("Missing handoff");
    next.issueHandoff.focused = true;
    await savePlanning(store, runId, latest.revision, next);
  }
}
