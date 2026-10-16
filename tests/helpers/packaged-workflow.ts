// Copied into each consumer: runtime dependencies come only from its tarball.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { createCommandRouter } from "../../src/commands/router.js";
import type { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import type { RunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "./fake-opencode.js";

const exec = promisify(execFile);
export async function exerciseWorkflow(
  directory: string,
  store: RunStore,
  adapter: ReturnType<typeof createOpenCodeAdapter>,
  router: ReturnType<typeof createCommandRouter>,
  makeAdapter: typeof createOpenCodeAdapter,
  skipped: boolean,
  host: ReturnType<typeof import("./fake-opencode.js").createFakePluginContext>,
  native: ReturnType<typeof createFakeOpenCode>,
) {
  const stages: string[] = [];
  process.env.RALPH_PACKAGE_SCENARIO = "pass";
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", ["-C", cwd, ...args])).stdout.trim();
  adapter.getSessionModel = async () => ({
    providerID: "fixture",
    modelID: "model",
  });
  adapter.authorizeCommand = async () => ({ ok: true });
  adapter.discoverTools = async () => ["question", "read", "http"];
  adapter.requestUserInput = async (request) => {
    return {
      ok: true,
      ...request,
      source: "user",
      messageId: request.requestId,
      text:
        request.options?.[0]?.label ??
        `approve ${request.question.match(/hash ([a-f0-9]+)/)?.[1] ?? request.revision}`,
    };
  };
  const respond = async (
    job: import("../../src/core/types.js").JobEnvelope,
  ) => {
    let output: unknown;
    if (job.role === "command-discovery")
      output = {
        schemaVersion: 1,
        revision: 1,
        rationale: `Portable packaged demo: ${skipped ? "omitted" : "verified"}`,
        commands: [
          {
            id: "test",
            phase: "check",
            executable: process.execPath,
            args: [
              "-e",
              'if (process.env.SCENARIO === "timeout") { setTimeout(() => {}, 10000); } else { const fs = require("node:fs"); if(fs.existsSync("sum.test.ts")) { const p = Bun.spawnSync([process.execPath, "test", "sum.test.ts"]); process.exit(p.exitCode); } }',
            ],
            cwd: ".",
            timeoutMs: 1500,
            platforms: ["darwin", "linux", "win32"],
            env: { SCENARIO: "RALPH_PACKAGE_SCENARIO" },
          },
        ],
      };
    if (job.role === "executor") {
      await writeFile(
        join(job.workspace, "sum.test.ts"),
        'import {test,expect} from "bun:test"; import {sum} from "./sum"; test("addition",()=>expect(sum(2,3)).toBe(5));',
      );
      await writeFile(
        join(job.workspace, "sum.ts"),
        "export const sum = (a: number,b: number) => 0;",
      );
      const red = Bun.spawnSync([process.execPath, "test", "sum.test.ts"], {
        cwd: job.workspace,
      });
      assert.notEqual(red.exitCode, 0);
      await writeFile(
        join(job.workspace, "sum.ts"),
        "export const sum = (a: number,b: number) => a+b;",
      );
      const green = Bun.spawnSync([process.execPath, "test", "sum.test.ts"], {
        cwd: job.workspace,
      });
      assert.equal(green.exitCode, 0);
      await git(job.workspace, "add", ".");
      await git(job.workspace, "commit", "-m", "addition");
      output = {
        issueId: job.issueId,
        attempt: job.attempt,
        baseCommit: job.baseCommit,
        submittedCommit: await git(job.workspace, "rev-parse", "HEAD"),
        tdd: {
          cycles: [
            {
              behavior: "addition",
              red: { exitCode: red.exitCode, log: red.stderr.toString() },
              green: { exitCode: green.exitCode, log: green.stderr.toString() },
            },
          ],
        },
      };
    }
    if (job.role === "merger") {
      const submission = JSON.parse(
        job.prompt.split("SUBMISSION\n")[1] as string,
      );
      await git(
        job.workspace,
        "merge",
        "--no-edit",
        submission.submittedCommit,
      );
      output = {
        kind: "merged",
        candidateCommit: await git(job.workspace, "rev-parse", "HEAD"),
      };
    }
    if (job.role === "code-review" || job.role === "functional-review") {
      const observed = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import {sum} from "./sum.ts"; if (sum(2,3) !== 5) process.exit(1);',
        ],
        { cwd: job.workspace },
      );
      assert.equal(observed.exitCode, 0, observed.stderr.toString());
      output = {
        role: job.role,
        reviewedCommit: job.baseCommit,
        round: 1,
        outcome: "passed",
        findings: [],
        evidenceRefs: ["addition-log"],
        criteria: ["prd-1", "issue-a-1"].map((id) => ({
          id,
          status: "pass",
          coverage: ["log"],
          evidenceRefs: ["addition-log"],
        })),
        evidence: [
          {
            id: "addition-log",
            kind: "log",
            summary:
              "Installed reviewer observed sum(2,3) = 5 in its isolated worktree",
            reviewedCommit: job.baseCommit,
          },
        ],
      };
    }
    assert.ok(output, `Unexpected packaged role ${job.role}`);
    if (
      !["code-review", "functional-review", "command-discovery"].includes(
        job.role,
      )
    )
      stages.push(job.role);
    return JSON.stringify(output);
  };
  adapter.dispatchJob = async (job) => {
    const fake = createFakeOpenCode({ sessionPrefix: job.jobId });
    fake.respond(await respond(job));
    return makeAdapter(fake.client, store).dispatchJob(job);
  };
  native.respond(async (_prompt, metadata) => {
    const identity = metadata?.ralph as
      | { runId: string; jobId: string }
      | undefined;
    if (!identity || metadata?.ralphStage)
      return "Use the stage completion tools";
    const job = (await store.getRun(identity.runId))?.jobs[identity.jobId]
      ?.envelope;
    assert.ok(job);
    return respond(job);
  });
  const questions: {
    sessionId: string;
    messageId: string;
    question: string;
  }[] = [];
  host.tools.set("question", {
    id: "question",
    name: "question",
    description: "Fixture native form boundary",
    input: {} as never,
    async execute(input, context) {
      const q = (
        input as {
          questions: { question: string; options: { label: string }[] }[];
        }
      ).questions[0];
      assert.ok(q);
      questions.push({
        sessionId: context.sessionID,
        messageId: context.messageID,
        question: q.question,
      });
      return {
        content: "",
        metadata: { answers: [[q.options[0]?.label ?? "Addition"]] },
      };
    },
  });
  const call = async (name: string, input: unknown, sessionId: string) => {
    const tool = host.tools.get(name);
    assert.ok(tool, `Missing installed tool ${name}`);
    const result = await tool.execute(
      input as never,
      { sessionID: sessionId, signal: new AbortController().signal } as never,
    );
    const value = JSON.parse(String(result.content));
    assert.ok(
      !["blocked", "correctable-invalid"].includes(value.outcome),
      JSON.stringify(value),
    );
    return result;
  };
  const context = { workspace: directory, sessionId: "main" };
  const setup = JSON.parse(
    await router.dispatch("ralph-commands", "", context),
  );
  assert.equal(setup.status, "verified");
  stages.push("setup");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "verified setup");
  assert.equal(host.tools.has("ralph_workflow"), false);
  const command = host.commands.get("ralph-orchestrator");
  assert.ok(command);
  await command.execute({
    sessionID: "main",
    prompt: { text: "Addition" },
    delivery: "steer",
  } as never);
  const started = (await store.listRuns()).find(
    (run) => run.planning?.protocol === "native-interview-v1",
  );
  assert.ok(started?.planning, JSON.stringify(host.statuses));
  const runId = started.runId;
  const sessionId = started.planning.sessionId;
  assert.notEqual(sessionId, "main");
  assert.equal(questions.length, 1);
  assert.ok(questions[0]?.question.includes("Addition"));
  assert.ok(questions[0]?.messageId.startsWith("ralph-input:"));
  const interviewPrompt = native.requests.find(
    (r) =>
      r.path.endsWith("/prompt") && String(r.body.text).includes("ASD-STE100"),
  );
  assert.ok(
    interviewPrompt,
    "Installed interview must include ASD-STE100 instructions",
  );
  stages.push("interview");
  const question = host.tools.get("question");
  assert.ok(question);
  const grilling = await question.execute(
    {
      questions: [
        {
          question: "Which values should addition support?",
          options: [
            {
              label: "Finite numbers (Recommended)",
              description: "Keep the approved scope small",
            },
          ],
        },
      ],
    } as never,
    {
      sessionID: sessionId,
      messageID: "fixture-grilling",
      signal: new AbortController().signal,
    } as never,
  );
  assert.deepEqual(grilling.metadata?.answers, [
    ["Finite numbers (Recommended)"],
  ]);
  await call(
    "ralph_complete_interview",
    {
      runId,
      attempt: 1,
      text: "Implement addition",
      scope: ["Addition"],
      criteria: ["Addition works"],
    },
    sessionId,
  );
  const state = (await store.getRun(runId))?.planning;
  assert.ok(state?.explanation);
  assert.equal(state.owner?.stage, "prd");
  assert.equal(state.sessionId, sessionId);
  assert.equal(questions.length, 3);
  assert.ok(
    questions[2]?.question.includes(await git(directory, "rev-parse", "HEAD")),
  );
  assert.equal(state.approval?.hash, state.explanation.hash);
  const headings = [
    "Executive Summary",
    "Mission",
    "Target Users",
    "MVP Scope",
    "User Stories",
    "Core Architecture & Patterns",
    "Tools/Features",
    "Technology Stack",
    "Security & Configuration",
    "Success Criteria",
    "Implementation Phases",
    "Future Considerations",
    "Risks & Mitigations",
  ];
  const prd =
    headings
      .map((heading, i) => `## ${i + 1}. ${heading}\nAddition works`)
      .join("\n") +
    `\n- [ ] Addition works\nApproved explanation: revision ${state.explanation.revision}, hash ${state.explanation.hash}`;
  await call(
    "ralph_write_planning_file",
    { runId, attempt: 1, path: "PRD.md", content: prd },
    sessionId,
  );
  await call(
    "ralph_complete_prd",
    { runId, attempt: 1, path: "PRD.md" },
    sessionId,
  );
  stages.push("prd");
  const issues = (await store.getRun(runId))?.planning;
  assert.ok(issues?.prd);
  assert.notEqual(issues.sessionId, sessionId);
  await call(
    "ralph_complete_prd",
    { runId, attempt: 1, path: "PRD.md" },
    sessionId,
  );
  assert.equal(
    (await store.getRun(runId))?.planning?.sessionId,
    issues.sessionId,
  );
  const graph = {
    schemaVersion: 1,
    prdRevision: issues.prd,
    issues: [
      {
        id: "a",
        title: "Addition",
        artifactPath: "issues/1-addition.md",
        dependencies: [],
        acceptanceCriteria: ["Addition works"],
        testableBehaviors: ["sum(2,3) returns 5"],
      },
    ],
  };
  await call(
    "ralph_write_planning_file",
    {
      runId,
      attempt: 1,
      path: "issues/1-addition.md",
      content:
        "# Addition\n## Context: files to read before implementing\nREADME.md\n## What to build\nExport sum\n## Patterns to follow\nExisting tests\n## Step-by-step tasks\nWrite addition and tests\n## Validation commands\nApproved checks\n## Acceptance criteria\nAddition works\n## Blocked by\nNone",
    },
    issues.sessionId,
  );
  await call(
    "ralph_write_planning_file",
    { runId, attempt: 1, path: "graph.json", content: JSON.stringify(graph) },
    issues.sessionId,
  );
  stages.push("issues");
  process.env.RALPH_PACKAGE_SCENARIO = skipped ? "timeout" : "pass";
  await call(
    "ralph_complete_issues",
    { runId, attempt: 1, graphPath: "graph.json" },
    issues.sessionId,
  );
  const executions = stages.filter((stage) => stage === "executor").length;
  await call(
    "ralph_complete_issues",
    { runId, attempt: 1, graphPath: "graph.json" },
    issues.sessionId,
  );
  assert.equal(
    stages.filter((stage) => stage === "executor").length,
    executions,
  );
  assert.equal(executions, 1);
  const run = await store.getRun(runId);
  assert.ok(run);
  assert.equal(run.planning?.phase, "execution_approved");
  assert.equal(run.issueAttempts?.a?.status, "integrated", JSON.stringify(run));
  assert.equal(
    run.execution?.checks.every(
      (check: { status: string }) => check.status === "passed",
    ),
    !skipped,
  );
  assert.equal((run.validationSkips ?? []).length, skipped ? 1 : 0);
  return { run, stages };
}
