import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApprovedCommandConfig,
  commandConfigHash,
} from "../../src/config/commands.js";
import { createOwnedWorktree, gitOutput } from "../../src/git/worktrees.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import {
  artifactHash,
  explanationHash,
  issueBundleHash,
} from "../../src/planning/artifacts.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "./fake-opencode.js";
import { createTestProject } from "./project.js";

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture evidence");
  return value;
}

export async function singleIssueFixture(
  options: { commands?: ApprovedCommandConfig["commands"] } = {},
) {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  const runId = "feature-single";
  await store.createRun(runId);
  const config = {
    schemaVersion: 1 as const,
    revision: 1,
    rationale: "fixture",
    commands: options.commands ?? [
      {
        id: "test",
        phase: "check" as const,
        executable: process.execPath,
        args: ["test", "behavior.test.ts"],
        cwd: ".",
        timeoutMs: 5000,
        platforms: ["darwin", "linux", "win32"] as (
          | "darwin"
          | "linux"
          | "win32"
        )[],
        env: {},
      },
    ],
  };
  await mkdir(join(project.directory, ".ralph"));
  await writeFile(
    join(project.directory, ".ralph/commands.json"),
    JSON.stringify(config),
  );
  const artifactRoot = `.ralph/features/${runId}/graph-1`;
  await mkdir(join(project.directory, artifactRoot, "issues"), {
    recursive: true,
  });
  await writeFile(join(project.directory, artifactRoot, "PRD.md"), "Add one");
  const prd = {
    revision: 1,
    hash: artifactHash("Add one"),
    artifactPath: `${artifactRoot}/PRD.md`,
  };
  const issue = {
    id: "A",
    title: "Add one",
    artifactPath: "issues/A.md",
    dependencies: [],
    acceptanceCriteria: ["Adds one"],
    testableBehaviors: ["addOne(2) returns 3"],
  };
  const value = {
    schemaVersion: 1 as const,
    prdRevision: prd,
    issues: [issue],
  };
  const files = {
    "issues/A.md":
      "# A\n## Context: files to read before implementing\nFixture\n## What to build\nAdd one\n## Patterns to follow\nMirror repository code and integration test helpers.\n## Step-by-step tasks\nUpdate source and add a public behavior test.\n## Validation commands\nAdds one\n## Acceptance criteria\nAdds one\n## Blocked by\nNone",
  };
  const graph = {
    revision: 1,
    hash: issueBundleHash(value, files),
    artifactPath: `${artifactRoot}/graph.json`,
    value,
    files,
    order: ["A"],
  };
  await writeFile(
    join(project.directory, graph.artifactPath),
    JSON.stringify(graph.value, null, 2),
  );
  for (const [path, text] of Object.entries(files))
    await writeFile(join(project.directory, artifactRoot, path), text);
  await mkdir(join(store.root, "active-run.lock"));
  await writeFile(
    join(store.root, "active-run.lock/owner.json"),
    JSON.stringify({ runId, repositoryId: store.repositoryId }),
  );
  const context = {
    sha: project.commit,
    branch: "main",
    commandHash: commandConfigHash(config),
    commandRevision: 1,
  };
  let run = await store.getRun(runId);
  await store.recordPlanning(runId, required(run).revision, {
    protocol: "native-interview-v1",
    owner: { stage: "issues", sessionId: "main", attempt: 1 },
    proposalContext: context,
    prdAcceptance: {
      sessionId: "main",
      attempt: 1,
      path: "PRD.md",
      text: "Add one",
      revision: prd,
    },
    issueAcceptance: {
      sessionId: "main",
      attempt: 1,
      graph,
      result: { outcome: "accepted", graph },
    },
    managedArtifacts: {
      [prd.artifactPath]: prd.hash,
      [graph.artifactPath]: artifactHash(JSON.stringify(graph.value, null, 2)),
      ...Object.fromEntries(
        Object.entries(files).map(([path, text]) => [
          `${artifactRoot}/${path}`,
          artifactHash(text),
        ]),
      ),
    },
    phase: "execution_approved",
    workspace: project.directory,
    sessionId: "main",
    feature: "Add one",
    commandHash: commandConfigHash(config),
    settings: {
      concurrency: 2,
      timeoutMs: 30000,
      agentTimeoutMs: 30000,
      models: {
        interview: { providerID: "fixture", modelID: "interview" },
        issues: { providerID: "fixture", modelID: "issues" },
        executor: { providerID: "fixture", modelID: "executor" },
        merger: { providerID: "fixture", modelID: "merger" },
      },
      skills: {},
    },
    transcript: [],
    turn: 1,
    explanation: {
      revision: 1,
      hash: explanationHash({ text: "Add one", scope: [], criteria: [] }),
      text: "Add one",
      scope: [],
      criteria: [],
    },
    approval: {
      ...context,
      sessionId: "main",
      revision: 1,
      hash: explanationHash({ text: "Add one", scope: [], criteria: [] }),
      messageId: "human",
      requestId: "explanation",
    },
    prd,
    graph,
    selectedCommit: project.commit,
    executionEligibility: {
      revision: 1,
      selectedCommit: project.commit,
      prdHash: prd.hash,
      graphHash: graph.hash,
      explanationHash: explanationHash({
        text: "Add one",
        scope: [],
        criteria: [],
      }),
      commandHash: context.commandHash,
      commandRevision: 1,
      requestId: "explanation",
      messageId: "human",
      timestamp: new Date().toISOString(),
    },
  });
  const workspace = join(store.root, "worktrees", runId);
  await mkdir(join(store.root, "worktrees"), { recursive: true });
  const job = {
    runId,
    jobId: "baseline",
    role: "baseline",
    attempt: 0,
    workspace,
    baseCommit: project.commit,
    inputRevisions: {},
    prompt: "baseline",
  };
  await createOwnedWorktree(store, project.directory, {
    operationId: "baseline",
    kind: "baseline.workspace",
    status: "intent",
    job,
    ref: `refs/heads/ralph/${runId}`,
    expectedNew: project.commit,
  });
  run = await store.getRun(runId);
  await store.recordBaseline(
    runId,
    required(run).revision,
    {
      status: "passed",
      approvalRequestId: "explanation",
      operationId: "baseline",
      branch: `ralph/${runId}`,
      workspace,
      candidateCommit: project.commit,
      commandHash: commandConfigHash(config),
      commandRevision: 1,
    },
    [],
  );
  const fake = createFakeOpenCode();
  const adapter = createOpenCodeAdapter(fake.client, store);
  adapter.authorizeCommand = async ({ job }) => ({ ok: !!job.sessionId });
  const setMode = attachSingleIssueEngine(adapter, fake);
  return {
    project,
    config,
    store,
    adapter,
    fake,
    runId,
    issue,
    workspace,
    setMode,
  };
}

