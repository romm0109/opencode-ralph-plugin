import { startNativeFeature } from "../../src/commands/orchestrator.js";
import type { OpenCodeAdapter } from "../../src/opencode/adapter.js";
import { writePlanningFile } from "../../src/planning/artifact-writer.js";
import {
  completeInterview,
  completeIssues,
  completePrd,
} from "../../src/planning/completion.js";
import type { RunStore } from "../../src/state/run-store.js";
import { git } from "./project.js";
import { required } from "./single-issue.js";

/** Real native handoffs up to issue completion, with host answers at the adapter boundary. */
export async function authorNativePlanning(
  workspace: string,
  store: RunStore,
  adapter: OpenCodeAdapter,
) {
  await git("git", ["-C", workspace, "add", "."]);
  await git("git", [
    "-C",
    workspace,
    "commit",
    "--allow-empty",
    "-m",
    "approved project setup",
  ]);
  const commit = (
    await git("git", ["-C", workspace, "rev-parse", "HEAD"])
  ).stdout.trim();
  adapter.discoverTools = async () => ["question", "read"];
  adapter.requestUserInput = async (request) => ({
    ok: true,
    ...request,
    source: "user",
    messageId: request.requestId,
    text: request.options?.[0]?.label ?? "Build diamond",
  });
  const run = required(
    await startNativeFeature({
      workspace,
      store,
      adapter,
      sessionId: "main",
      feature: "Build diamond",
    }),
  );
  const runId = run.runId;
  const sessionId = required(run.planning).sessionId;
  await completeInterview(
    store,
    adapter,
    {
      runId,
      attempt: 1,
      text: "Build diamond",
      scope: ["Diamond"],
      criteria: ["D works"],
    },
    sessionId,
  );
  const explanation = required(
    required(required(await store.getRun(runId)).planning).explanation,
  );
  const text = `${["Executive Summary", "Mission", "Target Users", "MVP Scope", "User Stories", "Core Architecture & Patterns", "Tools/Features", "Technology Stack", "Security & Configuration", "Success Criteria", "Implementation Phases", "Future Considerations", "Risks & Mitigations"].map((heading) => `## ${heading}\nBuild diamond with approved checks.`).join("\n")}\nApproved explanation: revision ${explanation.revision}, hash ${explanation.hash}`;
  await writePlanningFile(
    store,
    { runId, attempt: 1, path: "PRD.md", content: text },
    sessionId,
  );
  await completePrd(
    store,
    adapter,
    { runId, attempt: 1, path: "PRD.md" },
    sessionId,
  );
  const planning = required(required(await store.getRun(runId)).planning);
  const issues = (
    [
      ["A", []],
      ["B", ["A"]],
      ["C", ["A"]],
      ["D", ["B", "C"]],
    ] as [string, string[]][]
  ).map(([id, dependencies], index) => ({
    id,
    title: id,
    artifactPath: `issues/${index + 1}-${id.toLowerCase()}.md`,
    dependencies,
    acceptanceCriteria: ["Works"],
    testableBehaviors: ["Works"],
  }));
  for (const issue of issues)
    await writePlanningFile(
      store,
      {
        runId,
        attempt: 1,
        path: issue.artifactPath,
        content: `# ${issue.title}\n## Context: files to read before implementing\nREADME.md\n## What to build\nBuild ${issue.id}\n## Patterns to follow\nRepository tests\n## Step-by-step tasks\nAdd behavior and tests\n## Validation commands\nApproved checks\n## Acceptance criteria\nWorks\n## Blocked by\n${issue.dependencies.join(", ") || "None"}`,
      },
      planning.sessionId,
    );
  await writePlanningFile(
    store,
    {
      runId,
      attempt: 1,
      path: "graph.json",
      content: JSON.stringify({
        schemaVersion: 1,
        prdRevision: planning.prd,
        issues,
      }),
    },
    planning.sessionId,
  );
  return {
    runId,
    commit,
    sessionId: planning.sessionId,
    complete: () =>
      completeIssues(
        store,
        adapter,
        { runId, attempt: 1, graphPath: "graph.json" },
        planning.sessionId,
      ),
  };
}
