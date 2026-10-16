import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { coordinateReviewRound } from "../../src/review/coordinator.js";
import type { FunctionalReviewResult } from "../../src/review/functional-results.js";
import type { ReviewResult, ReviewSnapshot } from "../../src/review/types.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createTestProject, git } from "../helpers/project.js";

async function fixture() {
  const project = await createTestProject();
  await git("git", ["-C", project.directory, "branch", "-M", "master"]);
  await git("git", ["-C", project.directory, "checkout", "-b", "feature"]);
  const graph = {
    revision: "g1",
    issues: [{ id: "a", acceptanceCriteria: ["Addition works"] }],
  };
  await writeFile(
    join(project.directory, "PRD.md"),
    "# Acceptance\n- [ ] Addition works\n",
  );
  await writeFile(join(project.directory, "graph.json"), JSON.stringify(graph));
  await git("git", ["-C", project.directory, "add", "."]);
  await git("git", ["-C", project.directory, "commit", "-m", "feature"]);
  const commit = (
    await git("git", ["-C", project.directory, "rev-parse", "HEAD"])
  ).stdout.trim();
  const store = await openRunStore(project.directory);
  const run = await store.createRun("r");
  await store.recordExecution("r", run.revision, {
    verification: "passed",
    issues: [
      {
        id: "a",
        title: "Addition",
        dependencies: [],
        status: "integrated",
        blockers: [],
      },
    ],
    integrationQueue: [],
    checks: [
      {
        id: "test",
        status: "passed",
        attempt: 1,
        candidateCommit: commit,
        commandRevision: 1,
      },
    ],
  });
  return {
    project,
    store,
    options: {
      store,
      directory: project.directory,
      runId: "r",
      commit,
      baseCommit: project.commit,
      prdRevision: "p1",
      graph,
      evidenceRefs: ["test"],
    },
  };
}
function code(s: ReviewSnapshot): ReviewResult {
  return {
    role: "code-review",
    reviewedCommit: s.commit,
    round: s.round,
    outcome: "passed",
    findings: [],
    evidenceRefs: ["test"],
  };
}
function functional(s: ReviewSnapshot): FunctionalReviewResult {
  return {
    ...code(s),
    role: "functional-review",
    criteria: [
      {
        id: "ac",
        criterion: "Addition works",
        coverage: ["http"],
        status: "pass",
        evidenceRefs: ["http"],
      },
    ],
    evidence: [
      {
        id: "http",
        kind: "http",
        summary: "Addition observed",
        reviewedCommit: s.commit,
      },
    ],
    attempts: [{ attempt: 1, evidenceRefs: ["http"] }],
  };
}

