import { describe, expect, test } from "bun:test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createCommandRouter } from "../../src/commands/router.js";
import type { ExecutionEvidence, RunRecord } from "../../src/core/types.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { RalphPlugin } from "../../src/plugin.js";
import { openRunStore } from "../../src/state/run-store.js";
import {
  createFakeOpenCode,
  createFakePluginContext,
} from "../helpers/fake-opencode.js";
import { createTestProject, git } from "../helpers/project.js";

const zeroStatusSummary = {
  total: 0,
  pending: 0,
  ready: 0,
  running: 0,
  integration_queued: 0,
  integrated: 0,
  blocked: 0,
  failed: 0,
};

function statusExecution(
  statuses: ExecutionEvidence["issues"][number]["status"][],
): ExecutionEvidence {
  return {
    issues: statuses.map((status, index) => ({
      id: `issue-${index}`,
      title: `Issue ${index}`,
      dependencies: [],
      status,
      blockers: [],
    })),
    integrationQueue: ["not-an-issue"],
    checks: [],
  };
}

describe("command status issue summary", () => {
  test("status counts repeated execution statuses and preserves explicit and latest selection", async () => {
    const project = await createTestProject();
    try {
      const store = await openRunStore(project.directory);
      const earlier = await store.createRun("earlier");
      const mixed = statusExecution([
        "pending",
        "ready",
        "running",
        "integration_queued",
        "integrated",
        "blocked",
        "failed",
        "running",
        "integrated",
      ]);
      expect(
        await store.recordExecution("earlier", earlier.revision, mixed),
      ).toBe(true);
      const later = await store.createRun("later");
      const subset = statusExecution(["ready", "ready"]);
      expect(await store.recordExecution("later", later.revision, subset)).toBe(
        true,
      );
      // Updating the earlier run must not make it the latest list entry.
      expect(
        await store.recordControl("earlier", {
          status: "paused",
          source: "human",
        }),
      ).toBe(true);
      const reopened = await openRunStore(project.directory);
      expect((await reopened.listRuns()).at(-1)?.runId).toBe("later");
      const router = createCommandRouter(reopened);
      const explicit = JSON.parse(
        await router.dispatch("ralph-status", "  earlier  "),
      );
      expect(explicit.issueSummary).toEqual({
        total: 9,
        pending: 1,
        ready: 1,
        running: 2,
        integration_queued: 1,
        integrated: 2,
        blocked: 1,
        failed: 1,
      });
      const latest = JSON.parse(await router.dispatch("ralph-status"));
      expect(latest.issueSummary).toEqual({
        ...zeroStatusSummary,
        total: 2,
        ready: 2,
      });
      expect(latest.runId).toBe("later");
      expect(explicit.execution).toEqual(mixed);
      expect(latest.execution).toEqual(subset);
    } finally {
      await project.cleanup();
    }
  });

  test("status returns complete zero summaries with missing or empty execution and unchanged defaults", async () => {
    const project = await createTestProject();
    try {
      const store = await openRunStore(project.directory);
      const run = await store.createRun("zero");
      const router = createCommandRouter(store);
      const expected = {
        runId: "zero",
        revision: run.revision,
        phase: "ready",
        control: null,
        lastResult: null,
        issueAttempts: {},
        errors: [],
        issueSummary: zeroStatusSummary,
      };
      expect(JSON.parse(await router.dispatch("ralph-status", "zero"))).toEqual(
        expected,
      );
      const execution = statusExecution([]);
      expect(await store.recordExecution("zero", run.revision, execution)).toBe(
        true,
      );
      expect(JSON.parse(await router.dispatch("ralph-status", "zero"))).toEqual(
        {
          ...expected,
          revision: run.revision + 1,
          execution,
        },
      );
    } finally {
      await project.cleanup();
    }
  });

  test("status adds only the summary while excluding planning issues and attempt history", async () => {
    const project = await createTestProject();
    try {
      const store = await openRunStore(project.directory);
      const created = await store.createRun("populated");
      const execution = statusExecution(["blocked"]);
      const job = {
        runId: created.runId,
        jobId: "job",
        attempt: 3,
        role: "executor",
        workspace: project.directory,
        baseCommit: project.commit,
        inputRevisions: {},
        prompt: "execute",
      };
      // Inject a typed read projection to cover optional/default presence independently
      // of the unrelated approval and review workflows that normally populate it.
      const run: RunRecord = {
        ...created,
        control: { status: "paused", source: "human" },
        lastResult: {
          ...job,
          outcome: "completed",
          evidence: ["message"],
          text: "done",
        },
        execution,
        planning: {
          phase: "execution_approved",
          sessionId: "main",
          workspace: project.directory,
          feature: "summary",
          commandHash: "commands",
          settings: { concurrency: 2, timeoutMs: 1000, models: {}, skills: {} },
          transcript: [],
          turn: 1,
          graph: {
            revision: 1,
            hash: "graph",
            artifactPath: "issues.json",
            order: ["P", "Q"],
            files: {},
            value: {
              schemaVersion: 1,
              prdRevision: { revision: 1, hash: "prd", artifactPath: "PRD.md" },
              issues: [
                {
                  id: "P",
                  title: "Planning only",
                  dependencies: [],
                  acceptanceCriteria: ["pass"],
                  testableBehaviors: ["pass"],
                  artifactPath: "issues/P.md",
                },
                {
                  id: "Q",
                  title: "Planning only",
                  dependencies: [],
                  acceptanceCriteria: ["pass"],
                  testableBehaviors: ["pass"],
                  artifactPath: "issues/Q.md",
                },
              ],
            },
          },
        },
        baseline: {
          status: "passed",
          operationId: "baseline",
          candidateCommit: project.commit,
          commandHash: "commands",
          commandRevision: 1,
        },
        validationSkips: ["optional-check"],
        issueAttempts: {
          P: {
            issueId: "P",
            attempt: 3,
            status: "failed",
            operationId: "attempt-3",
            job,
            history: [1, 2].map((attempt) => ({
              issueId: "P",
              attempt,
              status: "failed",
              operationId: `attempt-${attempt}`,
              job: { ...job, attempt },
            })),
          },
        },
        reviewWorkflow: {
          ownerId: "owner",
          branch: "feature",
          commit: project.commit,
          status: "running",
          rounds: [],
        },
        review: {
          snapshot: {
            runId: created.runId,
            round: 1,
            commit: project.commit,
            prdRevision: "1",
            graphRevision: "1",
            evidenceRefs: [],
          },
          inputs: {
            baseCommit: project.commit,
            prd: "prd",
            graph: "graph",
            diff: "diff",
            tests: [],
            execution,
          },
          summary: "review pending",
        },
        errors: [{ code: "sdk-error", message: "retained error" }],
      };
      const dashboardUrl = "http://localhost:1234/#token";
      const router = createCommandRouter(
        { ...store, getRun: async () => run },
        undefined,
        dashboardUrl,
        project.directory,
      );
      const projectSetup = await router.projectStatus(project.directory);
      const expected = {
        dashboardUrl,
        projectSetup,
        runId: run.runId,
        revision: run.revision,
        phase: run.phase,
        control: run.control,
        lastResult: run.lastResult,
        review: run.review,
        reviewWorkflow: run.reviewWorkflow,
        planning: run.planning,
        baseline: run.baseline,
        validationSkips: ["optional-check"],
        issueAttempts: run.issueAttempts,
        execution,
        errors: run.errors,
        issueSummary: { ...zeroStatusSummary, total: 1, blocked: 1 },
      };
      expect(
        JSON.parse(await router.dispatch("ralph-status", run.runId)),
      ).toEqual(expected);
      delete run.validationSkips;
      expect(
        JSON.parse(await router.dispatch("ralph-status", run.runId)),
      ).toEqual({ ...expected, validationSkips: [] });
      delete run.baseline;
      run.validationSkips = ["must-not-leak-without-baseline"];
      const {
        baseline: _baseline,
        validationSkips: _skips,
        ...withoutBaseline
      } = expected;
      expect(
        JSON.parse(await router.dispatch("ralph-status", run.runId)),
      ).toEqual(withoutBaseline);
    } finally {
      await project.cleanup();
    }
  });

  test("status preserves every no-run text and metadata form for empty and unknown selections", async () => {
    const project = await createTestProject();
    try {
      const store = await openRunStore(project.directory);
      for (const selection of ["empty", "unknown"]) {
        if (selection === "unknown") await store.createRun("known");
        for (const dashboardUrl of [
          undefined,
          "http://localhost:1234/#token",
        ]) {
          for (const workspace of [undefined, project.directory]) {
            const router = createCommandRouter(
              store,
              undefined,
              dashboardUrl,
              workspace,
            );
            const output = await router.dispatch(
              "ralph-status",
              selection === "empty" ? "" : "unknown",
            );
            if (!dashboardUrl && !workspace) {
              expect(output).toBe("No Ralph run found.");
            } else {
              expect(JSON.parse(output)).toEqual({
                ...(dashboardUrl ? { dashboardUrl } : {}),
                ...(workspace
                  ? { projectSetup: await router.projectStatus(workspace) }
                  : {}),
                message: "No Ralph run found.",
              });
            }
          }
        }
      }
    } finally {
      await project.cleanup();
    }
  });
});

