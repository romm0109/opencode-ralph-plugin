import { explanationHash } from "./artifacts.js";
import type { PlanningState } from "./types.js";

/** Match the accepted bundle to the real scope approval; no new human event. */
export function executionEligibilityMatchesRevision(state: PlanningState) {
  const approval = state.executionEligibility;
  return !!(
    approval &&
    state.protocol === "native-interview-v1" &&
    !!state.approval &&
    !!state.explanation &&
    state.issueAcceptance?.graph.hash === state.graph?.hash &&
    state.prdAcceptance?.revision.hash === state.prd?.hash &&
    state.approval.hash === explanationHash(state.explanation) &&
    state.approval.revision === state.explanation.revision &&
    approval.explanationHash === state.approval.hash &&
    approval.requestId === state.approval.requestId &&
    approval.messageId === state.approval.messageId &&
    approval.selectedCommit === state.approval.sha &&
    approval.commandHash === state.approval.commandHash &&
    approval.commandHash === state.commandHash &&
    approval.commandRevision === state.approval.commandRevision &&
    state.prd &&
    state.graph &&
    approval.revision === state.graph.revision &&
    approval.prdHash === state.prd.hash &&
    approval.graphHash === state.graph.hash
  );
}