test("clean dual review freezes one commit and persists terminal verified evidence", async () => {
  const f = await fixture();
  try {
    const snapshots: ReviewSnapshot[] = [];
    const report = await coordinateReviewRound({
      ...f.options,
      reviewers: {
        code: async (s) => {
          snapshots.push(s);
          return code(s);
        },
        functional: async (s) => {
          snapshots.push(s);
          return functional(s);
        },
      },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(report.outcome).toBe("verified");
    expect(report.commit).toBe(f.options.commit);
    expect((await f.store.getRun("r"))?.phase).toBe("completed");
    expect((await f.store.getRun("r"))?.reviewWorkflow?.rounds).toHaveLength(1);
  } finally {
    await f.project.cleanup();
  }
});

function defect(
  s: ReviewSnapshot,
  role: "code-review" | "functional-review" = "code-review",
  id = "bug",
) {
  return {
    id,
    reviewerRole: role,
    reviewedCommit: s.commit,
    category: "correctness" as const,
    blocking: true,
    criterion: "Addition works",
    evidence: ["PRD.md:2"],
    suggestedRepair: "Return the sum",
    disposition: "open" as const,
  };
}
test("repairs wait for both reviewers, use fresh worktrees and stop after third complete round", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let functionalFinished = false;
  const workspaces: string[] = [];
  try {
    const pending = coordinateReviewRound({
      ...f.options,
      reviewers: {
        code: async (s) => ({
          ...code(s),
          outcome: "findings",
          findings: [defect(s)],
        }),
        functional: async (s) => {
          await gate;
          functionalFinished = true;
          return functional(s);
        },
      },
      repairs: {
        executeIssue: async (task, ctx) => {
          expect(functionalFinished).toBe(true);
          expect(task.tdd).toBe(true);
          expect(task.originalIssues[0]?.id).toBe("a");
          expect(
            (
              await git("git", ["-C", ctx.workspace, "rev-parse", "HEAD"])
            ).stdout.trim(),
          ).toBe(ctx.baseCommit);
          workspaces.push(ctx.workspace);
          await writeFile(
            join(ctx.workspace, "fixed.txt"),
            `repair ${workspaces.length}`,
          );
          await git("git", ["-C", ctx.workspace, "add", "."]);
          await git("git", ["-C", ctx.workspace, "commit", "-m", "repair"]);
          const commit = (
            await git("git", ["-C", ctx.workspace, "rev-parse", "HEAD"])
          ).stdout.trim();
          return {
            outcome: "candidate",
            commit,
            evidenceRefs: ["red", "green"],
          };
        },
        integrateIssue: async (_task, candidate) => {
          await git("git", [
            "-C",
            f.project.directory,
            "merge",
            "--ff-only",
            candidate,
          ]);
          return {
            outcome: "integrated",
            commit: candidate,
            checks: [
              {
                id: "test",
                status: "passed",
                attempt: 1,
                candidateCommit: candidate,
                commandRevision: 1,
              },
            ],
            evidenceRefs: ["candidate-checked"],
          };
        },
      },
    });
    await Bun.sleep(50);
    expect(workspaces).toHaveLength(0);
    release();
    const report = await pending;
    expect(report.outcome).toBe("unresolved");
    expect(report.rounds.map((r) => r.snapshot.round)).toEqual([1, 2, 3]);
    expect(workspaces).toHaveLength(2);
    expect(new Set(workspaces).size).toBe(2);
    expect(report.repairCount).toBe(2);
    expect(report.attempts.every((a) => a.used === 1)).toBe(true);
    expect(
      (
        await git("git", [
          "-C",
          f.project.directory,
          "rev-parse",
          "refs/heads/master",
        ])
      ).stdout.trim(),
    ).toBe(f.project.commit);
  } finally {
    release();
    await f.project.cleanup();
  }
});

test("unavailable functional review cannot hide confirmed code blockers; skipped checks qualify passing reviews", async () => {
  for (const mode of ["blocked", "unavailable", "skipped"] as const) {
    const f = await fixture();
    try {
      if (mode === "skipped") {
        const run = await f.store.getRun("r");
        if (!run?.execution) throw new Error("Missing run");
        await f.store.recordExecution("r", run.revision, {
          ...run.execution,
          checks: run.execution.checks.map((c) => ({
            ...c,
            status: "skipped",
            reason: "timeout",
          })),
        });
      }
      const report = await coordinateReviewRound({
        ...f.options,
        reviewers: {
          code: async (s) =>
            mode === "blocked"
              ? { ...code(s), outcome: "findings", findings: [defect(s)] }
              : code(s),
          functional: async (s) => {
            if (mode !== "skipped") throw new Error("Browser unavailable");
            return functional(s);
          },
        },
      });
      expect(report.outcome).toBe(
        mode === "blocked"
          ? "unresolved"
          : mode === "unavailable"
            ? "unverified"
            : "incomplete-validation",
      );
      if (mode === "blocked") expect(report.findings[0]?.id).toBe("bug");
      if (mode === "skipped") expect(report.skippedChecks).toHaveLength(1);
    } finally {
      await f.project.cleanup();
    }
  }
});

test("duplicate findings preserve both sources and exhausted repairs get exactly three attempts", async () => {
  const f = await fixture();
  const workspaces: string[] = [];
  try {
    const report = await coordinateReviewRound({
      ...f.options,
      reviewers: {
        code: async (s) => ({
          ...code(s),
          outcome: "findings",
          findings: [defect(s)],
        }),
        functional: async (s) => ({
          ...functional(s),
          outcome: "findings",
          findings: [defect(s, "functional-review", "ac")],
        }),
      },
      repairs: {
        executeIssue: async (task, ctx) => {
          expect(task.sources).toHaveLength(2);
          workspaces.push(ctx.workspace);
          return {
            outcome: "failed",
            error: { code: "missing-output", message: "Executor stuck" },
            evidenceRefs: ["failure"],
          };
        },
        integrateIssue: async () => {
          throw new Error("Must not integrate failed execution");
        },
      },
    });
    expect(report.outcome).toBe("unresolved");
    expect(report.rounds).toHaveLength(1);
    expect(report.repairCount).toBe(1);
    expect(new Set(workspaces).size).toBe(3);
    expect(report.attempts.at(-1)?.used).toBe(3);
  } finally {
    await f.project.cleanup();
  }
});

test("evidence-based disputes are withdrawn or retained in one exchange without an extra round", async () => {
  for (const mode of ["withdrawn", "retained", "no-evidence"] as const) {
    const f = await fixture();
    let exchanges = 0;
    try {
      const report = await coordinateReviewRound({
        ...f.options,
        reviewers: {
          code: async (s) => ({
            ...code(s),
            outcome: "findings",
            findings: [defect(s)],
          }),
          functional: async (s) => functional(s),
        },
        repairs: {
          executeIssue: async () => ({
            outcome: "disputed",
            findingIds: ["code-review:bug"],
            evidenceRefs: ["counterexample"],
          }),
          integrateIssue: async () => {
            throw new Error("No candidate");
          },
          clarifyFinding: async (finding) => {
            exchanges++;
            expect(finding.reviewerRole).toBe("code-review");
            return {
              disposition: mode === "retained" ? "retained" : "withdrawn",
              evidenceRefs: mode === "no-evidence" ? [] : ["reproduction"],
              justification: "Reproduced the executor counterexample",
            };
          },
        },
      });
      expect(report.outcome).toBe(
        mode === "withdrawn" ? "verified" : "unresolved",
      );
      expect(report.rounds).toHaveLength(1);
      expect(exchanges).toBe(1);
      expect(report.attempts.at(-1)?.used).toBe(1);
    } finally {
      await f.project.cleanup();
    }
  }
});

for (const skippedIntegration of [false, true])
  test(`two planted code/UI defects pass review two and preserve intermediate skips: ${skippedIntegration}`, async () => {
    let integrationCount = 0;
    const f = await fixture();
    const { createCommandRouter } = await import(
      "../../src/commands/router.js"
    );
    const { createOpenCodeAdapter } = await import(
      "../../src/opencode/adapter.js"
    );
    const { createFakeOpenCode } = await import("../helpers/fake-opencode.js");
    const fake = createFakeOpenCode();
    const router = createCommandRouter(
      f.store,
      createOpenCodeAdapter(fake.client, f.store),
    );
    try {
      await writeFile(
        join(f.project.directory, "sum.ts"),
        "export const sum = (a: number, b: number) => a - b;\n",
      );
      await writeFile(
        join(f.project.directory, "view.ts"),
        'export const label = "Broken";\n',
      );
      await git("git", ["-C", f.project.directory, "add", "."]);
      await git("git", [
        "-C",
        f.project.directory,
        "commit",
        "-m",
        "plant UI and code defects",
      ]);
      const commit = (
        await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
      ).stdout.trim();
      const target = (
        await git("git", ["-C", f.project.directory, "rev-parse", "master"])
      ).stdout;
      const remotes = (
        await git("git", ["-C", f.project.directory, "remote", "-v"])
      ).stdout;
      const run = await f.store.getRun("r");
      if (!run?.execution) throw new Error("Missing execution");
      await f.store.recordExecution("r", run.revision, {
        ...run.execution,
        checks: run.execution.checks.map((c) => ({
          ...c,
          candidateCommit: commit,
        })),
      });
      const report = await router.reviewFeature({
        ...f.options,
        commit,
        parentSessionId: "parent",
        reviewers: {
          code: async (s) =>
            s.round === 1
              ? {
                  ...code(s),
                  outcome: "findings",
                  findings: [{ ...defect(s), evidence: ["sum.ts:1"] }],
                }
              : code(s),
          functional: async (s) =>
            s.round === 1
              ? {
                  ...functional(s),
                  outcome: "findings",
                  findings: [
                    {
                      ...defect(s, "functional-review", "ui"),
                      criterion: "UI label says Ready",
                      evidence: ["view.ts:1"],
                      suggestedRepair: "Display Ready",
                    },
                  ],
                }
              : functional(s),
        },
        repairs: {
          executeIssue: async (task, ctx) => {
            const isCode = task.sources[0]?.reviewerRole === "code-review";
            const testPath = isCode ? "sum.test.ts" : "view.test.ts";
            await writeFile(
              join(ctx.workspace, testPath),
              isCode
                ? 'import { test, expect } from "bun:test"; import { sum } from "./sum"; test("sum", () => expect(sum(1,2)).toBe(3));'
                : 'import { test, expect } from "bun:test"; import { label } from "./view"; test("label", () => expect(label).toBe("Ready"));',
            );
            const red = Bun.spawn([process.execPath, "test", testPath], {
              cwd: ctx.workspace,
              stdout: "pipe",
              stderr: "pipe",
            });
            expect(await red.exited).not.toBe(0);
            await writeFile(
              join(ctx.workspace, isCode ? "sum.ts" : "view.ts"),
              isCode
                ? "export const sum = (a: number, b: number) => a + b;\n"
                : 'export const label = "Ready";\n',
            );
            const green = Bun.spawn([process.execPath, "test"], {
              cwd: ctx.workspace,
              stdout: "pipe",
              stderr: "pipe",
            });
            expect(await green.exited).toBe(0);
            await git("git", ["-C", ctx.workspace, "add", "."]);
            await git("git", [
              "-C",
              ctx.workspace,
              "commit",
              "-m",
              `TDD ${task.id}`,
            ]);
            return {
              outcome: "candidate",
              commit: (
                await git("git", ["-C", ctx.workspace, "rev-parse", "HEAD"])
              ).stdout.trim(),
              evidenceRefs: [`${task.id}:red`, `${task.id}:green`],
            };
          },
          integrateIssue: async (_task, candidate, ctx) => {
            const checked = Bun.spawn([process.execPath, "test"], {
              cwd: ctx.workspace,
              stdout: "pipe",
              stderr: "pipe",
            });
            expect(await checked.exited).toBe(0);
            await git("git", [
              "-C",
              f.project.directory,
              "merge",
              "--ff-only",
              candidate,
            ]);
            return {
              outcome: "integrated",
              commit: candidate,
              checks: [
                {
                  id: "test",
                  status:
                    skippedIntegration && ++integrationCount === 1
                      ? "skipped"
                      : "passed",
                  reason: "timeout",
                  attempt: ctx.attempt,
                  candidateCommit: candidate,
                  commandRevision: 1,
                },
              ],
              evidenceRefs: ["merger-test"],
            };
          },
        },
      });
      expect(report.outcome).toBe(
        skippedIntegration ? "incomplete-validation" : "verified",
      );
      if (skippedIntegration) expect(report.skippedChecks).toHaveLength(1);
      expect(report.rounds).toHaveLength(2);
      expect(report.repairedIssues).toHaveLength(2);
      expect(report.attempts.map((a) => a.used)).toEqual([1, 1]);
      expect(
        (await git("git", ["-C", f.project.directory, "rev-parse", "master"]))
          .stdout,
      ).toBe(target);
      expect(
        (await git("git", ["-C", f.project.directory, "remote", "-v"])).stdout,
      ).toBe(remotes);
      expect(
        JSON.parse(await router.status("r")).reviewWorkflow.report,
      ).toEqual(report);
      expect(
        fake.requests.some(
          (r) =>
            r.path === "/api/rpc/ralph/publishStatus" &&
            JSON.stringify(r.body).includes(report.outcome),
        ),
      ).toBe(true);
      expect(await router.reviewFeature({ ...f.options, commit })).toEqual(
        report,
      );
    } finally {
      await f.project.cleanup();
    }
  });

test("default dual reviewers use independent adapter sessions on the same SHA", async () => {
  const f = await fixture();
  const { createCommandRouter } = await import("../../src/commands/router.js");
  const { createOpenCodeAdapter } = await import(
    "../../src/opencode/adapter.js"
  );
  const { createFakeOpenCode } = await import("../helpers/fake-opencode.js");
  const fake = createFakeOpenCode();
  const router = createCommandRouter(
    f.store,
    createOpenCodeAdapter(fake.client, f.store),
  );
  try {
    fake.respond(
      JSON.stringify({
        ...code({
          runId: "r",
          commit: f.options.commit,
          round: 1,
          prdRevision: "p1",
          graphRevision: "g1",
          evidenceRefs: ["test"],
        }),
        criteria: ["prd-1", "issue-a-1"].map((id) => ({
          id,
          status: "pass",
          coverage: ["http"],
          evidenceRefs: ["http"],
        })),
        evidence: [
          {
            id: "http",
            kind: "http",
            summary: "Observed sum",
            reviewedCommit: f.options.commit,
          },
        ],
      }),
    );
    const report = await router.reviewFeature({
      ...f.options,
      parentSessionId: "parent",
      functionalOptions: {
        surfaces: { ui: false, http: true },
        tools: { http: "http" },
        environment: {
          revision: 1,
          prepare: async () => ({
            url: "http://localhost:1234",
            evidenceRefs: ["startup"],
          }),
          dispose: async () => ({
            status: "completed",
            evidenceRefs: ["cleanup"],
          }),
        },
      },
    });
    expect(report.outcome).toBe("verified");
    for (const operation of Object.values(
      (await f.store.getRun("r"))?.operations ?? {},
    )) {
      if (
        operation.kind === "review.workspace" &&
        operation.status === "completed"
      )
        expect(report.retainedResources).toContain(operation.job.workspace);
    }
    expect(report.rounds[0]?.code?.sessionId).not.toBe(
      report.rounds[0]?.functional?.sessionId,
    );
    expect(report.rounds[0]?.functional?.attempts).toHaveLength(1);
    expect(report.rounds[0]?.code?.reviewedCommit).toBe(
      report.rounds[0]?.functional?.reviewedCommit,
    );
  } finally {
    await f.project.cleanup();
  }
});

test("functional infrastructure exhaustion is three attempts in one round and only terminal reporting releases the lock", async () => {
  const f = await fixture();
  const { createOpenCodeAdapter } = await import(
    "../../src/opencode/adapter.js"
  );
  const { createFakeOpenCode } = await import("../helpers/fake-opencode.js");
  const fake = createFakeOpenCode();
  let starts = 0;
  let released = 0;
  try {
    fake.respond(
      JSON.stringify(
        code({
          runId: "r",
          commit: f.options.commit,
          round: 1,
          prdRevision: "p1",
          graphRevision: "g1",
          evidenceRefs: ["test"],
        }),
      ),
    );
    const report = await coordinateReviewRound({
      ...f.options,
      adapter: createOpenCodeAdapter(fake.client, f.store),
      parentSessionId: "parent",
      releaseActiveRun: async () => {
        expect((await f.store.getRun("r"))?.reviewWorkflow?.status).toBe(
          "terminal",
        );
        released++;
      },
      functionalOptions: {
        surfaces: { ui: true, http: false },
        tools: { browser: "agent-browser" },
        environment: {
          revision: 1,
          prepare: async () => {
            starts++;
            throw new Error("Startup unavailable");
          },
          dispose: async () => ({
            status: "completed",
            evidenceRefs: ["cleanup"],
          }),
        },
      },
    });
    expect(report.outcome).toBe("unverified");
    expect(starts).toBe(3);
    expect(released).toBe(1);
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0]?.functional?.attempts).toHaveLength(3);
  } finally {
    await f.project.cleanup();
  }
});

