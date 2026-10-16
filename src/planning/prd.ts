import { loadRoleInstructions } from "../agents/skills.js";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { readReviewGit } from "../git/review-workspace.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import { explanationHash } from "./artifacts.js";
import {
  queuePlanningPrompt,
  registerPlanningAttempt,
  savePlanning,
} from "./generation.js";

/** Persist delivery intent before queueing an inbox prompt in the active session. */
export async function queueApprovedPrd(
  store: RunStore,
  adapter: OpenCodeAdapter,
  runId: string,
) {
  const run = await store.getRun(runId);
  const state = run?.planning;
  if (
    !run ||
    !state?.approval ||
    !state.owner ||
    !state.explanation ||
    state.protocol !== "native-interview-v1" ||
    state.approval.hash !== explanationHash(state.explanation) ||
    state.approval.revision !== state.explanation.revision ||
    state.approval.sessionId !== state.owner.sessionId ||
    (run.control && run.control.status !== "active")
  )
    throw new Error("PRD delivery requires current native authorization");
  if (state.prdDelivery?.status === "queued") return;
  if (!adapter.queueStagePrompt)
    throw new Error("Same-session prompt queue is unavailable");
  const config = await loadProjectConfig(state.workspace);
  if (
    state.approval.commandHash !== commandConfigHash(config.commands) ||
    state.approval.sha !==
      (await readReviewGit(state.workspace, ["rev-parse", "HEAD"])).trim()
  )
    throw new Error(
      "Approved commit or command configuration changed; renewed approval is required",
    );
  let next = structuredClone(state);
  if (!next.prdDelivery) {
    const skill = await loadRoleInstructions(
      state.workspace,
      "prd",
      config.skillPaths,
    );
    next.settings.skills.prd = { path: skill.path, hash: skill.hash };
    delete next.revisionProposal;
    next.owner = { ...state.owner, stage: "prd" };
    next.phase = "prd_generation";
    next.prdDelivery = {
      id: `msg_ralph-prd-${runId}-${state.explanation.revision}`,
      status: "intent",
      text: `${skill.text}\nRalph PRD stage: runId=${runId}, attempt=${state.owner.attempt}.\nApproved explanation: ${JSON.stringify(state.explanation)}\nPinned HEAD: ${state.approval.sha}\nCommand revision: ${state.approval.commandRevision}\nApproval reference (include verbatim in PRD): Approved explanation: revision ${state.explanation.revision}, hash ${state.explanation.hash}\nDraft directory: .ralph/features/${runId}/prd-draft-${state.owner.attempt}\nWrite PRD.md using ralph_write_planning_file, then finish with ralph_complete_prd({runId, attempt, path: "PRD.md"}). Product decision history: ${JSON.stringify(state.decisions ?? [])}\nRetained integration context: ${JSON.stringify(state.scopeChange ?? null)}\nAsk missing product decisions using ralph_request_product_decision. Scope changes require renewed explanation approval. Do not implement project code or begin issue planning.`,
    };
    await savePlanning(store, runId, run.revision, next);
  }
  const delivery = next.prdDelivery;
  if (!delivery) throw new Error("Missing PRD delivery intent");
  await registerPlanningAttempt(store, runId, delivery.id, delivery.text);
  await queuePlanningPrompt(
    store,
    adapter,
    runId,
    state.owner.sessionId,
    delivery.id,
    delivery.text,
  );
  const latest = await store.getRun(runId);
  if (!latest?.planning || latest.planning.prdDelivery?.id !== delivery.id)
    throw new Error("Stale PRD delivery");
  next = structuredClone(latest.planning);
  next.prdDelivery = { ...delivery, status: "queued" };
  await savePlanning(store, runId, latest.revision, next);
}

/** The full create-prd template has thirteen mandatory, nonempty sections.
 * API Specification and Appendix are conditional and may be omitted or N/A. */
export function validateWrittenPrd(
  text: string,
  explanation: NonNullable<import("./types.js").PlanningState["explanation"]>,
) {
  if (!text.trim()) throw new Error("PRD is empty");
  const sections = new Map<string, string>();
  const headings = [...text.matchAll(/^##\s+(?:[0-9]+[.)]\s*)?(.+)$/gm)];
  for (const [index, match] of headings.entries()) {
    const name = (match[1] ?? "").trim().toLowerCase();
    if (sections.has(name)) throw new Error(`Duplicate PRD section: ${name}`);
    sections.set(
      name,
      text
        .slice(
          (match.index ?? 0) + match[0].length,
          headings[index + 1]?.index ?? text.length,
        )
        .trim(),
    );
  }
  for (const names of [
    ["Executive Summary"],
    ["Mission"],
    ["Target Users"],
    ["MVP Scope"],
    ["User Stories"],
    ["Core Architecture & Patterns"],
    ["Tools/Features", "Tools and Feature Specifications"],
    ["Technology Stack"],
    ["Security & Configuration"],
    ["Success Criteria"],
    ["Implementation Phases"],
    ["Future Considerations"],
    ["Risks & Mitigations"],
  ]) {
    if (
      !names.some((name) =>
        sections
          .get(name.toLowerCase())
          ?.replace(/^#+.*$/gm, "")
          .trim(),
      )
    )
      throw new Error(`Missing or empty required section: ${names[0]}`);
  }
  const reference = `Approved explanation: revision ${explanation.revision}, hash ${explanation.hash}`;
  if (!text.includes(reference))
    throw new Error(`Include exact approval reference: ${reference}`);
}