describe("durable local session result", () => {
  test("status returns the same correlated result after reopening", async () => {
    const project = await createTestProject();
    try {
      const store = await openRunStore(project.directory);
      await store.createRun("run-1");
      const job = {
        runId: "run-1",
        jobId: "job-1",
        attempt: 1,
        role: "executor",
        workspace: project.directory,
        inputRevisions: {},
        baseCommit: project.commit,
        prompt: "hello",
      };
      await store.recordIntent(job);
      await store.attachSession(job, "session-1");
      await store.recordResult({
        ...job,
        sessionId: "session-1",
        outcome: "completed",
        text: "actual response",
        evidence: ["message-1"],
      });
      const before = await createCommandRouter(store).status("run-1");
      const reopened = await openRunStore(project.directory);
      expect(await createCommandRouter(reopened).status("run-1")).toEqual(
        before,
      );
      expect(before).toContain("actual response");
      expect((await reopened.events("run-1")).map((e) => e.sequence)).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      await project.cleanup();
    }
  });
});

test("adapter persists intent before dispatch and routes both calls to the job workspace", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.hold();
    const adapter = createOpenCodeAdapter(fake.client, store);
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    };
    const pending = adapter.dispatchJob(job);
    while (fake.requests.length < 2) await Bun.sleep(10);
    expect((await store.getRun("r"))?.jobs.j?.status).toBe("running");
    expect(fake.requests.slice(0, 2).map((r) => r.directory)).toEqual([
      project.directory,
      project.directory,
    ]);
    expect(fake.requests[0]?.body).not.toHaveProperty("permission");
    fake.release();
    const result = await pending;
    expect(result.outcome).toBe("completed");
    expect((await store.getRun("r"))?.lastResult?.sessionId).toBe("session-1");
  } finally {
    await project.cleanup();
  }
});