test("stale reviewer output cannot finalize or release the active run", async () => {
  const f = await fixture();
  let released = false;
  try {
    await expect(
      coordinateReviewRound({
        ...f.options,
        releaseActiveRun: async () => {
          released = true;
        },
        reviewers: {
          code: async (s) => ({ ...code(s), reviewedCommit: f.project.commit }),
          functional: async (s) => functional(s),
        },
      }),
    ).rejects.toThrow("Stale");
    expect(released).toBe(false);
    expect((await f.store.getRun("r"))?.reviewWorkflow?.status).toBe("running");
  } finally {
    await f.project.cleanup();
  }
});

test("execution missing its required validation attestation cannot become verified", async () => {
  const f = await fixture();
  try {
    const run = await f.store.getRun("r");
    if (!run?.execution) throw new Error("Missing execution");
    await f.store.recordExecution("r", run.revision, {
      ...run.execution,
      verification: "incomplete",
    });
    const report = await coordinateReviewRound({
      ...f.options,
      reviewers: {
        code: async (s) => code(s),
        functional: async (s) => functional(s),
      },
    });
    expect(report.outcome).toBe("incomplete-validation");
  } finally {
    await f.project.cleanup();
  }
});

test("repairs cannot reset an exhausted functional infrastructure budget", async () => {
  const f = await fixture();
  let functionalCalls = 0;
  try {
    const report = await coordinateReviewRound({
      ...f.options,
      reviewers: {
        code: async (s) =>
          s.round === 1
            ? { ...code(s), outcome: "findings", findings: [defect(s)] }
            : code(s),
        functional: async (s) => {
          functionalCalls++;
          return {
            ...functional(s),
            outcome: "unverified",
            criteria: [],
            attempts: [1, 2, 3].map((attempt) => ({
              attempt,
              evidenceRefs: ["startup"],
              blocker: { code: "unsupported", message: "Startup unavailable" },
            })),
          };
        },
      },
      repairs: {
        executeIssue: async (_task, ctx) => {
          await git("git", [
            "-C",
            ctx.workspace,
            "commit",
            "--allow-empty",
            "-m",
            "repair",
          ]);
          return {
            outcome: "candidate",
            commit: (
              await git("git", ["-C", ctx.workspace, "rev-parse", "HEAD"])
            ).stdout.trim(),
            evidenceRefs: ["red", "green"],
          };
        },
        integrateIssue: async (_task, candidate) => {
          await git("git", [
            "-C",
            f.project.directory,
            "merge",
            "--ff-only",
            candidate,
          ]);
          return {
            outcome: "integrated",
            commit: candidate,
            checks: [
              {
                id: "test",
                status: "passed",
                candidateCommit: candidate,
                commandRevision: 1,
                attempt: 1,
              },
            ],
            evidenceRefs: ["checked"],
          };
        },
      },
    });
    expect(report.outcome).toBe("unverified");
    expect(report.rounds).toHaveLength(2);
    expect(functionalCalls).toBe(1);
  } finally {
    await f.project.cleanup();
  }
});

