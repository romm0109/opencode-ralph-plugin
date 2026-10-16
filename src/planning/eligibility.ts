import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { readReviewGit } from "../git/review-workspace.js";
import { executionEligibilityMatchesRevision } from "./approvals.js";
import { readPlanningArtifact } from "./artifact-writer.js";
import { artifactHash } from "./artifacts.js";
import type { PlanningState } from "./types.js";

/** Recheck mutable repository inputs at execution, review and recovery boundaries. */
export async function assertNativeExecutionInputs(
  state: PlanningState,
  runId: string,
) {
  if (state.protocol !== "native-interview-v1")
    throw new Error("Unsupported saved workflow; a fresh workflow is required");
  if (!executionEligibilityMatchesRevision(state) || !state.prd || !state.graph)
    throw new Error("Accepted bundle execution eligibility changed");
  const config = await loadProjectConfig(state.workspace);
  if (
    commandConfigHash(config.commands) !==
      state.executionEligibility?.commandHash ||
    config.commands.revision !== state.executionEligibility.commandRevision
  )
    throw new Error("Approved command configuration changed");
  if (
    (await readReviewGit(state.workspace, ["rev-parse", "HEAD"])).trim() !==
    state.executionEligibility.selectedCommit
  )
    throw new Error("Approved pinned HEAD changed; renew explanation approval");
  const graphDirectory = dirname(state.graph.artifactPath);
  const recorded = state.managedArtifacts ?? {};
  const expected = {
    [state.prd.artifactPath]: state.prd.hash,
    [state.graph.artifactPath]: artifactHash(
      JSON.stringify(state.graph.value, null, 2),
    ),
    ...Object.fromEntries(
      Object.entries(state.graph.files).map(([path, text]) => [
        `${graphDirectory}/${path}`,
        artifactHash(text),
      ]),
    ),
  };
  for (const [path, hash] of Object.entries(expected))
    if (recorded[path] !== hash)
      throw new Error(`Unrecorded accepted planning artifact: ${path}`);
  for (const [path, hash] of Object.entries(recorded)) {
    if (!path.startsWith(`.ralph/features/${runId}/`))
      throw new Error("Foreign managed artifact");
    if (
      artifactHash(
        await readFile(
          await readPlanningArtifact(state.workspace, path),
          "utf8",
        ),
      ) !== hash
    )
      throw new Error(`Managed planning artifact changed: ${path}`);
  }
}