test("v2 plugin registers direct commands and reads durable state without a model", async () => {
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  const host = createFakePluginContext(project.directory, fake.client);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    expect(host.commands.has("ralph-status")).toBe(true);
    const store = await openRunStore(project.directory);
    await store.createRun("persisted");
    const tool = host.tools.get("ralph_status");
    expect(tool).toBeDefined();
    expect(
      (await tool?.execute({ runId: "persisted" }, {} as never))?.content,
    ).toContain("persisted");
    expect(fake.requests).toHaveLength(0);
    await host.commands.get("ralph-status")?.execute({
      sessionID: "parent",
      prompt: { text: "persisted" },
      delivery: "steer",
    } as never);
    expect(fake.requests.at(-1)?.body).toMatchObject({ resume: false });
    expect(fake.requests.at(-1)?.body.text).toContain("persisted");
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("cancelling during session creation aborts the newly created session without prompting it", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.holdCreation();
    const adapter = createOpenCodeAdapter(fake.client, store);
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    };
    const pending = adapter.dispatchJob(job);
    while (!fake.requests.length) await Bun.sleep(10);
    await adapter.cancelJob(job);
    fake.release();
    expect((await pending).outcome).toBe("cancelled");
    expect(fake.requests.map((r) => r.path)).toEqual([
      "/api/session",
      "/api/session/session-1/interrupt",
    ]);
    expect((await store.getRun("r"))?.phase).toBe("cancelled");
  } finally {
    await project.cleanup();
  }
});

test("a denied operation persists as denied and has no process fallback", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.deny();
    const result = await createOpenCodeAdapter(fake.client, store).dispatchJob({
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "execute a command",
    });
    expect(result.outcome).toBe("denied");
    expect(result.error?.code).toBe("permission-denied");
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/session"]);
    await expect(
      (await openRunStore(project.directory)).getRun("r"),
    ).resolves.toMatchObject({
      phase: "failed",
      lastResult: { outcome: "denied" },
    });
  } finally {
    await project.cleanup();
  }
});

test("duplicate permission events and late success cannot transition twice", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.hold();
    const adapter = createOpenCodeAdapter(fake.client, store);
    const pending = adapter.dispatchJob({
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    });
    while (fake.requests.length < 2) await Bun.sleep(10);
    await adapter.receiveEvent({
      type: "session.idle",
      id: "idle",
      created: 1,
      data: { sessionID: "session-1" },
    });
    expect((await store.getRun("r"))?.phase).toBe("running");
    const event = {
      type: "permission.replied" as const,
      id: "rejection",
      created: 1,
      data: {
        sessionID: "session-1",
        requestID: "p",
        reply: "reject" as const,
      },
    };
    await adapter.receiveEvent(event);
    await adapter.receiveEvent(event);
    const before = await store.getRun("r");
    fake.release();
    expect((await pending).outcome).toBe("denied");
    expect(await store.getRun("r")).toEqual(before);
    expect(
      (await store.events("r")).filter((e) => e.type === "job.result"),
    ).toHaveLength(1);
  } finally {
    await project.cleanup();
  }
});

