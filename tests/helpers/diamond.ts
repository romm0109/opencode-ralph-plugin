import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import type { JobEnvelope } from "../../src/core/types.js";
import { gitOutput } from "../../src/git/worktrees.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { artifactHash, issueBundleHash } from "../../src/planning/artifacts.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { required, singleIssueFixture } from "../helpers/single-issue.js";

export function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 60000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Fixture observation timed out");
    await Bun.sleep(10);
  }
}
export async function diamondFixture() {
  const f = await singleIssueFixture({
    commands: [
      {
        id: "test",
        phase: "check",
        executable: process.execPath,
        args: ["test"],
        cwd: ".",
        timeoutMs: 5000,
        platforms: ["darwin", "linux", "win32"],
        env: {},
      },
    ],
  });
  const run = required(await f.store.getRun(f.runId));
  const planning = required(run.planning);
  const graph = required(planning.graph);
  graph.value.issues = [
    ["A", []],
    ["B", ["A"]],
    ["C", ["A"]],
    ["D", ["B", "C"]],
    ["E", []],
  ].map(([id, dependencies]) => ({
    ...f.issue,
    id: id as string,
    artifactPath: `issues/${id}.md`,
    dependencies: dependencies as string[],
  }));
  graph.files = Object.fromEntries(
    graph.value.issues.map((issue) => [
      issue.artifactPath,
      required(graph.files["issues/A.md"]),
    ]),
  );
  graph.order = ["A", "B", "C", "D", "E"];
  graph.hash = issueBundleHash(graph.value, graph.files);
  required(planning.issueAcceptance).graph = graph;
  required(planning.issueAcceptance).result = { outcome: "accepted", graph };
  const artifactRoot = dirname(graph.artifactPath);
  await writeFile(
    join(f.project.directory, graph.artifactPath),
    JSON.stringify(graph.value, null, 2),
  );
  required(planning.managedArtifacts)[graph.artifactPath] = artifactHash(
    JSON.stringify(graph.value, null, 2),
  );
  for (const [path, text] of Object.entries(graph.files)) {
    await writeFile(join(f.project.directory, artifactRoot, path), text);
    required(planning.managedArtifacts)[`${artifactRoot}/${path}`] =
      artifactHash(text);
  }
  required(planning.executionEligibility).graphHash = graph.hash;
  // Fixtures approve the replacement graph before any execution.
  delete planning.graph;
  await f.store.recordPlanning(f.runId, run.revision, planning);
  planning.graph = graph;
  await f.store.recordPlanning(
    f.runId,
    required(await f.store.getRun(f.runId)).revision,
    planning,
  );
  const jobs: JobEnvelope[] = [];
  const holds = new Map<string, ReturnType<typeof gate>>();
  const failures = new Set<string>();
  f.adapter.dispatchJob = async (job) => {
    jobs.push(structuredClone(job));
    if (job.role === "code-review") {
      const fake = createFakeOpenCode({ sessionPrefix: job.jobId });
      fake.respond(
        JSON.stringify({
          role: "code-review",
          reviewedCommit: job.baseCommit,
          round: 1,
          outcome: "passed",
          findings: [],
          evidenceRefs: ["A.ts:1"],
        }),
      );
      return createOpenCodeAdapter(fake.client, f.store).dispatchJob(job);
    }
    if (job.role === "executor") {
      await holds.get(required(job.issueId))?.promise;
      if (failures.has(required(job.issueId)))
        return {
          ...job,
          outcome: "failed",
          evidence: [],
          error: { code: "missing-output", message: "fixture failure" },
        };
      const name = required(job.issueId);
      await writeFile(
        join(job.workspace, `${name}.test.ts`),
        `import {expect,test} from "bun:test"; import {value} from "./${name}"; test("${name}",()=>expect(value).toBe(1));`,
      );
      await writeFile(
        join(job.workspace, `${name}.ts`),
        "export const value=0;",
      );
      const red = Bun.spawnSync([process.execPath, "test", `${name}.test.ts`], {
        cwd: job.workspace,
      });
      expect(red.exitCode).not.toBe(0);
      await writeFile(
        join(job.workspace, `${name}.ts`),
        "export const value=1;",
      );
      const green = Bun.spawnSync(
        [process.execPath, "test", `${name}.test.ts`],
        { cwd: job.workspace },
      );
      expect(green.exitCode).toBe(0);
      await gitOutput(job.workspace, ["add", "."]);
      await gitOutput(job.workspace, ["commit", "-m", name]);
      const fake = createFakeOpenCode({ sessionPrefix: job.jobId });
      fake.respond(
        JSON.stringify({
          issueId: name,
          attempt: job.attempt,
          baseCommit: job.baseCommit,
          submittedCommit: (
            await gitOutput(job.workspace, ["rev-parse", "HEAD"])
          ).trim(),
          tdd: {
            cycles: [
              {
                behavior: `${name} returns 1`,
                red: {
                  exitCode: red.exitCode,
                  log: "Observed failing assertion",
                },
                green: {
                  exitCode: green.exitCode,
                  log: "Observed passing assertion",
                },
              },
            ],
          },
        }),
      );
      return createOpenCodeAdapter(fake.client, f.store).dispatchJob(job);
    }
    await holds.get(`merge:${job.issueId}`)?.promise;
    const submission = JSON.parse(
      required(job.prompt.split("SUBMISSION\n")[1]),
    );
    await gitOutput(job.workspace, [
      "merge",
      "--no-edit",
      submission.submittedCommit,
    ]);
    const fake = createFakeOpenCode({ sessionPrefix: job.jobId });
    fake.respond(
      JSON.stringify({
        kind: "merged",
        candidateCommit: (
          await gitOutput(job.workspace, ["rev-parse", "HEAD"])
        ).trim(),
      }),
    );
    return createOpenCodeAdapter(fake.client, f.store).dispatchJob(job);
  };
  return {
    ...f,
    jobs,
    holds,
    failures,
    router: createCommandRouter(f.store, f.adapter),
  };
}