test("public review reuses the approved executor, merger and candidate checks for dedicated repairs", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const { createCommandRouter } = await import("../../src/commands/router.js");
  const { gitOutput } = await import("../../src/git/worktrees.js");
  const f = await singleIssueFixture();
  const router = createCommandRouter(f.store, f.adapter);
  try {
    f.setMode("identity");
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    f.adapter.dispatchJob = async (job) => {
      const result = await dispatch(job);
      f.setMode("success");
      return result;
    };
    await router.executeIssue(f.runId, "A");
    const executed = required(await f.store.getRun(f.runId));
    const { reconcileReadiness } = await import(
      "../../src/execution/readiness.js"
    );
    await f.store.recordExecution(
      f.runId,
      executed.revision,
      reconcileReadiness(executed),
    );
    const before = required(await f.store.getRun(f.runId));
    const planning = required(before.planning);
    const graph = required(planning.graph);
    await writeFile(
      join(f.workspace, "behavior.ts"),
      "export const addOne=(n:number)=>n;\n",
    );
    await gitOutput(f.workspace, ["commit", "-am", "plant regression"]);
    const commit = (await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim();
    await f.store.recordExecution(f.runId, before.revision, {
      ...required(before.execution),
      verification: "failed",
      checks: required(before.execution).checks.map((c) => ({
        ...c,
        candidateCommit: commit,
        status: "failed",
      })),
    });
    const target = await gitOutput(f.project.directory, ["rev-parse", "HEAD"]);
    const report = await router.reviewFeature({
      runId: f.runId,
      directory: f.workspace,
      commit,
      baseCommit: f.project.commit,
      prdRevision: required(planning.prd).hash,
      graph: { revision: graph.hash, issues: graph.value.issues },
      evidenceRefs: ["original:TDD"],
      approvedPlanning: true,
      parentSessionId: "main",
      reviewers: {
        code: async (s) =>
          s.round === 1
            ? { ...code(s), outcome: "findings", findings: [defect(s)] }
            : code(s),
        functional: async (s) => functional(s),
      },
    });
    expect(report.outcome).toBe("verified");
    expect(report.attempts.filter((a) => a.issueId === "A")).toEqual([
      { issueId: "A", used: 2 },
    ]);
    expect(report.rounds).toHaveLength(2);
    expect(report.repairedIssues).toHaveLength(1);
    const repairId = required(report.repairedIssues[0]);
    const after = required(await f.store.getRun(f.runId));
    const attempt = required(after.issueAttempts?.[repairId]);
    expect(report.retainedResources).not.toContain(attempt.job.workspace);
    expect(report.retainedResources).toContain(f.workspace);
    expect(attempt.status).toBe("integrated");
    expect(attempt.submission?.tdd.cycles).toHaveLength(1);
    expect(attempt.validation?.checks.map((c) => c.status)).toEqual(["passed"]);
    expect(attempt.mergerSessionId).not.toBe(attempt.submission?.sessionId);
    expect(after.planning).toEqual(planning);
    expect(after.execution?.issues.map((i) => i.id)).toEqual(["A"]);
    expect(report.attempts.filter((a) => a.issueId === repairId)).toEqual([
      { issueId: repairId, used: 1 },
    ]);
    expect(await gitOutput(f.project.directory, ["rev-parse", "HEAD"])).toBe(
      target,
    );
  } finally {
    await f.project.cleanup();
  }
});