test("missing output is failed and user questions disclose unsupported API", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.empty();
    const adapter = createOpenCodeAdapter(fake.client, store);
    const result = await adapter.dispatchJob({
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    });
    expect(result.error?.code).toBe("missing-output");
    expect(
      await adapter.requestUserInput({
        runId: "r",
        requestId: "q",
        revision: 1,
        sessionId: "session-1",
        workspace: project.directory,
        question: "approve?",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
  } finally {
    await project.cleanup();
  }
});

test("linked worktrees share a canonical store but separate repositories do not", async () => {
  const project = await createTestProject();
  const other = await createTestProject();
  try {
    const linked = `${project.directory}-linked`;
    await git("git", [
      "-C",
      project.directory,
      "worktree",
      "add",
      "-b",
      "linked",
      linked,
    ]);
    try {
      const primary = await openRunStore(project.directory);
      await primary.createRun("shared");
      const secondary = await openRunStore(linked);
      expect(secondary.root).toBe(primary.root);
      expect((await secondary.getRun("shared"))?.runId).toBe("shared");
      const independent = await openRunStore(other.directory);
      expect(independent.root).not.toBe(primary.root);
      expect(await independent.getRun("shared")).toBeUndefined();
    } finally {
      await git("git", [
        "-C",
        project.directory,
        "worktree",
        "remove",
        "--force",
        linked,
      ]);
    }
  } finally {
    await project.cleanup();
    await other.cleanup();
  }
});

test("an earlier denied tool remains denied even when the final assistant message succeeds", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.denyTool();
    const result = await createOpenCodeAdapter(fake.client, store).dispatchJob({
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    });
    expect(result.outcome).toBe("denied");
    expect((await store.getRun("r"))?.lastResult?.error?.code).toBe(
      "permission-denied",
    );
  } finally {
    await project.cleanup();
  }
});

test("a late empty response cannot replace a cancelled result", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.hold();
    fake.empty();
    const adapter = createOpenCodeAdapter(fake.client, store);
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    };
    const pending = adapter.dispatchJob(job);
    while (fake.requests.length < 2) await Bun.sleep(10);
    await adapter.cancelJob(job);
    fake.release();
    expect((await pending).outcome).toBe("cancelled");
    expect((await store.getRun("r"))?.lastResult?.outcome).toBe("cancelled");
  } finally {
    await project.cleanup();
  }
});

test("an unavailable tool cannot be reported as a completed job", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.invalidTool();
    const result = await createOpenCodeAdapter(fake.client, store).dispatchJob({
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    });
    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("sdk-error");
  } finally {
    await project.cleanup();
  }
});

test("abort denial is recorded durably without losing cancellation", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const fake = createFakeOpenCode();
    fake.hold();
    const adapter = createOpenCodeAdapter(fake.client, store);
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    };
    const pending = adapter.dispatchJob(job);
    while (fake.requests.length < 2) await Bun.sleep(10);
    fake.deny();
    expect(await adapter.cancelJob(job)).toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
    expect(
      (await store.getRun("r"))?.errors.some(
        (e) => e.code === "permission-denied",
      ),
    ).toBe(true);
    fake.release();
    await pending;
    expect((await store.getRun("r"))?.phase).toBe("cancelled");
  } finally {
    await project.cleanup();
  }
});

test("concurrent stores commit one result and reject superseded attempt completions", async () => {
  const project = await createTestProject();
  try {
    const a = await openRunStore(project.directory);
    const b = await openRunStore(project.directory);
    await a.createRun("r");
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    };
    expect(
      (await Promise.all([a.recordIntent(job), b.recordIntent(job)])).filter(
        Boolean,
      ),
    ).toHaveLength(1);
    await a.attachSession(job, "s1");
    const result = {
      ...job,
      sessionId: "s1",
      outcome: "completed" as const,
      text: "first",
      evidence: ["m1"],
    };
    expect(
      (
        await Promise.all([a.recordResult(result), b.recordResult(result)])
      ).filter(Boolean),
    ).toHaveLength(1);
    const retry = { ...job, attempt: 2 };
    await a.recordIntent(retry);
    await a.attachSession(retry, "s2");
    expect(await b.recordResult(result)).toBe(false);
    expect((await b.getRun("r"))?.jobs.j?.envelope.sessionId).toBe("s2");
    const events = await b.events("r");
    expect(events.map((e) => e.revision)).toEqual([1, 2, 3, 4, 5, 6]);
  } finally {
    await project.cleanup();
  }
});

test("the committed journal recovers a missing snapshot and discards a torn final append", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const before = await store.getRun("r");
    await rm(join(store.root, "r.json"));
    await appendFile(join(store.root, "events.jsonl"), '{"incomplete":');
    const reopened = await openRunStore(project.directory);
    expect(await reopened.getRun("r")).toEqual(before);
    await reopened.createRun("another");
    expect((await reopened.listRuns()).map((r) => r.runId)).toEqual([
      "r",
      "another",
    ]);
    expect((await reopened.events("another"))[0]?.sequence).toBe(2);
  } finally {
    await project.cleanup();
  }
});

test("the public router starts a session job and status exposes its persisted response", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    const fake = createFakeOpenCode();
    const router = createCommandRouter(
      store,
      createOpenCodeAdapter(fake.client, store),
    );
    const result = await router.runJob({
      runId: "public-run",
      jobId: "public-job",
      attempt: 1,
      role: "probe",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    });
    expect(result.outcome).toBe("completed");
    const reopened = createCommandRouter(await openRunStore(project.directory));
    expect(await reopened.dispatch("ralph-status", "public-run")).toContain(
      "actual response",
    );
    expect(await reopened.dispatch("ralph-status", "public-run")).toContain(
      "public-job",
    );
  } finally {
    await project.cleanup();
  }
});