/** Real Git/TDD worker and merger shared by public workflow fixtures. */
export function attachSingleIssueEngine(
  adapter: ReturnType<typeof createOpenCodeAdapter>,
  fake: ReturnType<typeof createFakeOpenCode>,
) {
  const dispatch = adapter.dispatchJob.bind(adapter);
  let mode = "success";
  adapter.dispatchJob = async (job) => {
    if (job.role === "executor") {
      await writeFile(
        join(job.workspace, "behavior.test.ts"),
        'import {expect,test} from "bun:test"; import {addOne} from "./behavior"; test("adds one",()=>expect(addOne(2)).toBe(3));',
      );
      await writeFile(
        join(job.workspace, "behavior.ts"),
        "export const addOne=(n:number)=>n;",
      );
      const red = Bun.spawnSync(
        [process.execPath, "test", "behavior.test.ts"],
        { cwd: job.workspace },
      );
      expect(red.exitCode).not.toBe(0);
      await writeFile(
        join(job.workspace, "behavior.ts"),
        "export const addOne=(n:number)=>n+1;",
      );
      const green = Bun.spawnSync(
        [process.execPath, "test", "behavior.test.ts"],
        { cwd: job.workspace },
      );
      expect(green.exitCode).toBe(0);
      await gitOutput(job.workspace, ["add", "."]);
      await gitOutput(job.workspace, ["commit", "-m", "Add one"]);
      fake.respond(
        JSON.stringify({
          issueId: mode === "identity" ? "other" : job.issueId,
          attempt: job.attempt,
          baseCommit: job.baseCommit,
          submittedCommit: (
            await gitOutput(job.workspace, ["rev-parse", "HEAD"])
          ).trim(),
          tdd: {
            cycles: [
              {
                behavior: "addOne(2) returns 3",
                red: {
                  exitCode: red.exitCode,
                  log: new TextDecoder().decode(red.stderr),
                },
                green: {
                  exitCode: green.exitCode,
                  log: new TextDecoder().decode(green.stderr),
                },
              },
            ],
          },
        }),
      );
    } else {
      if (mode === "conflict")
        fake.respond(
          JSON.stringify({
            kind: "behavior_conflict",
            feedback: "Choose behavior for addOne",
          }),
        );
      else {
        const submission = JSON.parse(
          required(job.prompt.split("SUBMISSION\n")[1]),
        );
        await gitOutput(job.workspace, [
          "merge",
          "--no-edit",
          submission.submittedCommit,
        ]);
        if (mode === "validation") {
          await writeFile(
            join(job.workspace, "behavior.ts"),
            "export const addOne=(n:number)=>n;",
          );
          await gitOutput(job.workspace, ["commit", "-am", "Bad merge"]);
        }
        fake.respond(
          JSON.stringify({
            kind: "merged",
            candidateCommit: (
              await gitOutput(job.workspace, ["rev-parse", "HEAD"])
            ).trim(),
          }),
        );
      }
    }
    return dispatch(job);
  };
  return (value: string) => {
    mode = value;
  };
}