for (const withdrawalEvidence of [
  "behavior.test.ts:1",
  "absent.test.ts:999",
  "permission-denied",
])
  test(`production repair disputes require frozen reviewer evidence: ${withdrawalEvidence}`, async () => {
    const { singleIssueFixture, required } = await import(
      "../helpers/single-issue.js"
    );
    const { createCommandRouter } = await import(
      "../../src/commands/router.js"
    );
    const { createOpenCodeAdapter } = await import(
      "../../src/opencode/adapter.js"
    );
    const { gitOutput } = await import("../../src/git/worktrees.js");
    const { reconcileReadiness } = await import(
      "../../src/execution/readiness.js"
    );
    const f = await singleIssueFixture();
    try {
      const router = createCommandRouter(f.store, f.adapter);
      await router.executeIssue(f.runId, "A");
      const run = required(await f.store.getRun(f.runId));
      await f.store.recordExecution(
        f.runId,
        run.revision,
        reconcileReadiness(run),
      );
      const planning = required(run.planning);
      const graph = required(planning.graph);
      const commit = (
        await gitOutput(f.workspace, ["rev-parse", "HEAD"])
      ).trim();
      const dispatch = createOpenCodeAdapter(
        f.fake.client,
        f.store,
      ).dispatchJob;
      let clarifications = 0;
      f.adapter.dispatchJob = async (job) => {
        if (job.role === "executor") {
          if (withdrawalEvidence === "permission-denied")
            return {
              ...job,
              outcome: "denied",
              evidence: [],
              error: {
                code: "permission-denied",
                message: "Host denied repair execution",
              },
            };
          f.fake.respond(
            JSON.stringify({
              kind: "finding_dispute",
              findingIds: ["code-review:bug"],
              evidenceRefs: ["behavior.test.ts:1"],
            }),
          );
        } else {
          expect(job.role).toBe("code-review");
          expect(job.baseCommit).toBe(commit);
          expect(job.prompt).toContain("behavior.test.ts:1");
          expect(job.prompt).toContain("code-review");
          expect(job.readOnly).toBe(true);
          clarifications++;
          f.fake.respond(
            JSON.stringify({
              disposition: "withdrawn",
              evidenceRefs: [withdrawalEvidence],
              justification:
                "The committed regression test confirms the required behavior",
            }),
          );
        }
        return dispatch(job);
      };
      const report = await router.reviewFeature({
        runId: f.runId,
        directory: f.workspace,
        commit,
        baseCommit: f.project.commit,
        prdRevision: required(planning.prd).hash,
        graph: { revision: graph.hash, issues: graph.value.issues },
        evidenceRefs: ["original:TDD"],
        approvedPlanning: true,
        parentSessionId: "main",
        reviewers: {
          code: async (s) => ({
            ...code(s),
            outcome: "findings",
            findings: [defect(s)],
          }),
          functional: async (s) => functional(s),
        },
      });
      expect(report.outcome).toBe(
        withdrawalEvidence === "behavior.test.ts:1" ? "verified" : "unresolved",
      );
      expect(report.rounds).toHaveLength(1);
      if (withdrawalEvidence !== "permission-denied")
        expect(report.rounds[0]?.disputes[0]?.disposition).toBe(
          withdrawalEvidence === "behavior.test.ts:1"
            ? "withdrawn"
            : "retained",
        );
      expect(
        report.attempts.find((a) => a.issueId.startsWith("repair-"))?.used,
      ).toBe(1);
      expect(clarifications).toBe(
        withdrawalEvidence === "permission-denied" ? 0 : 1,
      );
    } finally {
      await f.project.cleanup();
    }
  });