test("v2 observation aliases preserve permissions and exclude mutation and code-mode tools", async () => {
  const project = await createTestProject();
  const host = createFakePluginContext(project.directory);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    host.tools.set("read", {
      id: "read",
      name: "read",
      description: "fixture read",
      input: z.object({}),
      options: { permission: "read" },
      execute: async () => ({ content: "observed" }),
    });
    await host.rpcHandlers.get("prepareReview")?.({ tools: ["read"] } as never);
    const observation = host.tools.get("ralph_review_read");
    expect(observation?.options).toEqual({
      codemode: false,
      permission: "read",
    });
    const store = await openRunStore(project.directory);
    await store.createRun("read-only");
    const job = {
      runId: "read-only",
      jobId: "review",
      role: "probe",
      attempt: 1,
      readOnly: true,
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: {},
      prompt: "review",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "review-session");
    const input = {
      sessionID: "review-session",
      tools: {
        ralph_review_read: {},
        shell: {},
        execute: {},
        ralph_control: {},
      },
    };
    await host.hooks.get("session.context")?.(input);
    expect(Object.keys(input.tools)).toEqual(["ralph_review_read"]);
    await expect(
      Promise.resolve().then(() =>
        host.hooks.get("tool.execute.before")?.({
          sessionID: "review-session",
          tool: "shell",
        }),
      ),
    ).rejects.toThrow("Permission denied");
    await host.hooks.get("tool.execute.before")?.({
      sessionID: "review-session",
      tool: "ralph_review_read",
    });
    const normal = {
      sessionID: "normal-session",
      tools: { ralph_review_read: {}, shell: {}, execute: {} },
    };
    await host.hooks.get("session.context")?.(normal);
    expect(Object.keys(normal.tools)).toEqual(["shell", "execute"]);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("a caught v2 code-mode tool failure cannot be erased by later assistant success", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("nested");
    const fake = createFakeOpenCode();
    fake.failCodeMode();
    const result = await createOpenCodeAdapter(fake.client, store).dispatchJob({
      runId: "nested",
      jobId: "nested",
      role: "probe",
      attempt: 1,
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: {},
      prompt: "probe",
    });
    expect(result.outcome).toBe("failed");
    expect(result.error?.message).toContain("failed tool call");
  } finally {
    await project.cleanup();
  }
});

test("a second v2 location neither recovers nor stops another location's active job", async () => {
  const project = await createTestProject();
  const firstHost = createFakePluginContext(project.directory);
  const first = await RalphPlugin.setup(firstHost.context);
  let second: Awaited<ReturnType<typeof RalphPlugin.setup>> | undefined;
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("active");
    const job = {
      runId: "active",
      jobId: "live",
      role: "probe",
      attempt: 1,
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: {},
      prompt: "probe",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "live-session");
    const before = await store.getRun("active");
    second = await RalphPlugin.setup(
      createFakePluginContext(project.directory).context,
    );
    expect(await store.getRun("active")).toEqual(before);
    await second?.();
    expect(await store.getRun("active")).toEqual(before);
    await first?.();
    expect((await store.getRun("active"))?.control?.status).toBe("interrupted");
  } finally {
    await second?.();
    await first?.();
    await project.cleanup();
  }
});

test("v2 TUI status notifications are scoped and their subscription is disposed", async () => {
  const { default: plugin } = await import("../../src/tui.js");
  let listener: ((input: { details: unknown }) => void) | undefined;
  let disposed = false;
  const shown: unknown[] = [];
  const cleanup = await plugin.setup({
    location: { directory: "/fixture" },
    data: {
      listen: (handler: typeof listener) => {
        listener = handler;
        return () => {
          disposed = true;
        };
      },
    },
    ui: {
      toast: {
        show: (toast: unknown) => {
          shown.push(toast);
        },
      },
    },
  } as never);
  listener?.({
    details: {
      type: "rpc.ralph.status",
      location: { directory: "/other" },
      data: { text: "other" },
    },
  });
  listener?.({
    details: {
      type: "rpc.ralph.status",
      location: { directory: "/fixture" },
      data: { text: "ready" },
    },
  });
  expect(shown).toEqual([
    { title: "Ralph status", message: "ready", variant: "info" },
  ]);
  await cleanup?.();
  expect(disposed).toBe(true);
});

