import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { continuePlanning } from "../core/orchestrator.js";
import { readReviewGit } from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { readPlanningArtifact, readPrdDraft } from "./artifact-writer.js";
import { artifactHash, explanationHash, issueBundleHash } from "./artifacts.js";
import { publishRevision, savePlanning } from "./generation.js";
import { topologicalOrder, validateIssueGraph } from "./graph.js";
import { handleInterviewResponse } from "./interview.js";
import { queueIssuePlanner } from "./issues.js";
import { queueApprovedPrd, validateWrittenPrd } from "./prd.js";
import type { ArtifactRevision } from "./types.js";

export const completeInterviewInput = z
  .object({
    runId: z.string().min(1),
    attempt: z.number().int().positive(),
    text: z.string().trim().min(1),
    scope: z.array(z.string().trim().min(1)).min(1),
    criteria: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export async function assertPlanningOwner(
  store: RunStore,
  runId: string,
  attempt: number,
  sessionId: string,
) {
  const run = await store.getRun(runId);
  const state = run?.planning;
  if (
    !run ||
    !state ||
    state.protocol !== "native-interview-v1" ||
    !state.owner ||
    state.owner.retired ||
    state.owner.sessionId !== sessionId ||
    state.sessionId !== sessionId ||
    state.owner.attempt !== attempt ||
    (run.control && run.control.status !== "active")
  )
    throw new Error(
      "Stale or inactive planning ownership; inspect /ralph-status",
    );
  return { run, state };
}

export async function completeInterview(
  store: RunStore,
  adapter: OpenCodeAdapter,
  input: z.infer<typeof completeInterviewInput>,
  sessionId: string,
  renew = false,
) {
  const value = completeInterviewInput.parse(input);
  let { run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  );
  if (renew && state.pending?.kind === "explanation") {
    const config = await loadProjectConfig(state.workspace);
    const context = state.proposalContext;
    if (
      !context ||
      context.sha !==
        (await readReviewGit(state.workspace, ["rev-parse", "HEAD"])).trim() ||
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
    ) {
      const next = structuredClone(state);
      delete next.pending;
      delete next.approval;
      await savePlanning(store, run.runId, run.revision, next);
      ({ run, state } = await assertPlanningOwner(
        store,
        value.runId,
        value.attempt,
        sessionId,
      ));
    }
  }
  const hash = explanationHash(value);
  if (!renew && state.approval && state.explanation?.hash === hash) {
    await queueApprovedPrd(store, adapter, run.runId);
    return {
      outcome: "already-completed",
      revision: state.explanation.revision,
      requestId: state.approval.requestId,
    };
  }
  if (!renew && state.approval && state.owner?.stage !== "prd")
    return {
      outcome: "blocked",
      message: "The approved explanation cannot be replaced in this stage",
    };
  if (state.pending && state.phase !== "explanation_approval")
    return {
      outcome: "blocked",
      requestId: state.pending.requestId,
      message: "Resolve the pending native question first",
    };
  if (!renew && state.phase === "explanation_approval" && state.pending)
    return {
      outcome: "already-requested",
      requestId: state.pending.requestId,
      revision: state.pending.revision,
      message:
        "The recorded native approval request is pending; no second request was opened",
    };
  if (!state.pending) {
    const config = await loadProjectConfig(state.workspace);
    const commandHash = commandConfigHash(config.commands);
    if (!renew && commandHash !== state.commandHash)
      return {
        outcome: "blocked",
        message:
          "Command configuration changed; restore approved commands before continuing",
      };
    const sha = (
      await readReviewGit(state.workspace, ["rev-parse", "HEAD"])
    ).trim();
    const branch = (
      await readReviewGit(state.workspace, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
    ).trim();
    const revision = (state.explanation?.revision ?? 0) + 1;
    const label = `Approve revision ${revision}: PRD creation, issue planning, and implementation`;
    const next = structuredClone(state);
    if (renew) {
      next.history = [
        ...(next.history ?? []),
        {
          explanation: state.explanation,
          approval: state.approval,
          prd: state.prd ?? state.prdAcceptance?.revision,
          graph: state.graph ?? state.issueAcceptance?.graph,
          executionEligibility: state.executionEligibility,
        },
      ];
      next.commandHash = commandHash;
      delete next.prd;
      delete next.graph;
      delete next.prdAcceptance;
      delete next.issueAcceptance;
      delete next.issueHandoff;
      delete next.executionEligibility;
      delete next.publication;
      delete next.error;
    }
    next.explanation = {
      revision,
      hash,
      text: value.text,
      scope: value.scope,
      criteria: value.criteria,
    };
    next.proposalContext = {
      sha,
      branch,
      commandHash,
      commandRevision: config.commands.revision,
    };
    next.phase = "explanation_approval";
    delete next.approval;
    delete next.prdDelivery;
    next.pending = {
      kind: "explanation",
      runId: run.runId,
      sessionId,
      workspace: state.workspace,
      requestId: randomUUID(),
      revision,
      question: `${value.text}\nScope:\n${value.scope.join("\n")}\nAcceptance criteria:\n${value.criteria.join("\n")}\nBranch: ${branch}\nFull pinned HEAD SHA: ${sha}\nCommand revision: ${config.commands.revision}\nCommand hash: ${commandHash}\n${renew ? `Previous pinned HEAD: ${state.approval?.sha ?? state.history?.at(-1)?.approval?.sha ?? "unavailable"}\nRevised command configuration: ${JSON.stringify(config.commands)}\n` : ""}Approve revision ${revision} to authorize PRD creation, issue planning, and automatic execution through implementation within this scope. Reject or request changes to return to grilling.`,
      options: [
        {
          label,
          description:
            "Authorize all three stages within this displayed scope, commit, and configuration",
        },
        {
          label: "Request changes",
          description: "Return to grilling without authorization",
        },
      ],
    };
    await savePlanning(store, run.runId, run.revision, next);
  }
  const current = await assertPlanningOwner(
    store,
    run.runId,
    value.attempt,
    sessionId,
  );
  const pending = current.state.pending;
  if (!pending)
    return {
      outcome: "stale",
      message: "The displayed request is no longer pending",
    };
  const response = await adapter.requestUserInput(pending);
  if (!response.ok)
    return {
      outcome: "blocked",
      requestId: pending.requestId,
      error: response.error,
    };
  if (!(await handleInterviewResponse(store, run.runId, response)))
    return {
      outcome: "stale",
      requestId: pending.requestId,
      message:
        "Native result does not match current ownership, revision, commit or configuration",
    };
  const latest = await store.getRun(run.runId);
  if (!latest?.planning?.approval)
    return {
      outcome: "correctable-invalid",
      message:
        "Approval rejected. Continue grilling and propose a new revision.",
    };
  await queueApprovedPrd(store, adapter, run.runId);
  return {
    outcome: "accepted",
    revision: latest.planning.explanation?.revision,
    requestId: pending.requestId,
  };
}

export const completePrdInput = z
  .object({
    runId: z.string().regex(/^feature-[A-Za-z0-9-]+$/),
    attempt: z.number().int().positive(),
    path: z.literal("PRD.md"),
  })
  .strict();

let storeSequence = 0;
const storeIds = new WeakMap<RunStore, number>();
function stateKey(store: RunStore) {
  if (!storeIds.has(store)) storeIds.set(store, ++storeSequence);
  return storeIds.get(store);
}
const prdCompletions = new Map<string, Promise<unknown>>();

/** Serialize live retries; revision guards protect persisted transitions. */
export async function completePrd(
  store: RunStore,
  adapter: OpenCodeAdapter,
  input: z.infer<typeof completePrdInput>,
  sessionId: string,
) {
  const value = completePrdInput.parse(input);
  const key = `${stateKey(store)}:${value.runId}`;
  const previous = prdCompletions.get(key);
  const operation = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(() => acceptPrd(store, adapter, value, sessionId));
  prdCompletions.set(key, operation);
  try {
    return await operation;
  } finally {
    if (prdCompletions.get(key) === operation) prdCompletions.delete(key);
  }
}

async function acceptPrd(
  store: RunStore,
  adapter: OpenCodeAdapter,
  value: z.infer<typeof completePrdInput>,
  sessionId: string,
) {
  const run = await store.getRun(value.runId);
  const state = run?.planning;
  if (
    !run ||
    !state ||
    state.protocol !== "native-interview-v1" ||
    (run.control && run.control.status !== "active")
  )
    throw new Error(
      "Stale or inactive planning ownership; inspect /ralph-status",
    );
  if (state.pending || state.revisionProposal)
    return {
      outcome: "blocked",
      requestId: state.pending?.requestId,
      message: "Resolve the pending product decision or scope approval first",
    };
  const accepted = state.prdAcceptance;
  if (
    accepted
      ? accepted.sessionId !== sessionId || accepted.attempt !== value.attempt
      : state.owner?.retired ||
        state.owner?.stage !== "prd" ||
        state.owner.sessionId !== sessionId ||
        state.owner.attempt !== value.attempt ||
        state.phase !== "prd_generation"
  )
    throw new Error(
      "Stale PRD stage ownership; use the current owner and attempt",
    );
  if (
    !state.approval ||
    !state.explanation ||
    state.approval.hash !== explanationHash(state.explanation) ||
    state.approval.revision !== state.explanation.revision ||
    state.approval.sessionId !== sessionId
  )
    throw new Error("Current explanation approval is required");
  if (state.issueHandoff?.focused && state.issueHandoff.queued)
    return {
      outcome: "accepted",
      prd: state.prd,
      sessionId: state.issueHandoff.sessionId,
    };
  const config = await loadProjectConfig(state.workspace);
  if (
    commandConfigHash(config.commands) !== state.approval.commandHash ||
    (await readReviewGit(state.workspace, ["rev-parse", "HEAD"])).trim() !==
      state.approval.sha
  )
    return {
      outcome: "blocked",
      message:
        "Approved commit or command configuration changed; renew explanation approval",
    };
  let next = structuredClone(state);
  if (!accepted) {
    let text: string;
    try {
      text = await readFile(
        await readPrdDraft(state.workspace, value.runId, value.attempt),
        "utf8",
      );
      validateWrittenPrd(text, state.explanation);
    } catch (cause) {
      return {
        outcome: "correctable-invalid",
        message: `Fix PRD.md and call ralph_complete_prd again: ${String(cause)}`,
      };
    }
    const prdRevision =
      Math.max(0, ...(state.history ?? []).map((h) => h.prd?.revision ?? 0)) +
      1;
    const revision: ArtifactRevision = {
      revision: prdRevision,
      hash: artifactHash(text),
      artifactPath: `.ralph/features/${value.runId}/prd-${prdRevision}/PRD.md`,
    };
    next.prdAcceptance = {
      sessionId,
      attempt: value.attempt,
      path: value.path,
      text,
      revision,
    };
    await savePlanning(store, value.runId, run.revision, next);
  }
  let current = await store.getRun(value.runId);
  if (!current?.planning?.prdAcceptance)
    throw new Error("Missing PRD acceptance intent");
  next = structuredClone(current.planning);
  const intent = current.planning.prdAcceptance;
  if (!next.prd) {
    const publication = await publishRevision(
      store,
      current.revision,
      next,
      value.runId,
      `prd-${intent.revision.revision}`,
      { "PRD.md": intent.text },
      `complete-prd-${intent.attempt}`,
    );
    next.prd = intent.revision;
    next.managedArtifacts = {
      ...next.managedArtifacts,
      [intent.revision.artifactPath]: intent.revision.hash,
    };
    await savePlanning(store, value.runId, publication.revision, next);
  }
  try {
    await queueIssuePlanner(store, adapter, value.runId);
  } catch (cause) {
    return {
      outcome: "blocked",
      prd: intent.revision,
      message: `PRD accepted; retry this completion to reconcile the issue handoff: ${String(cause)}`,
    };
  }
  current = await store.getRun(value.runId);
  return {
    outcome: "accepted",
    prd: current?.planning?.prd,
    sessionId: current?.planning?.issueHandoff?.sessionId,
  };
}

export const completeIssuesInput = z
  .object({
    runId: z.string().regex(/^feature-[A-Za-z0-9-]+$/),
    attempt: z.number().int().positive(),
    graphPath: z.literal("graph.json"),
  })
  .strict();
const issueCompletions = new Map<string, ReturnType<typeof acceptIssues>>();

export async function completeIssues(
  store: RunStore,
  adapter: OpenCodeAdapter,
  input: z.infer<typeof completeIssuesInput>,
  sessionId: string,
) {
  const value = completeIssuesInput.parse(input);
  const key = `${stateKey(store)}:${value.runId}`;
  const previous = issueCompletions.get(key);
  const operation = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(() => acceptIssues(store, adapter, value, sessionId));
  issueCompletions.set(key, operation);
  try {
    return await operation;
  } finally {
    if (issueCompletions.get(key) === operation) issueCompletions.delete(key);
  }
}

async function acceptIssues(
  store: RunStore,
  adapter: OpenCodeAdapter,
  value: z.infer<typeof completeIssuesInput>,
  sessionId: string,
) {
  let { run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  );
  if (
    state.owner?.retired ||
    state.owner?.stage !== "issues" ||
    !state.prd ||
    !state.approval?.sha ||
    !state.explanation ||
    state.approval.hash !== explanationHash(state.explanation) ||
    state.approval.revision !== state.explanation.revision
  )
    throw new Error(
      "Current issue stage ownership and explanation authorization required",
    );
  if (state.pending || state.revisionProposal)
    return {
      outcome: "blocked",
      requestId: state.pending?.requestId,
      message: "Resolve the pending product decision or scope approval first",
    };
  if (state.issueAcceptance?.result) return state.issueAcceptance.result;
  try {
    const config = await loadProjectConfig(state.workspace);
    if (
      commandConfigHash(config.commands) !== state.approval.commandHash ||
      config.commands.revision !== state.approval.commandRevision ||
      (await readReviewGit(state.workspace, ["rev-parse", "HEAD"])).trim() !==
        state.approval.sha
    )
      throw new Error("Approved commit or command configuration changed");
  } catch (cause) {
    const next = structuredClone(state);
    next.error = {
      code: "baseline-blocked",
      message: `Restore approved inputs or renew explanation approval: ${String(cause)}`,
    };
    await savePlanning(store, run.runId, run.revision, next);
    return { outcome: "blocked", message: next.error.message };
  }
  try {
    const prdText = await readFile(
      await readPlanningArtifact(state.workspace, state.prd.artifactPath),
      "utf8",
    );
    if (artifactHash(prdText) !== state.prd.hash)
      throw new Error("Accepted PRD changed");
  } catch (cause) {
    const next = structuredClone(state);
    next.error = {
      code: "baseline-blocked",
      message: `Accepted PRD unavailable or changed: ${String(cause)}`,
    };
    await savePlanning(store, run.runId, run.revision, next);
    return { outcome: "blocked", message: next.error.message };
  }
  if (!state.issueAcceptance) {
    try {
      const draft = `.ralph/features/${run.runId}/issues-draft-${value.attempt}/`;
      const read = async (path: string) => {
        const text = await readFile(
          await readPlanningArtifact(state.workspace, draft + path),
          "utf8",
        );
        if (state.managedArtifacts?.[draft + path] !== artifactHash(text))
          throw new Error(`Missing or changed owned draft ${path}`);
        return text;
      };
      const raw = JSON.parse(await read(value.graphPath));
      const files: Record<string, string> = {};
      if (!Array.isArray(raw.issues)) throw new Error("Graph requires issues");
      for (const issue of raw.issues) {
        if (
          typeof issue.artifactPath !== "string" ||
          !/^issues\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(
            issue.artifactPath,
          )
        )
          throw new Error("Invalid issue draft reference");
        files[issue.artifactPath] = await read(issue.artifactPath);
      }
      const graph = validateIssueGraph(raw, files, state.prd);
      const next = structuredClone(state);
      const graphRevision =
        Math.max(
          0,
          ...(state.history ?? []).map((h) => h.graph?.revision ?? 0),
        ) + 1;
      next.issueAcceptance = {
        sessionId,
        attempt: value.attempt,
        graph: {
          revision: graphRevision,
          hash: issueBundleHash(graph, files),
          artifactPath: `.ralph/features/${run.runId}/graph-${graphRevision}/graph.json`,
          value: graph,
          files,
          order: topologicalOrder(graph),
        },
      };
      await savePlanning(store, run.runId, run.revision, next);
    } catch (cause) {
      // Store ownership/revision failures must not be reported as successful acceptance.
      if (String(cause).includes("Stale")) throw cause;
      return {
        outcome: "correctable-invalid",
        message: `Fix issue drafts and retry ralph_complete_issues: ${String(cause)}`,
      };
    }
  }
  ({ run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  ));
  const intent = state.issueAcceptance;
  if (
    !intent ||
    !state.approval?.sha ||
    !state.approval.commandHash ||
    !state.approval.commandRevision ||
    !state.prd
  )
    throw new Error("Missing issue acceptance intent or scope authorization");
  if (!state.graph) {
    const next = structuredClone(state);
    const files = {
      ...intent.graph.files,
      "graph.json": JSON.stringify(intent.graph.value, null, 2),
    };
    const publication = await publishRevision(
      store,
      run.revision,
      next,
      run.runId,
      `graph-${intent.graph.revision}`,
      files,
      `complete-issues-${value.attempt}`,
    );
    next.graph = intent.graph;
    next.managedArtifacts = { ...next.managedArtifacts };
    for (const [path, text] of Object.entries(files))
      next.managedArtifacts[`${publication.directory}/${path}`] =
        artifactHash(text);
    next.selectedCommit = state.approval.sha;
    next.executionEligibility = {
      revision: intent.graph.revision,
      selectedCommit: state.approval.sha,
      prdHash: state.prd.hash,
      graphHash: intent.graph.hash,
      requestId: state.approval.requestId,
      messageId: state.approval.messageId,
      timestamp: new Date().toISOString(),
      explanationHash: state.approval.hash,
      commandHash: state.approval.commandHash,
      commandRevision: state.approval.commandRevision,
    };
    next.phase = "execution_approved";
    delete next.error;
    await savePlanning(store, run.runId, publication.revision, next);
  }
  const latest = await store.getRun(run.runId);
  if (!latest?.planning?.issueAcceptance)
    throw new Error("Issue acceptance lost");
  const next = structuredClone(latest.planning);
  const result = {
    outcome: "accepted" as const,
    graph: {
      revision: intent.graph.revision,
      hash: intent.graph.hash,
      artifactPath: intent.graph.artifactPath,
    },
  };
  if (!next.issueAcceptance) throw new Error("Missing issue acceptance");
  next.issueAcceptance.result = result;
  await savePlanning(store, run.runId, latest.revision, next);
  // Durable acceptance precedes effects. Interrupted execution resumes through the
  // existing explicit recovery path; tool retries never redispatch accepted work.
  await continuePlanning(store, adapter, run.runId);
  return result;
}