test("terminal review releases only its own active-run lock after persisting the report", async () => {
  const { mkdir, readFile } = await import("node:fs/promises");
  for (const owner of ["r", "another-run"]) {
    const f = await fixture();
    const lock = join(f.store.root, "active-run.lock");
    try {
      await mkdir(lock);
      await writeFile(
        join(lock, "owner.json"),
        JSON.stringify({ runId: owner, repositoryId: f.store.repositoryId }),
      );
      await coordinateReviewRound({
        ...f.options,
        reviewers: {
          code: async (s) => code(s),
          functional: async (s) => functional(s),
        },
      });
      expect((await f.store.getRun("r"))?.reviewWorkflow?.status).toBe(
        "terminal",
      );
      if (owner === "r")
        await expect(readFile(join(lock, "owner.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      else
        expect(
          JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).runId,
        ).toBe(owner);
    } finally {
      await f.project.cleanup();
    }
  }
});

test("generated repairs cannot alias an original approved issue ID", async () => {
  const { createRepairTasks } = await import("../../src/review/repairs.js");
  const snapshot: ReviewSnapshot = {
    runId: "r",
    round: 1,
    commit: "a".repeat(40),
    prdRevision: "p",
    graphRevision: "g",
    evidenceRefs: ["test"],
  };
  const original = {
    id: "repair-1-1",
    title: "Original",
    dependencies: [],
    status: "integrated" as const,
    blockers: [],
  };
  const tasks = createRepairTasks(snapshot, [defect(snapshot)], [original]);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.id).not.toBe(original.id);
  expect(tasks[0]?.originalIssues).toEqual([original]);
});