test("adapter uses native host questions for correlated approvals without reading assistant text", async () => {
  const project = await createTestProject();
  try {
    const { requestNativeInput } = await import(
      "../../src/opencode/native-input.js"
    );
    const fake = createFakeOpenCode();
    const host = createFakePluginContext(project.directory, fake.client);
    const request = {
      runId: "r",
      sessionId: "main",
      workspace: project.directory,
      requestId: "request-1",
      revision: 2,
      question: "Approve by replying approve 2, or reply with revisions.",
      options: [
        { label: "approve 2", description: "Approve this exact revision" },
      ],
    };
    let invoked = false;
    host.tools.set("question", {
      id: "question",
      name: "question",
      input: z.object({}),
      async execute(
        input: unknown,
        context: { sessionID: string; id: string },
      ) {
        invoked = true;
        expect(context.sessionID).toBe("main");
        expect(context.id).toBe("ralph-input:request-1");
        expect(input).toMatchObject({
          questions: [
            { question: request.question, options: [{ label: "approve 2" }] },
          ],
        });
        return {
          metadata: { answers: [["approve 2"]] },
          content: "Untrusted rendered text",
        };
      },
    } as never);
    const adapter = createOpenCodeAdapter(
      {
        ...fake.client,
        requestUserInput: (r) =>
          requestNativeInput(host.context, r, new AbortController().signal),
      },
      await openRunStore(project.directory),
    );
    expect(await adapter.requestUserInput(request)).toMatchObject({
      ok: true,
      source: "user",
      text: "approve 2",
      requestId: "request-1",
      sessionId: "main",
      revision: 2,
    });
    expect(invoked).toBe(true);
  } finally {
    await project.cleanup();
  }
});

test("a missing exploratory read does not discard a completed agent result", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    fake.missingRead();
    const store = await openRunStore(project.directory);
    await store.createRun("missing-read");
    const adapter = createOpenCodeAdapter(fake.client, store);
    const result = await adapter.dispatchJob({
      runId: "missing-read",
      jobId: "j",
      attempt: 1,
      role: "command-discovery",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "Explore the actual files",
    });
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("actual response");
  } finally {
    await project.cleanup();
  }
});

test("setup command prompts the current assistant with normal tools and creates no jobs", async () => {
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  const host = createFakePluginContext(project.directory, fake.client);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    await host.commands.get("ralph-commands")?.execute({
      sessionID: "main",
      prompt: { text: "" },
      delivery: "steer",
    } as never);
    expect(host.tools.has("ralph_save_commands")).toBe(true);
    const prompts = fake.requests.filter((r) => r.path.endsWith("/prompt"));
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0]?.body)).toContain(
      "Set up Ralph project commands in this conversation.",
    );
    await expect(
      (await openRunStore(project.directory)).listRuns(),
    ).resolves.toHaveLength(0);
    const input = {
      sessionID: "main",
      tools: { read: {}, grep: {}, question: {}, ralph_save_commands: {} },
    };
    await host.hooks.get("session.context")?.(input);
    expect(Object.keys(input.tools)).toEqual([
      "read",
      "grep",
      "question",
      "ralph_save_commands",
    ]);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("provider authentication rejection is reported as a provider failure rather than host permission denial", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    const store = await openRunStore(project.directory);
    await store.createRun("auth");
    const adapter = createOpenCodeAdapter(
      {
        ...fake.client,
        session: {
          ...fake.client.session,
          async create() {
            throw {
              type: "provider.auth",
              status: 403,
              message: "Provider authentication rejected",
            };
          },
        },
      },
      store,
    );
    const result = await adapter.dispatchJob({
      runId: "auth",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "hello",
    });
    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("sdk-error");
  } finally {
    await project.cleanup();
  }
});

test("independent location modules share recovery ownership and only the last location stops work", async () => {
  const project = await createTestProject();
  const first = await RalphPlugin.setup(
    createFakePluginContext(project.directory).context,
  );
  let second: Awaited<ReturnType<typeof RalphPlugin.setup>> | undefined;
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("live");
    const job = {
      runId: "live",
      jobId: "executor",
      role: "executor",
      attempt: 1,
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "active",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "active-session");
    const before = await store.getRun("live");
    const isolated = await import(
      `../../src/plugin.ts?location=${crypto.randomUUID()}`
    );
    second = await isolated.RalphPlugin.setup(
      createFakePluginContext(project.directory).context,
    );
    expect(await store.getRun("live")).toEqual(before);
    await first?.();
    expect(await store.getRun("live")).toEqual(before);
    await second?.();
    expect((await store.getRun("live"))?.control?.status).toBe("interrupted");
  } finally {
    await second?.();
    await first?.();
    await project.cleanup();
  }
});

test("cancellation interrupts a prompt that arrives after the first interrupt", async () => {
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  fake.holdPrompt();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("late");
    const adapter = createOpenCodeAdapter(fake.client, store);
    const job = {
      runId: "late",
      jobId: "executor",
      role: "executor",
      attempt: 1,
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "active",
    };
    const pending = adapter.dispatchJob(job);
    for (
      let i = 0;
      !fake.requests.some((r) => r.path.endsWith("/prompt"));
      i++
    ) {
      if (i > 100) throw new Error("No prompt");
      await Bun.sleep(10);
    }
    expect((await adapter.cancelJob(job)).ok).toBe(true);
    fake.release();
    expect((await pending).outcome).toBe("cancelled");
    expect(
      fake.requests.filter((r) => r.path.endsWith("/interrupt")),
    ).toHaveLength(2);
    expect(fake.requests.some((r) => r.path.endsWith("/context"))).toBe(false);
  } finally {
    fake.release();
    await project.cleanup();
  }
});

test("a fresh location bootstraps permission-preserving observations without parent RPC", async () => {
  const project = await createTestProject();
  const host = createFakePluginContext(project.directory);
  host.tools.set("read", {
    id: "read",
    name: "read",
    description: "read",
    input: z.object({}),
    options: { permission: "read" },
    execute: async () => ({ content: "observed" }),
  });
  const dispose = await RalphPlugin.setup(host.context);
  try {
    expect(host.tools.get("ralph_review_read")?.options).toEqual({
      codemode: false,
      permission: "read",
    });
    expect(host.tools.has("ralph_review_shell")).toBe(false);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("owned agent shell calls stay foreground while unrelated sessions retain their choice", async () => {
  const project = await createTestProject();
  const host = createFakePluginContext(project.directory);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("run");
    const job = {
      runId: "run",
      jobId: "executor",
      role: "executor",
      attempt: 1,
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "work",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "owned");
    const owned = {
      sessionID: "owned",
      tool: "shell",
      input: { command: "bun run test", background: true, timeout: 600000 },
    };
    await host.hooks.get("tool.execute.before")?.(owned);
    expect(owned.input).toEqual({
      command: "bun run test",
      background: false,
      timeout: 600000,
    });
    const unrelated = {
      sessionID: "unrelated",
      tool: "shell",
      input: { command: "bun run test", background: true },
    };
    await host.hooks.get("tool.execute.before")?.(unrelated);
    expect(unrelated.input.background).toBe(true);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("a background shell receipt and early idle are not a completed job or idle recovery proof", async () => {
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  let completed = false;
  let reads = 0;
  const client = {
    ...fake.client,
    session: {
      ...fake.client.session,
      async context(input: Parameters<typeof fake.client.session.context>[0]) {
        reads++;
        const history = await fake.client.session.context(input);
        const receipt: Awaited<
          ReturnType<typeof fake.client.session.context>
        >[number] = {
          id: "background",
          type: "assistant" as const,
          agent: "build",
          model: { id: "fixture", providerID: "fixture" },
          time: { created: 2, completed: 3 },
          finish: "tool-calls" as const,
          content: [
            {
              type: "tool" as const,
              id: "call",
              name: "shell",
              executed: false,
              state: {
                status: "completed" as const,
                input: { command: "test", background: true },
                content: [{ type: "text", text: "background receipt" }],
                metadata: { status: "running", shellID: "shell-owned" },
              },
              time: { created: 2, ran: 2, completed: 3 },
            },
          ],
        };
        history.splice(1, 0, receipt);
        if (completed)
          history.splice(history.length - 1, 0, {
            id: "background-done",
            type: "shell",
            shellID: "shell-owned",
            command: "test",
            status: "exited",
            exit: 0,
            time: { created: 4, completed: 5 },
          });
        return history;
      },
    },
  };
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("run");
    const adapter = createOpenCodeAdapter(client, store);
    const job = {
      runId: "run",
      jobId: "executor",
      role: "executor",
      attempt: 1,
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "work",
    };
    let settled = false;
    const pending = adapter.dispatchJob(job).then((result) => {
      settled = true;
      return result;
    });
    for (let i = 0; reads < 1; i++) {
      if (i > 100) throw new Error("No context");
      await Bun.sleep(10);
    }
    expect(settled).toBe(false);
    const bound = (await store.getRun("run"))?.jobs.executor?.envelope;
    if (!bound) throw new Error("No session");
    expect(await adapter.inspectSession?.(bound)).toBe("busy");
    completed = true;
    expect((await pending).outcome).toBe("completed");
    expect(reads).toBeGreaterThan(2);
    expect(
      fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(1);
  } finally {
    completed = true;
    await project.cleanup();
  }
});

test("journal read caching preserves caller isolation, external appends and same-size rewrite validation", async () => {
  const project = await createTestProject();
  try {
    const first = await openRunStore(project.directory);
    await first.createRun("run");
    const local = await first.getRun("run");
    local?.errors.push({ code: "sdk-error", message: "not persisted" });
    const listed = await first.listRuns();
    listed[0]?.errors.push({ code: "sdk-error", message: "not persisted" });
    const events = await first.events("run");
    events[0]?.snapshot.errors.push({
      code: "sdk-error",
      message: "not persisted",
    });
    expect((await first.getRun("run"))?.errors).toEqual([]);
    const second = await openRunStore(project.directory);
    await second.recordControl("run", { status: "paused", source: "human" });
    expect((await first.getRun("run"))?.control?.status).toBe("paused");
    const journal = join(first.root, "events.jsonl");
    const raw = await readFile(journal, "utf8");
    const rewritten = raw.replace('"sequence":1', '"sequence":9');
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(raw));
    await writeFile(journal, rewritten);
    await expect(first.getRun("run")).rejects.toThrow("Invalid run journal");
  } finally {
    await project.cleanup();
  }
});

test("native executor receipts are bounded to the attested turn and survive reopening", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("receipts");
    const job = {
      runId: "receipts",
      jobId: "exec",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: {},
      prompt: "implement",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "native-session");
    await store.recordResult({
      ...job,
      sessionId: "native-session",
      outcome: "completed",
      evidence: ["final"],
    });
    const fake = createFakeOpenCode();
    const observation = (
      id: string,
      command: string,
      output: string,
      exit: number,
    ) => ({
      id,
      type: "assistant",
      content: [
        {
          id: `call-${id}`,
          type: "tool",
          name: "shell",
          state: {
            status: "completed",
            input: { command },
            content: [{ type: "text", text: output }],
            metadata: { exit },
          },
        },
      ],
    });
    fake.client.session.context = async () =>
      [
        { id: "old-user", type: "user" },
        observation("old", "bun test", "old result", 0),
        { id: "prompt", type: "user" },
        observation("red", "bun run test:status", "3 fail", 1),
        observation("unrelated", "cat private.txt", "unrelated content", 0),
        observation("green", "bun run test:status", "13 pass", 0),
        { id: "final", type: "assistant", content: [] },
        { id: "later-user", type: "user" },
        observation("later", "bun test", "later result", 0),
      ] as never;
    const adapter = createOpenCodeAdapter(fake.client, store);
    const before = (await store.getRun("receipts"))?.revision;
    if (!adapter.observeJob) throw new Error("Missing native receipt observer");
    const evidence = await adapter.observeJob(job);
    expect((await store.getRun("receipts"))?.revision).toBe(before);
    expect(
      evidence.observations.map((o) => [o.messageId, o.exitCode, o.output]),
    ).toEqual([
      ["red", 1, "3 fail"],
      ["green", 0, "13 pass"],
    ]);
    expect(evidence.promptMessageId).toBe("prompt");
    await adapter.observeJob(job, { persist: true });
    const reopened = await openRunStore(project.directory);
    expect(
      (await reopened.getRun("receipts"))?.jobs.exec?.nativeEvidence,
    ).toEqual(evidence);
    expect(
      (await adapter.observeJob({ ...job, attempt: 2 })).unavailableReason,
    ).toContain("correlated");
    fake.client.session.context = async () => {
      throw new Error("session unavailable");
    };
    expect(
      await createOpenCodeAdapter(fake.client, reopened).observeJob?.(job),
    ).toEqual(evidence);
    expect(
      await reopened.recordJobEvidence(job, {
        ...evidence,
        sessionId: "other",
      }),
    ).toBe(false);
  } finally {
    await project.cleanup();
  }
});

test("journal event cursors return isolated snapshots without replaying unrelated history", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("one");
    await store.createRun("two");
    const job = {
      runId: "one",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: {},
      prompt: "hello",
    };
    await store.recordIntent(job);
    const history = await store.events("one");
    const last = history.at(-1);
    if (!last) throw new Error("Missing committed event");
    expect(history.map((e) => e.sequence)).toEqual([1, 3]);
    expect(await store.events("one", { latest: true })).toEqual([last]);
    expect(await store.events("one", { afterSequence: 1 })).toEqual([last]);
    expect(await store.events("one", { afterSequence: 3 })).toEqual([]);
    expect(await store.events("absent", { latest: true })).toEqual([]);
    if (last)
      last.snapshot.errors.push({
        code: "sdk-error",
        message: "caller mutation",
      });
    expect(
      (await store.events("one", { latest: true }))[0]?.snapshot.errors,
    ).toEqual([]);
    await expect(store.events("one", { afterSequence: -1 })).rejects.toThrow(
      "Invalid event cursor",
    );
  } finally {
    await project.cleanup();
  }
});

for (const tool of [
  "ralph_review_grep",
  "ralph_review_glob",
  "ralph_review_list",
]) {
  test(`command discovery recovers a missing exploratory path from ${tool} without forgiving executor failures`, async () => {
    const project = await createTestProject();
    try {
      const fake = createFakeOpenCode();
      fake.failObservation(tool, "Search path does not exist: src/project");
      const store = await openRunStore(project.directory);
      await store.createRun("missing-search");
      const adapter = createOpenCodeAdapter(fake.client, store);
      const job = {
        runId: "missing-search",
        jobId: "discovery",
        attempt: 1,
        role: "command-discovery",
        readOnly: true,
        workspace: project.directory,
        inputRevisions: {},
        baseCommit: project.commit,
        prompt: "Inspect existing files and return a proposal",
      };
      expect((await adapter.dispatchJob(job)).outcome).toBe("completed");
      expect(
        (
          await adapter.dispatchJob({
            ...job,
            jobId: "executor",
            role: "executor",
            readOnly: false,
          })
        ).outcome,
      ).toBe("failed");
    } finally {
      await project.cleanup();
    }
  });
}
