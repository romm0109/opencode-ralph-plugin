import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleControlCommand } from "../../src/commands/control.js";
import { createCommandRouter } from "../../src/commands/router.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { RalphPlugin } from "../../src/plugin.js";
import {
  disposeEnvironment,
  prepareEnvironment,
} from "../../src/process/environment.js";
import {
  inspectOwnedProcess,
  startOwnedProcess,
  terminateOwnedProcess,
} from "../../src/process/ownership.js";
import { reconcileRun } from "../../src/recovery/reconcile.js";
import { openRunStore } from "../../src/state/run-store.js";
import {
  createFakeOpenCode,
  createFakePluginContext,
} from "../helpers/fake-opencode.js";
import { createTestProject, git } from "../helpers/project.js";
import { required } from "../helpers/single-issue.js";

async function fixture() {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  const fake = createFakeOpenCode();
  const adapter = createOpenCodeAdapter(fake.client, store);
  const router = createCommandRouter(store, adapter);
  await store.createRun("run");
  const job = {
    runId: "run",
    jobId: "issue",
    attempt: 1,
    role: "executor",
    workspace: project.directory,
    inputRevisions: { prd: 2, graph: 3 },
    baseCommit: project.commit,
    prompt: "Implement",
  };
  return { ...project, store, fake, adapter, router, job };
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Fixture did not reach boundary");
}

test("pause freezes dispatch while the active attempt settles; resume preserves revisions", async () => {
  const f = await fixture();
  try {
    f.fake.hold();
    const active = f.router.runJob(f.job);
    await waitFor(
      async () =>
        (await f.store.getRun("run"))?.jobs.issue?.status === "running",
    );
    await f.router.dispatch("ralph-pause", "run");
    const count = f.fake.requests.length;
    await expect(f.router.runJob({ ...f.job, jobId: "other" })).rejects.toThrow(
      "paused",
    );
    expect(f.fake.requests.length).toBe(count);
    f.fake.release();
    expect((await active).outcome).toBe("completed");
    await expect(f.router.runJob({ ...f.job, jobId: "other" })).rejects.toThrow(
      "paused",
    );
    await f.router.dispatch("ralph-resume", "run");
    expect((await f.router.runJob({ ...f.job, jobId: "other" })).outcome).toBe(
      "completed",
    );
    expect(
      (await f.store.getRun("run"))?.jobs.issue?.envelope.inputRevisions,
    ).toEqual({ prd: 2, graph: 3 });
  } finally {
    f.fake.release();
    await f.cleanup();
  }
});

test("stop cancels the bound session and rejects late completion without skipping validation", async () => {
  const f = await fixture();
  try {
    f.fake.hold();
    const active = f.router.runJob(f.job);
    await waitFor(
      async () =>
        (await f.store.getRun("run"))?.jobs.issue?.status === "running",
    );
    await f.router.dispatch("ralph-stop", "run");
    f.fake.release();
    expect((await active).outcome).toBe("cancelled");
    const run = await f.store.getRun("run");
    expect(run?.control?.status).toBe("stopped");
    expect(run?.jobs.issue?.result?.error?.code).toBe("cancelled");
    expect(
      f.fake.requests.filter((r) => r.path.endsWith("/interrupt")),
    ).toHaveLength(1);
    await expect(f.router.runJob({ ...f.job, jobId: "other" })).rejects.toThrow(
      "stopped",
    );
  } finally {
    f.fake.release();
    await f.cleanup();
  }
});

test("restart recognizes an already advanced ref exactly once and requires resume", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "candidate.txt"), "candidate");
    await git("git", ["-C", f.directory, "add", "."]);
    await git("git", ["-C", f.directory, "commit", "-m", "candidate"]);
    const candidate = (
      await git("git", ["-C", f.directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const ref = "refs/heads/ralph-integration";
    await git("git", ["-C", f.directory, "update-ref", ref, f.commit]);
    await f.store.recordOperation({
      operationId: "advance",
      kind: "integration.advance",
      job: f.job,
      status: "intent",
      ref,
      expectedOld: f.commit,
      expectedNew: candidate,
      checks: [
        {
          id: "tests",
          status: "passed",
          attempt: 1,
          candidateCommit: candidate,
          commandRevision: 4,
        },
      ],
    });
    await git("git", [
      "-C",
      f.directory,
      "update-ref",
      ref,
      candidate,
      f.commit,
    ]);
    const reopened = await openRunStore(f.directory);
    const summary = await reconcileRun({
      store: reopened,
      directory: f.directory,
      runId: "run",
      adapter: f.adapter,
    });
    expect(summary.status).toBe("interrupted");
    expect(summary.completedOperations).toEqual(["advance"]);
    await reconcileRun({
      store: reopened,
      directory: f.directory,
      runId: "run",
      adapter: f.adapter,
    });
    expect(
      (await reopened.events("run")).filter(
        (e) => e.type === "operation.result",
      ),
    ).toHaveLength(1);
    const router = createCommandRouter(reopened, f.adapter);
    await expect(router.runJob({ ...f.job, jobId: "next" })).rejects.toThrow(
      "interrupted",
    );
    await router.dispatch("ralph-resume", "run");
    expect((await router.runJob({ ...f.job, jobId: "next" })).outcome).toBe(
      "completed",
    );
    expect(
      (await reopened.getRun("run"))?.operations.advance?.expectedNew,
    ).toBe(candidate);
  } finally {
    await f.cleanup();
  }
});

test("uncertain validation remains blocked until an approved complete rerun", async () => {
  const f = await fixture();
  try {
    await git("git", [
      "-C",
      f.directory,
      "update-ref",
      "refs/heads/candidate",
      f.commit,
    ]);
    await f.store.recordOperation({
      operationId: "check-and-advance",
      kind: "integration.advance",
      job: f.job,
      status: "intent",
      ref: "refs/heads/candidate",
      expectedOld: f.commit,
      expectedNew: f.commit,
      checks: [
        {
          id: "tests",
          status: "running",
          attempt: 3,
          candidateCommit: f.commit,
          commandRevision: 5,
        },
      ],
    });
    expect(
      (
        await reconcileRun({
          store: f.store,
          directory: f.directory,
          runId: "run",
        })
      ).status,
    ).toBe("blocked");
    await expect(f.router.dispatch("ralph-resume", "run")).rejects.toThrow(
      "blocked",
    );
    expect(
      (await f.store.getRun("run"))?.operations["check-and-advance"]?.status,
    ).toBe("intent");
    const summary = await reconcileRun({
      store: f.store,
      directory: f.directory,
      runId: "run",
      revalidate: async () => [
        {
          id: "tests",
          status: "passed",
          attempt: 3,
          candidateCommit: f.commit,
          commandRevision: 5,
        },
      ],
    });
    expect(summary.status).toBe("interrupted");
    expect(
      (await f.store.getRun("run"))?.operations["check-and-advance"]
        ?.checks?.[0]?.attempt,
    ).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test("owned live process is terminated but a reused PID identity is never signalled", async () => {
  const f = await fixture();
  let owned: Awaited<ReturnType<typeof startOwnedProcess>> | undefined;
  try {
    owned = await startOwnedProcess(f.store, f.job, process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    expect((await inspectOwnedProcess(owned)).status).toBe("owned");
    expect(
      (await inspectOwnedProcess({ ...owned, ownerToken: "different-owner" }))
        .status,
    ).toBe("unrelated");
    expect(
      await terminateOwnedProcess({ ...owned, startedAt: "reused-pid" }),
    ).toBe(false);
    expect((await inspectOwnedProcess(owned)).status).toBe("owned");
    await f.router.dispatch("ralph-stop", "run");
    await waitFor(
      async () =>
        (
          await inspectOwnedProcess(
            owned as Awaited<ReturnType<typeof startOwnedProcess>>,
          )
        ).status === "gone",
    );
  } finally {
    if (owned) await terminateOwnedProcess(owned);
    await f.cleanup();
  }
});

test("pause after reviewer settlement prevents repair dispatch until explicit resume", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reviewing = false;
  let repairs = 0;
  let active: Promise<unknown> | undefined;
  try {
    const graph = {
      revision: "g1",
      issues: [{ id: "a", acceptanceCriteria: ["Works"] }],
    };
    await writeFile(join(f.directory, "PRD.md"), "# Acceptance\n- [ ] Works\n");
    await writeFile(join(f.directory, "graph.json"), JSON.stringify(graph));
    await git("git", ["-C", f.directory, "add", "."]);
    await git("git", ["-C", f.directory, "commit", "-m", "requirements"]);
    const commit = (
      await git("git", ["-C", f.directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const run = await f.store.getRun("run");
    if (!run) throw new Error("Missing run");
    await f.store.recordExecution("run", run.revision, {
      verification: "passed",
      issues: [
        {
          id: "a",
          title: "Works",
          dependencies: [],
          status: "integrated",
          blockers: [],
        },
      ],
      integrationQueue: [],
      checks: [
        {
          id: "tests",
          status: "passed",
          attempt: 1,
          candidateCommit: commit,
          commandRevision: 1,
        },
      ],
    });
    active = f.router.reviewFeature({
      directory: f.directory,
      runId: "run",
      commit,
      baseCommit: f.commit,
      graph,
      prdRevision: "p1",
      evidenceRefs: ["test"],
      reviewers: {
        code: async (s) => {
          reviewing = true;
          await gate;
          return {
            role: "code-review",
            reviewedCommit: s.commit,
            round: s.round,
            outcome: "findings",
            findings: [
              {
                id: "defect",
                criterion: "Works",
                suggestedRepair: "Fix Works",
                category: "correctness",
                blocking: true,
                disposition: "open",
                reviewerRole: "code-review",
                reviewedCommit: s.commit,
                evidence: ["test"],
              },
            ],
            evidenceRefs: ["test"],
          };
        },
        functional: async (s) => ({
          role: "functional-review",
          reviewedCommit: s.commit,
          round: s.round,
          outcome: "passed",
          findings: [],
          evidenceRefs: ["test"],
          evidence: [],
          criteria: [],
          attempts: [],
        }),
      },
      repairs: {
        executeIssue: async () => {
          repairs++;
          return {
            outcome: "failed",
            error: { code: "sdk-error", message: "fixture" },
            evidenceRefs: ["failure"],
          };
        },
        integrateIssue: async () => {
          throw new Error("Must not integrate");
        },
      },
    });
    await waitFor(async () => reviewing);
    await f.router.dispatch("ralph-pause", "run");
    release?.();
    await Bun.sleep(100);
    expect(repairs).toBe(0);
    await f.router.dispatch("ralph-resume", "run");
    await active;
    expect(repairs).toBe(3);
  } finally {
    release?.();
    await f.router.dispatch("ralph-resume", "run").catch(() => {});
    await active?.catch(() => {});
    await f.cleanup();
  }
});

test("v2 restart reports recovery, registers controls, and cleanup preserves interruption", async () => {
  const f = await fixture();
  const host = createFakePluginContext(f.directory, f.fake.client);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    expect((await f.store.getRun("run"))?.control?.status).toBe("interrupted");
    expect([...host.commands.keys()]).toEqual(
      expect.arrayContaining(["ralph-pause", "ralph-resume", "ralph-stop"]),
    );
    for (let i = 0; i < 100 && !host.statuses.length; i++) await Bun.sleep(5);
    expect(host.statuses.some((text) => text.includes("requiresResume"))).toBe(
      true,
    );
    await f.router.dispatch("ralph-resume", "run");
    await dispose?.();
    expect((await f.store.getRun("run"))?.control?.status).toBe("interrupted");
    expect(host.commands.size).toBe(0);
  } finally {
    await dispose?.();
    await f.cleanup();
  }
});

test("a blocked recovery cannot be bypassed by pause then resume", async () => {
  const f = await fixture();
  try {
    await f.store.recordControl("run", {
      status: "blocked",
      source: "recovery",
      facts: ["Unknown ref"],
    });
    await expect(f.router.dispatch("ralph-pause", "run")).rejects.toThrow(
      "blocked",
    );
    await expect(f.router.dispatch("ralph-resume", "run")).rejects.toThrow(
      "blocked",
    );
    expect((await f.store.getRun("run"))?.control?.facts).toEqual([
      "Unknown ref",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("journal recovery replaces only a lock whose recorded owner is proven dead", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.store.root, "write.lock"));
    await writeFile(
      join(f.store.root, "write.lock", "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        startedAt: "dead",
        repositoryId: f.store.repositoryId,
        token: "dead-owner",
      }),
    );
    await f.router.dispatch("ralph-pause", "run");
    expect((await f.store.getRun("run"))?.control?.status).toBe("paused");
  } finally {
    await f.cleanup();
  }
});

test("stop disposes a partially starting approved environment exactly once", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let disposals = 0;
  const environment = {
    revision: 1,
    prepare: async () => {
      await gate;
      return { url: "http://fixture.invalid", evidenceRefs: ["start"] };
    },
    dispose: async () => {
      disposals++;
      return { status: "completed" as const, evidenceRefs: ["cleanup"] };
    },
  };
  let preparing: Promise<unknown> | undefined;
  try {
    await f.store.recordOperation({
      operationId: "environment",
      kind: "review.environment",
      job: f.job,
      status: "intent",
    });
    preparing = prepareEnvironment(environment, f.job);
    await f.router.dispatch("ralph-stop", "run");
    expect(disposals).toBe(1);
    release?.();
    await preparing;
    await disposeEnvironment(environment, f.job);
    expect(disposals).toBe(1);
  } finally {
    release?.();
    await preparing;
    await f.cleanup();
  }
});

test("worktree creation interruptions reconcile actual ownership and retain revisions", async () => {
  const f = await fixture();
  try {
    const workspace = join(f.store.root, "recovered-worktree");
    const job = {
      ...f.job,
      workspace,
      inputRevisions: { ...f.job.inputRevisions, round: 3 },
    };
    await f.store.recordOperation({
      operationId: "workspace",
      kind: "review.workspace",
      job,
      status: "intent",
    });
    const before = await reconcileRun({
      store: f.store,
      directory: f.directory,
      runId: "run",
    });
    expect(before.status).toBe("blocked");
    expect(
      (await git("git", ["-C", f.directory, "worktree", "list", "--porcelain"]))
        .stdout,
    ).not.toContain(workspace);
    await git("git", [
      "-C",
      f.directory,
      "worktree",
      "add",
      "--detach",
      workspace,
      f.commit,
    ]);
    const reopened = await openRunStore(workspace);
    const after = await reconcileRun({
      store: reopened,
      directory: workspace,
      runId: "run",
    });
    expect(after.completedOperations).toEqual(["workspace"]);
    expect(after.status).toBe("interrupted");
    expect(
      (await reopened.getRun("run"))?.operations.workspace?.job.inputRevisions,
    ).toEqual({ prd: 2, graph: 3, round: 3 });
  } finally {
    await f.cleanup();
  }
});

test.each([
  "validation.check",
  "review.cleanup",
  "review.publish",
] as const)("uncertain %s is disclosed and never repeated", async (kind) => {
  const f = await fixture();
  try {
    await f.store.recordOperation({
      operationId: "pending",
      kind,
      job: { ...f.job, attempt: 3 },
      status: "intent",
    });
    const summary = await reconcileRun({
      store: f.store,
      directory: f.directory,
      runId: "run",
      adapter: f.adapter,
    });
    expect(summary.status).toBe("blocked");
    expect(f.fake.requests).toHaveLength(0);
    expect((await f.store.getRun("run"))?.operations.pending?.job.attempt).toBe(
      3,
    );
    await expect(f.router.dispatch("ralph-resume", "run")).rejects.toThrow(
      "blocked",
    );
  } finally {
    await f.cleanup();
  }
});

test("stop cannot erase recovery blockers or make an ambiguous run resumable", async () => {
  const f = await fixture();
  try {
    await f.store.recordControl("run", {
      status: "blocked",
      source: "recovery",
      facts: ["Candidate validation uncertain"],
    });
    await f.router.dispatch("ralph-stop", "run");
    await f.router.dispatch("ralph-stop", "run");
    await expect(f.router.dispatch("ralph-resume", "run")).rejects.toThrow(
      "reconciliation required",
    );
    expect((await f.store.getRun("run"))?.control?.facts).toContain(
      "Candidate validation uncertain",
    );
    const summary = await reconcileRun({
      store: f.store,
      directory: f.directory,
      runId: "run",
    });
    expect(summary.status).toBe("interrupted");
    await f.router.dispatch("ralph-resume", "run");
    expect((await f.store.getRun("run"))?.control?.status).toBe("active");
  } finally {
    await f.cleanup();
  }
});

test("resume waits for stop cleanup to settle", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cleaning = false;
  const stopping = handleControlCommand(
    "ralph-stop",
    "run",
    f.store,
    f.adapter,
    {
      cleanup: async () => {
        cleaning = true;
        await gate;
      },
    },
  );
  try {
    await waitFor(async () => cleaning);
    await expect(f.router.dispatch("ralph-resume", "run")).rejects.toThrow(
      "cleanup",
    );
    release?.();
    await stopping;
    await f.router.dispatch("ralph-resume", "run");
    expect((await f.store.getRun("run"))?.control?.status).toBe("active");
  } finally {
    release?.();
    await stopping.catch(() => {});
    await f.cleanup();
  }
});

test.each([
  "checkout synchronization",
  "checkout synchronization with local edits",
  "operation result",
  "attempt result",
])("production integration recovers after ref advance before %s without redispatch", async (boundary) => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  const recordOperation = f.store.recordOperation.bind(f.store);
  const recordAttempt = f.store.recordIssueAttempt.bind(f.store);
  let crashed = false;
  f.store.recordOperation = async (op) => {
    if (crashed) throw new Error("Simulated host termination");
    if (
      boundary === "operation result" &&
      op.kind === "integration.advance" &&
      op.status === "completed"
    ) {
      crashed = true;
      throw new Error("Simulated host termination");
    }
    const recorded = await recordOperation(op);
    if (
      boundary.startsWith("checkout synchronization") &&
      op.kind === "integration.advance" &&
      op.status === "intent"
    ) {
      await git("git", [
        "-C",
        f.project.directory,
        "update-ref",
        required(op.ref),
        required(op.expectedNew),
        required(op.expectedOld),
      ]);
      crashed = true;
      throw new Error("Simulated host termination");
    }
    return recorded;
  };
  f.store.recordIssueAttempt = async (id, revision, attempt) => {
    if (
      crashed ||
      (boundary === "attempt result" && attempt.status === "integrated")
    ) {
      crashed = true;
      throw new Error("Simulated host termination");
    }
    return recordAttempt(id, revision, attempt);
  };
  try {
    const router = createCommandRouter(f.store, f.adapter);
    await router.executeIssue(f.runId, "A").catch(() => {});
    expect(crashed).toBe(true);
    if (boundary.endsWith("local edits"))
      await writeFile(join(f.workspace, "README.md"), "Human edit retained\n");
    const reopened = await openRunStore(f.project.directory);
    const before = required(await reopened.getRun(f.runId));
    const approval = before.planning?.executionEligibility;
    const summary = await reconcileRun({
      store: reopened,
      directory: f.project.directory,
      runId: f.runId,
      adapter: f.adapter,
    });
    if (boundary.endsWith("local edits")) {
      const { readFile } = await import("node:fs/promises");
      expect(summary.status).toBe("blocked");
      expect(await readFile(join(f.workspace, "README.md"), "utf8")).toBe(
        "Human edit retained\n",
      );
      await expect(
        createCommandRouter(reopened, f.adapter).dispatch(
          "ralph-resume",
          f.runId,
        ),
      ).rejects.toThrow("blocked");
      return;
    }
    expect(summary.status).toBe("interrupted");
    const recovered = required(await reopened.getRun(f.runId));
    expect(recovered.issueAttempts?.A?.status).toBe("integrated");
    expect(recovered.issueAttempts?.A?.attempt).toBe(1);
    expect(
      (
        await git("git", ["-C", f.workspace, "status", "--porcelain"])
      ).stdout.trim(),
    ).toBe("");
    expect(recovered.planning?.executionEligibility).toEqual(approval);
    const count = f.fake.requests.length;
    const resumed = createCommandRouter(reopened, f.adapter);
    await expect(resumed.executeIssue(f.runId, "A")).rejects.toThrow(
      "interrupted",
    );
    await resumed.dispatch("ralph-resume", f.runId);
    expect((await resumed.executeIssue(f.runId, "A")).status).toBe(
      "integrated",
    );
    // Native resume continues to final-review evidence collection. It may read
    // the existing executor turn, but must not create or prompt another job.
    expect(f.fake.requests.slice(count).map((request) => request.path)).toEqual(
      [expect.stringMatching(/^\/api\/session\/[^/]+\/context$/)],
    );
    await reconcileRun({
      store: reopened,
      directory: f.project.directory,
      runId: f.runId,
    });
    const history = await reopened.events(f.runId);
    const advanceId = required(
      Object.keys(recovered.operations).find(
        (id) => recovered.operations[id]?.kind === "integration.advance",
      ),
    );
    expect(
      history.filter(
        (event, index) =>
          event.type === "operation.result" &&
          event.snapshot.operations[advanceId]?.status === "completed" &&
          history[index - 1]?.snapshot.operations[advanceId]?.status !==
            "completed",
      ),
    ).toHaveLength(1);
    expect(
      Object.values(required(await reopened.getRun(f.runId)).operations).filter(
        (op) => op.kind === "integration.advance" && op.status === "completed",
      ),
    ).toHaveLength(1);
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("restart renews an unanswered question identity and retains approval and active-time budget", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  const time = (await import("../helpers/clock.js")).controllableClock();
  f.adapter.requestUserInput = async () => ({
    ok: false,
    error: { code: "unsupported", message: "pending" },
  });
  f.adapter.dispatchJob = async (job) => {
    time.advance(5000);
    f.fake.respond(
      JSON.stringify({
        kind: "needs_input",
        question: "Which value?",
        recommendedAnswer: "one",
        affectedRequirement: "A value",
      }),
    );
    return createOpenCodeAdapter(f.fake.client, f.store).dispatchJob(job);
  };
  try {
    const router = createCommandRouter(f.store, f.adapter);
    await router.executeIssue(f.runId, "A", { clock: time.clock });
    const before = required(await f.store.getRun(f.runId));
    const old = required(before.issueAttempts?.A?.question);
    const reopened = await openRunStore(f.project.directory);
    expect(
      (
        await reconcileRun({
          store: reopened,
          directory: f.project.directory,
          runId: f.runId,
        })
      ).status,
    ).toBe("interrupted");
    const resumed = createCommandRouter(reopened, f.adapter);
    const response = {
      ok: true as const,
      ...old.request,
      source: "user" as const,
      messageId: "old-answer",
      text: "one",
    };
    expect(await resumed.answerExecutorQuestion(f.runId, "A", response)).toBe(
      false,
    );
    let republished: string | undefined;
    f.adapter.requestUserInput = async (request) => {
      republished = request.requestId;
      return { ok: false, error: { code: "unsupported", message: "pending" } };
    };
    await resumed.dispatch("ralph-resume", f.runId);
    await waitFor(async () => !!republished);
    const after = required(await reopened.getRun(f.runId));
    const renewed = required(after.issueAttempts?.A?.question);
    expect(after.planning?.executionEligibility).toEqual(
      before.planning?.executionEligibility,
    );
    expect(after.issueAttempts?.A?.remainingAgentMs).toBe(25000);
    expect(after.issueAttempts?.A?.attempt).toBe(1);
    expect(renewed.request.requestId).not.toBe(old.request.requestId);
    expect(republished).toBe(renewed.request.requestId);
    expect(await resumed.answerExecutorQuestion(f.runId, "A", response)).toBe(
      false,
    );
    expect(
      await resumed.answerExecutorQuestion(f.runId, "A", {
        ...response,
        ...renewed.request,
        messageId: "new-answer",
      }),
    ).toBe(true);
    const answered = await openRunStore(f.project.directory);
    await reconcileRun({
      store: answered,
      directory: f.project.directory,
      runId: f.runId,
    });
    await createCommandRouter(answered, f.adapter).dispatch(
      "ralph-resume",
      f.runId,
    );
    const answeredAttempt = (await answered.getRun(f.runId))?.issueAttempts?.A;
    expect(
      [
        ...(answeredAttempt?.questions ?? []),
        ...(answeredAttempt?.question ? [answeredAttempt.question] : []),
      ].find((q) => q.request.requestId === renewed.request.requestId)?.answer
        ?.messageId,
    ).toBe("new-answer");
    expect(
      await resumed.answerExecutorQuestion(f.runId, "A", {
        ...response,
        ...renewed.request,
        messageId: "duplicate",
      }),
    ).toBe(false);
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("pause lets a production executor save its submission without scheduling a merger", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  const router = createCommandRouter(f.store, f.adapter);
  let active: ReturnType<typeof router.executeIssue> | undefined;
  try {
    f.fake.hold();
    active = router.executeIssue(f.runId, "A");
    await waitFor(async () =>
      Object.values(required(await f.store.getRun(f.runId)).jobs).some(
        (j) => j.status === "running",
      ),
    );
    await router.dispatch("ralph-pause", f.runId);
    f.fake.release();
    expect((await active).status).toBe("submitted");
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.status).toBe(
      "submitted",
    );
    expect(
      Object.values(required(await f.store.getRun(f.runId)).jobs).filter(
        (j) => j.envelope.role === "merger",
      ),
    ).toHaveLength(0);
    await router.dispatch("ralph-resume", f.runId);
    expect((await router.executeIssue(f.runId, "A")).status).toBe("integrated");
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.attempt).toBe(1);
  } finally {
    f.fake.release();
    await active?.catch(() => {});
    await f.project.cleanup();
  }
}, 90000);

test.each([
  "baseline.workspace",
  "issue.workspace",
  "candidate.workspace",
] as const)("recovery observes completed %s creation without recreating it", async (kind) => {
  const f = await fixture();
  try {
    const workspace = join(f.store.root, "owned-worktree");
    const ref = "refs/heads/ralph/recovered";
    await f.store.recordOperation({
      operationId: "created",
      kind,
      status: "intent",
      job: { ...f.job, workspace },
      ref,
      expectedNew: f.commit,
    });
    await git("git", [
      "-C",
      f.directory,
      "worktree",
      "add",
      "-b",
      ref.slice(11),
      workspace,
      f.commit,
    ]);
    const summary = await reconcileRun({
      store: f.store,
      directory: f.directory,
      runId: "run",
    });
    expect(summary.status).toBe("interrupted");
    expect(summary.completedOperations).toEqual(["created"]);
    expect((await f.store.getRun("run"))?.operations.created?.status).toBe(
      "completed",
    );
    expect(
      (
        await reconcileRun({
          store: f.store,
          directory: f.directory,
          runId: "run",
        })
      ).completedOperations,
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("an executor result missing its attempt append blocks recovery instead of silently stranding work", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  const record = f.store.recordIssueAttempt.bind(f.store);
  f.store.recordIssueAttempt = async (id, revision, attempt) => {
    if (attempt.executionResult)
      throw new Error("Simulated append interruption");
    return record(id, revision, attempt);
  };
  try {
    await createCommandRouter(f.store, f.adapter)
      .executeIssue(f.runId, "A")
      .catch(() => {});
    const reopened = await openRunStore(f.project.directory);
    expect((await reopened.getRun(f.runId))?.issueAttempts?.A?.status).toBe(
      "executing",
    );
    const summary = await reconcileRun({
      store: reopened,
      directory: f.project.directory,
      runId: f.runId,
    });
    expect(summary.status).toBe("blocked");
    expect(
      summary.facts.some(
        (fact) => fact.includes("A/1") && fact.includes("executing"),
      ),
    ).toBe(true);
    await expect(
      createCommandRouter(reopened, f.adapter).dispatch(
        "ralph-resume",
        f.runId,
      ),
    ).rejects.toThrow("blocked");
    expect(
      required(await reopened.getRun(f.runId)).issueAttempts?.A?.attempt,
    ).toBe(1);
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("pause settles the active merger and defers candidate checks until resume", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  const router = createCommandRouter(f.store, f.adapter);
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  f.adapter.dispatchJob = async (job) => {
    if (job.role === "merger") f.fake.hold();
    return dispatch(job);
  };
  let active: ReturnType<typeof router.executeIssue> | undefined;
  try {
    active = router.executeIssue(f.runId, "A");
    await waitFor(async () =>
      Object.values(required(await f.store.getRun(f.runId)).jobs).some(
        (j) => j.status === "running" && j.envelope.role === "merger",
      ),
    );
    await router.dispatch("ralph-pause", f.runId);
    f.fake.release();
    await waitFor(
      async () =>
        !!(await f.store.getRun(f.runId))?.issueAttempts?.A?.candidate?.result,
    );
    await Bun.sleep(150);
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.status).toBe(
      "merging",
    );
    expect(
      (await f.store.getRun(f.runId))?.issueAttempts?.A?.validation,
    ).toBeUndefined();
    await router.dispatch("ralph-resume", f.runId);
    expect((await active).status).toBe("integrated");
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.attempt).toBe(1);
  } finally {
    f.fake.release();
    await router.dispatch("ralph-resume", f.runId).catch(() => {});
    await active?.catch(() => {});
    await f.project.cleanup();
  }
}, 90000);

test("recovery retains and reports a matching active-run lock, blocking foreign ownership", async () => {
  const f = await fixture();
  const lock = join(f.store.root, "active-run.lock");
  try {
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        runId: "other-run",
        repositoryId: f.store.repositoryId,
      }),
    );
    expect(
      (
        await reconcileRun({
          store: f.store,
          directory: f.directory,
          runId: "run",
        })
      ).status,
    ).toBe("blocked");
    const { readFile } = await import("node:fs/promises");
    expect(
      JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).runId,
    ).toBe("other-run");
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ runId: "run", repositoryId: f.store.repositoryId }),
    );
    const summary = await reconcileRun({
      store: f.store,
      directory: f.directory,
      runId: "run",
    });
    expect(summary.status).toBe("interrupted");
    expect(
      summary.facts.some(
        (fact) => fact.includes("active-run lock") && fact.includes("retained"),
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("restart blocks when an already recorded integration ref no longer matches", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  try {
    await createCommandRouter(f.store, f.adapter).executeIssue(f.runId, "A");
    const run = required(await f.store.getRun(f.runId));
    const advance = required(
      Object.values(run.operations).find(
        (op) => op.kind === "integration.advance",
      ),
    );
    await git("git", [
      "-C",
      f.project.directory,
      "update-ref",
      required(advance.ref),
      required(advance.expectedOld),
      required(advance.expectedNew),
    ]);
    const summary = await reconcileRun({
      store: f.store,
      directory: f.project.directory,
      runId: f.runId,
    });
    expect(summary.status).toBe("blocked");
    expect(
      summary.facts.some((fact) => fact.includes("Accepted integration ref")),
    ).toBe(true);
    await expect(
      createCommandRouter(f.store, f.adapter).dispatch("ralph-resume", f.runId),
    ).rejects.toThrow("blocked");
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.attempt).toBe(1);
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test.each([
  false,
  true,
])("pause retains a successful in-flight candidate check and waits before advancing the ref (another check: %s)", async (anotherCheck) => {
  const { mkdtemp, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const signal = await mkdtemp(join(tmpdir(), "ralph-pause-check-"));
  const started = join(signal, "started"),
    release = join(signal, "release");
  const f = await singleIssueFixture({
    commands: [
      {
        id: "held-check",
        phase: "check",
        executable: process.execPath,
        args: [
          "-e",
          `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, ''); while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`,
        ],
        cwd: ".",
        timeoutMs: 15000,
        platforms: ["darwin", "linux", "win32"],
        env: {},
      },
      ...(anotherCheck
        ? [
            {
              id: "next-check",
              phase: "check" as const,
              executable: process.execPath,
              args: ["-e", "process.exit(0)"],
              cwd: ".",
              timeoutMs: 5000,
              platforms: ["darwin", "linux", "win32"] as (
                | "darwin"
                | "linux"
                | "win32"
              )[],
              env: {},
            },
          ]
        : []),
    ],
  });
  const router = createCommandRouter(f.store, f.adapter);
  let active: ReturnType<typeof router.executeIssue> | undefined;
  try {
    active = router.executeIssue(f.runId, "A");
    await waitFor(async () =>
      access(started).then(
        () => true,
        () => false,
      ),
    );
    await router.dispatch("ralph-pause", f.runId);
    await writeFile(release, "");
    if (anotherCheck) {
      await waitFor(async () =>
        Object.values(required(await f.store.getRun(f.runId)).operations).some(
          (op) =>
            op.kind === "process.spawn" &&
            op.job.role === "merger" &&
            op.status === "completed",
        ),
      );
      await Bun.sleep(100);
      expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.status).toBe(
        "merging",
      );
      expect(
        (await f.store.getRun(f.runId))?.issueAttempts?.A?.validation,
      ).toBeUndefined();
    } else {
      await waitFor(
        async () =>
          !!(await f.store.getRun(f.runId))?.issueAttempts?.A?.validation,
      );
      expect(
        (await f.store.getRun(f.runId))?.issueAttempts?.A?.validation?.status,
      ).toBe("passed");
    }
    expect(
      Object.values(required(await f.store.getRun(f.runId)).operations).some(
        (op) => op.kind === "integration.advance",
      ),
    ).toBe(false);
    await router.dispatch("ralph-resume", f.runId);
    expect((await active).status).toBe("integrated");
    expect(
      (await f.store.getRun(f.runId))?.issueAttempts?.A?.validation?.checks,
    ).toHaveLength(anotherCheck ? 2 : 1);
  } finally {
    await writeFile(release, "");
    await router.dispatch("ralph-resume", f.runId).catch(() => {});
    await active?.catch(() => {});
    await f.project.cleanup();
    await rm(signal, { recursive: true, force: true });
  }
}, 90000);

test("restart during repair dispatch retains the round and attempt and rejects the late callback", async () => {
  const f = await fixture();
  const { required } = await import("../helpers/single-issue.js");
  const { gate } = await import("../helpers/diamond.js");
  const held = gate();
  let dispatches = 0;
  let active: Promise<unknown> | undefined;
  try {
    const graph = {
      revision: "g1",
      issues: [{ id: "a", acceptanceCriteria: ["Works"] }],
    };
    await writeFile(join(f.directory, "PRD.md"), "# Acceptance\n- [ ] Works\n");
    await writeFile(join(f.directory, "graph.json"), JSON.stringify(graph));
    await git("git", ["-C", f.directory, "add", "."]);
    await git("git", ["-C", f.directory, "commit", "-m", "requirements"]);
    const commit = (
      await git("git", ["-C", f.directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    await f.store.recordExecution(
      "run",
      required(await f.store.getRun("run")).revision,
      {
        verification: "passed",
        issues: [
          {
            id: "a",
            title: "Works",
            dependencies: [],
            status: "integrated",
            blockers: [],
          },
        ],
        integrationQueue: [],
        checks: [
          {
            id: "tests",
            status: "passed",
            attempt: 1,
            candidateCommit: commit,
            commandRevision: 1,
          },
        ],
      },
    );
    active = f.router.reviewFeature({
      directory: f.directory,
      runId: "run",
      commit,
      baseCommit: f.commit,
      graph,
      prdRevision: "p1",
      evidenceRefs: ["test"],
      reviewers: {
        code: async (s) => ({
          role: "code-review",
          reviewedCommit: s.commit,
          round: s.round,
          outcome: "findings",
          findings: [
            {
              id: "defect",
              criterion: "Works",
              suggestedRepair: "Fix Works",
              category: "correctness",
              blocking: true,
              disposition: "open",
              reviewerRole: "code-review",
              reviewedCommit: s.commit,
              evidence: ["test"],
            },
          ],
          evidenceRefs: ["test"],
        }),
        functional: async (s) => ({
          role: "functional-review",
          reviewedCommit: s.commit,
          round: s.round,
          outcome: "passed",
          findings: [],
          evidenceRefs: ["test"],
          evidence: [],
          criteria: [],
          attempts: [],
        }),
      },
      repairs: {
        executeIssue: async () => {
          dispatches++;
          await held.promise;
          return {
            outcome: "failed",
            error: { code: "sdk-error", message: "interrupted fixture" },
            evidenceRefs: ["failure"],
          };
        },
        integrateIssue: async () => {
          throw new Error("No candidate");
        },
      },
    });
    // Capture rejection immediately: the original host callback must lose its epoch.
    const outcome = active.catch((cause) => cause);
    await waitFor(async () => dispatches === 1);
    const reopened = await openRunStore(f.directory);
    const before = required(await reopened.getRun("run")).reviewWorkflow;
    const summary = await reconcileRun({
      store: reopened,
      directory: f.directory,
      runId: "run",
    });
    expect(summary.status).toBe("blocked");
    expect(
      summary.facts.some((fact) =>
        fact.includes("repair completion uncertain"),
      ),
    ).toBe(true);
    await expect(
      createCommandRouter(reopened, f.adapter).dispatch("ralph-resume", "run"),
    ).rejects.toThrow("blocked");
    held.release();
    await outcome;
    expect((await reopened.getRun("run"))?.reviewWorkflow).toEqual(before);
    expect(dispatches).toBe(1);
    expect(before?.rounds).toHaveLength(1);
    expect(before?.rounds[0]?.repairs[0]?.attempts).toHaveLength(1);
  } finally {
    held.release();
    await active?.catch(() => {});
    await f.cleanup();
  }
}, 90000);

test("stop followed by immediate resume cannot revive a merger waiting at a pause boundary", async () => {
  const { singleIssueFixture, required } = await import(
    "../helpers/single-issue.js"
  );
  const { gate } = await import("../helpers/diamond.js");
  const f = await singleIssueFixture();
  f.adapter.finalizeExecution = async () => {};
  const held = gate();
  const read = f.store.getRun.bind(f.store);
  const save = f.store.recordIssueAttempt.bind(f.store);
  let reads = 0,
    intercept = false,
    waiting = false;
  f.store.recordIssueAttempt = async (id, revision, attempt) => {
    const saved = await save(id, revision, attempt);
    if (saved && attempt.validation?.status === "passed" && !intercept) {
      await handleControlCommand("ralph-pause", id, f.store, f.adapter);
      intercept = true;
    }
    return saved;
  };
  f.store.getRun = async (id) => {
    if (intercept && ++reads === 2) {
      waiting = true;
      await held.promise;
    }
    return read(id);
  };
  const router = createCommandRouter(f.store, f.adapter);
  const active = router.executeIssue(f.runId, "A");
  try {
    await waitFor(async () => waiting);
    await router.dispatch("ralph-stop", f.runId);
    await expect(router.dispatch("ralph-resume", f.runId)).rejects.toThrow(
      "blocked",
    );
    held.release();
    await active.catch(() => {});
    const run = required(await read(f.runId));
    expect(
      Object.values(run.operations).filter(
        (op) => op.kind === "integration.advance",
      ),
    ).toHaveLength(0);
    expect(
      (
        await git("git", ["-C", f.workspace, "rev-parse", "HEAD"])
      ).stdout.trim(),
    ).toBe(f.project.commit);
    expect(run.issueAttempts?.A?.attempt).toBe(1);
  } finally {
    held.release();
    await active.catch(() => {});
    await f.project.cleanup();
  }
}, 90000);

test("recovery consumes a cancelled executor only with matching abort and idle session evidence", async () => {
  const f = await fixture();
  try {
    let run = await f.store.getRun("run");
    const attempt = {
      issueId: "A",
      attempt: 1,
      status: "executing" as const,
      operationId: "issue",
      job: f.job,
    };
    expect(
      await f.store.recordIssueAttempt("run", run?.revision ?? -1, attempt),
    ).toBe(true);
    await f.store.recordIntent(f.job);
    await f.store.attachSession(f.job, "session-bound");
    const bound = (await f.store.getRun("run"))?.jobs.issue?.envelope;
    if (!bound) throw new Error("Missing bound job");
    await f.adapter.cancelJob(bound);
    const busy = { ...f.adapter, inspectSession: async () => "busy" as const };
    expect(
      (
        await reconcileRun({
          store: f.store,
          directory: f.directory,
          runId: "run",
          adapter: busy,
        })
      ).status,
    ).toBe("blocked");
    expect((await f.store.getRun("run"))?.issueAttempts?.A?.status).toBe(
      "executing",
    );
    expect(
      (
        await reconcileRun({
          store: f.store,
          directory: f.directory,
          runId: "run",
          adapter: f.adapter,
        })
      ).status,
    ).toBe("interrupted");
    run = await f.store.getRun("run");
    expect(run?.issueAttempts?.A?.status).toBe("failed");
    expect(run?.issueAttempts?.A?.attempt).toBe(1);
    expect(run?.issueAttempts?.A?.executionResult?.outcome).toBe("cancelled");
    expect(
      f.fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

async function nativeRecoveryFixture() {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  const fake = createFakeOpenCode();
  const adapter = createOpenCodeAdapter(fake.client, store);
  adapter.getSessionModel = async () => ({
    providerID: "fixture",
    modelID: "default",
  });
  adapter.authorizeCommand = async () => ({ ok: true });
  adapter.requestUserInput = async (request) => ({
    ok: true,
    ...request,
    source: "user",
    messageId: request.requestId,
    text: `approve ${request.question.match(/hash ([a-f0-9]+)/)?.[1]}`,
  });
  fake.respond(
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      rationale: "Fixture",
      commands: [
        {
          id: "check",
          phase: "check",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: ".",
          timeoutMs: 2000,
          platforms: ["darwin", "linux", "win32"],
          env: {},
        },
      ],
    }),
  );
  await createCommandRouter(store, adapter).setupProject({
    workspace: project.directory,
    sessionId: "main",
  });
  await git("git", ["-C", project.directory, "add", ".ralph"]);
  await git("git", ["-C", project.directory, "commit", "-m", "setup"]);
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  adapter.requestUserInput = async () => ({
    ok: false,
    error: { code: "unsupported", message: "waiting" },
  });
  adapter.discoverTools = async () => ["question", "read"];
  const options = {
    workspace: project.directory,
    sessionId: "main",
    store,
    adapter,
  };
  const run = await startNativeFeature(options);
  if (!run?.planning) throw new Error("Missing native run");
  return { project, store, fake, adapter, options, run, startNativeFeature };
}

test("native existing discovery asks restart choice, settles old owner and opens a fresh first question", async () => {
  const f = await nativeRecoveryFixture();
  try {
    await f.store.recordControl(f.run.runId, {
      status: "interrupted",
      source: "recovery",
    });
    const requests: import("../../src/core/types.js").UserInputRequest[] = [];
    f.adapter.requestUserInput = async (request) => {
      requests.push(request);
      return request.kind === "existing-run"
        ? {
            ok: true,
            ...request,
            source: "user",
            messageId: "restart-choice",
            text: "Restart discovery",
          }
        : { ok: false, error: { code: "unsupported", message: "waiting" } };
    };
    const fresh = await f.startNativeFeature(f.options);
    expect(requests[0]?.question).toContain("fresh session");
    expect(requests[0]?.options?.map((o) => o.label)).toEqual([
      "Restart discovery",
      "Keep saved run",
    ]);
    expect(requests[1]?.kind).toBe("feature");
    expect(fresh?.runId).not.toBe(f.run.runId);
    expect(fresh?.planning?.sessionId).not.toBe(f.run.planning?.sessionId);
    expect(fresh?.planning?.transcript).toEqual([]);
    expect((await f.store.getRun(f.run.runId))?.control?.status).toBe(
      "stopped",
    );
    expect(await f.store.listRuns()).toHaveLength(3); // command verification plus both feature histories
    const owner = JSON.parse(
      await Bun.file(join(f.store.root, "active-run.lock/owner.json")).text(),
    );
    expect(owner.runId).toBe(fresh?.runId);
    const { handleInterviewResponse } = await import(
      "../../src/planning/interview.js"
    );
    expect(
      await handleInterviewResponse(f.store, f.run.runId, {
        ok: true,
        ...required(required(f.run.planning).pending),
        source: "user",
        messageId: "late",
        text: "old feature",
      }),
    ).toBe(false);
  } finally {
    await f.project.cleanup();
  }
});

test("native restart retains ownership and history when stage cleanup is uncertain", async () => {
  const f = await nativeRecoveryFixture();
  try {
    f.adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "restart",
      text: "Restart discovery",
    });
    f.adapter.inspectSession = async () => "busy";
    const before = await Bun.file(
      join(f.store.root, "active-run.lock/owner.json"),
    ).text();
    await expect(f.startNativeFeature(f.options)).rejects.toThrow("cleanup");
    expect(
      await Bun.file(join(f.store.root, "active-run.lock/owner.json")).text(),
    ).toBe(before);
    expect(
      (await f.store.getRun(f.run.runId))?.control?.facts?.length,
    ).toBeGreaterThan(0);
    expect(await f.store.listRuns()).toHaveLength(2);
  } finally {
    await f.project.cleanup();
  }
});

async function acceptRecoveryPrd(
  f: Awaited<ReturnType<typeof nativeRecoveryFixture>>,
) {
  const { completeInterview, completePrd } = await import(
    "../../src/planning/completion.js"
  );
  const { writePlanningFile } = await import(
    "../../src/planning/artifact-writer.js"
  );
  f.adapter.requestUserInput = async (request) => ({
    ok: true,
    ...request,
    source: "user",
    messageId: request.requestId,
    text: required(request.options?.[0]).label,
  });
  const sessionId = required(f.run.planning).sessionId;
  const { handleInterviewResponse } = await import(
    "../../src/planning/interview.js"
  );
  await handleInterviewResponse(f.store, f.run.runId, {
    ok: true,
    ...required(required(f.run.planning).pending),
    source: "user",
    messageId: "feature-answer",
    text: "Build feature",
  });
  await completeInterview(
    f.store,
    f.adapter,
    {
      runId: f.run.runId,
      attempt: 1,
      text: "Build feature",
      scope: ["Feature"],
      criteria: ["Feature works"],
    },
    sessionId,
  );
  const state = required(required(await f.store.getRun(f.run.runId)).planning);
  const text =
    [
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
    ]
      .map((h, i) => `## ${i + 1}. ${h}\nConcrete feature requirements.`)
      .join("\n") +
    `\nApproved explanation: revision ${required(state.explanation).revision}, hash ${required(state.explanation).hash}\n`;
  await writePlanningFile(
    f.store,
    { runId: f.run.runId, attempt: 1, path: "PRD.md", content: text },
    sessionId,
  );
  return () =>
    completePrd(
      f.store,
      f.adapter,
      { runId: f.run.runId, attempt: 1, path: "PRD.md" },
      sessionId,
    );
}

for (const boundary of [
  "acceptance",
  "creation",
  "attachment",
  "prompt",
  "focus",
] as const) {
  test(`native explicit recovery reconciles ${boundary} with one planner and unchanged accepted inputs`, async () => {
    const f = await nativeRecoveryFixture();
    try {
      const complete = await acceptRecoveryPrd(f);
      if (boundary === "creation") f.fake.loseCreationReceipt();
      if (boundary === "prompt") f.fake.losePromptReceipt();
      const save = f.store.recordPlanning.bind(f.store);
      let lost = false;
      f.store.recordPlanning = async (id, rev, state) => {
        const crash =
          boundary === "acceptance"
            ? !!state.prd && !state.issueHandoff
            : boundary === "attachment"
              ? !!state.issueHandoff?.sessionId &&
                state.owner?.stage !== "issues"
              : boundary === "focus"
                ? !!state.issueHandoff?.focused
                : false;
        if (!lost && crash) {
          lost = true;
          throw new Error("Crash boundary");
        }
        return save(id, rev, state);
      };
      try {
        await complete();
      } catch (error) {
        expect(String(error)).toContain("Crash boundary");
      }
      f.store.recordPlanning = save;
      const before = required(
        required(await f.store.getRun(f.run.runId)).planning,
      );
      await reconcileRun({
        store: f.store,
        adapter: f.adapter,
        directory: f.project.directory,
        runId: f.run.runId,
      });
      f.adapter.requestUserInput = async (request) => {
        expect(request.options?.[0]?.label).toBe("Resume saved stage");
        return {
          ok: true,
          ...request,
          source: "user",
          messageId: request.requestId,
          text: "Resume saved stage",
        };
      };
      await f.startNativeFeature(f.options);
      const after = required(await f.store.getRun(f.run.runId));
      expect(after.control?.status).toBe("active");
      expect(after.planning?.prdAcceptance).toEqual(before.prdAcceptance);
      expect(after.planning?.approval).toEqual(before.approval);
      expect(after.planning?.issueHandoff?.queued).toBe(true);
      expect(after.planning?.issueHandoff?.focused).toBe(true);
      expect(
        f.fake.requests.filter(
          (r) =>
            r.path === "/api/session" &&
            (
              r.body.metadata as { ralph?: { jobId?: string } }
            )?.ralph?.jobId?.startsWith("issues-prd-"),
        ),
      ).toHaveLength(1);
      expect(
        after.planning?.attempts?.filter((a) => a.stage === "issues"),
      ).toHaveLength(1);
      for (const attempt of before.attempts ?? [])
        expect(
          after.planning?.attempts?.find(
            (a) => a.job.jobId === attempt.job.jobId,
          )?.remainingMs,
        ).toBe(attempt.remainingMs);
    } finally {
      await f.project.cleanup();
    }
  });
}

test("native ambiguous planning receipts block resume without duplicate effects", async () => {
  const f = await nativeRecoveryFixture();
  try {
    await (await acceptRecoveryPrd(f))();
    f.adapter.inspectStagePrompt = async () => "unknown";
    const count = f.fake.requests.length;
    const summary = await reconcileRun({
      store: f.store,
      adapter: f.adapter,
      directory: f.project.directory,
      runId: f.run.runId,
    });
    expect(summary.status).toBe("blocked");
    const { resumeWorkflow } = await import("../../src/commands/resume.js");
    await expect(
      resumeWorkflow(f.store, f.adapter, f.run.runId),
    ).rejects.toThrow("Recovery blocked");
    expect(f.fake.requests.length).toBe(count);
  } finally {
    await f.project.cleanup();
  }
});

for (const boundary of ["acceptance", "eligibility", "result"] as const) {
  test(`native recovery after issue ${boundary} starts baseline once from exact accepted graph`, async () => {
    const f = await nativeRecoveryFixture();
    try {
      await (await acceptRecoveryPrd(f))();
      const { writePlanningFile } = await import(
        "../../src/planning/artifact-writer.js"
      );
      const { completeIssues } = await import(
        "../../src/planning/completion.js"
      );
      const state = (await f.store.getRun(f.run.runId))?.planning;
      if (!state?.prd) throw new Error("Missing PRD");
      const graph = {
        schemaVersion: 1,
        prdRevision: state.prd,
        issues: [
          {
            id: "A",
            title: "Feature",
            artifactPath: "issues/1-feature.md",
            dependencies: [],
            acceptanceCriteria: ["Feature works"],
            testableBehaviors: ["Feature works"],
          },
        ],
      };
      const issue =
        "# Feature\n## What to build\nFeature\n## Context: files to read before implementing\nREADME.md\n## Patterns to follow\nExisting tests\n## Step-by-step tasks\nAdd behavior and tests\n## Acceptance criteria\nFeature works\n## Validation commands\nApproved checks\n## Blocked by\nNone";
      for (const [path, content] of [
        ["issues/1-feature.md", issue],
        ["graph.json", JSON.stringify(graph)],
      ])
        await writePlanningFile(
          f.store,
          {
            runId: f.run.runId,
            attempt: 1,
            path: path as string,
            content: content as string,
          },
          state.sessionId,
        );
      const save = f.store.recordPlanning.bind(f.store);
      let lost = false;
      f.store.recordPlanning = async (id, rev, next) => {
        const crash =
          boundary === "acceptance"
            ? !!next.issueAcceptance && !next.graph
            : boundary === "eligibility"
              ? !!next.executionEligibility && !next.issueAcceptance?.result
              : !!next.issueAcceptance?.result;
        const result = await save(id, rev, next);
        if (crash && !lost) {
          lost = true;
          throw new Error("Lost issue acceptance receipt");
        }
        return result;
      };
      try {
        await completeIssues(
          f.store,
          f.adapter,
          { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
          state.sessionId,
        );
      } catch (error) {
        expect(String(error)).toContain("Lost issue acceptance");
      }
      f.store.recordPlanning = save;
      const before = (await f.store.getRun(f.run.runId))?.planning;
      expect(before?.issueAcceptance).toBeDefined();
      // Denial must remain a baseline blocker, never invented execution evidence.
      f.adapter.authorizeCommand = async () => ({
        ok: false,
        error: {
          code: "permission-denied",
          message: "Fixture denies baseline",
        },
      });
      await reconcileRun({
        store: f.store,
        adapter: f.adapter,
        directory: f.project.directory,
        runId: f.run.runId,
      });
      const { resumeWorkflow } = await import("../../src/commands/resume.js");
      await resumeWorkflow(f.store, f.adapter, f.run.runId);
      const after = await f.store.getRun(f.run.runId);
      expect(after?.planning?.graph).toEqual(before?.issueAcceptance?.graph);
      expect(after?.planning?.approval).toEqual(before?.approval);
      expect(after?.baseline?.status).toBe("failed");
      expect(after?.planning?.executionEligibility?.requestId).toBe(
        before?.approval?.requestId,
      );
      expect(
        Object.values(after?.operations ?? {}).filter(
          (op) => op.kind === "baseline.workspace",
        ),
      ).toHaveLength(1);
      const events = (await f.store.events(f.run.runId)).length;
      await completeIssues(
        f.store,
        f.adapter,
        { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
        state.sessionId,
      );
      expect((await f.store.events(f.run.runId)).length).toBe(events);
    } finally {
      await f.project.cleanup();
    }
  });
}

test("native accepted recovery blocks changed immutable PRD before reactivating control", async () => {
  const f = await nativeRecoveryFixture();
  try {
    await (await acceptRecoveryPrd(f))();
    const state = (await f.store.getRun(f.run.runId))?.planning;
    if (!state?.prd) throw new Error("Missing PRD");
    await writeFile(
      join(f.project.directory, state.prd.artifactPath),
      "changed accepted PRD",
    );
    await f.store.recordControl(f.run.runId, {
      status: "interrupted",
      source: "recovery",
    });
    const { resumeWorkflow } = await import("../../src/commands/resume.js");
    await expect(
      resumeWorkflow(f.store, f.adapter, f.run.runId),
    ).rejects.toThrow("Accepted PRD bytes changed");
    expect((await f.store.getRun(f.run.runId))?.control?.status).toBe(
      "blocked",
    );
  } finally {
    await f.project.cleanup();
  }
});

test("native stopped release rejects a foreign lock and does not revive a released run", async () => {
  const f = await nativeRecoveryFixture();
  try {
    const { releaseStoppedPlanningRun } = await import(
      "../../src/state/active-run.js"
    );
    await handleControlCommand("ralph-stop", f.run.runId, f.store, f.adapter);
    const path = join(f.store.root, "active-run.lock/owner.json");
    const raw = await Bun.file(path).text();
    await writeFile(
      path,
      JSON.stringify({ runId: "foreign", repositoryId: f.store.repositoryId }),
    );
    await expect(
      releaseStoppedPlanningRun(f.store, f.run.runId),
    ).rejects.toThrow("ownership differs");
    expect(JSON.parse(await Bun.file(path).text()).runId).toBe("foreign");
    await writeFile(path, raw);
    await releaseStoppedPlanningRun(f.store, f.run.runId);
    await expect(
      handleControlCommand("ralph-resume", f.run.runId, f.store, f.adapter),
    ).rejects.toThrow("released");
    expect((await f.store.getRun(f.run.runId))?.control?.status).toBe(
      "stopped",
    );
  } finally {
    await f.project.cleanup();
  }
});

test("native unfinished PRD restarts discovery without reusing authorization or partial drafts", async () => {
  const f = await nativeRecoveryFixture();
  try {
    const complete = await acceptRecoveryPrd(f);
    const old = required(required(await f.store.getRun(f.run.runId)).planning);
    const draft = join(
      f.project.directory,
      `.ralph/features/${f.run.runId}/prd-draft-1/PRD.md`,
    );
    const bytes = await Bun.file(draft).text();
    expect(
      (
        await reconcileRun({
          store: f.store,
          adapter: f.adapter,
          directory: f.project.directory,
          runId: f.run.runId,
        })
      ).status,
    ).toBe("interrupted");
    f.adapter.requestUserInput = async (request) =>
      request.kind === "existing-run"
        ? {
            ok: true,
            ...request,
            source: "user",
            messageId: request.requestId,
            text: "Restart discovery",
          }
        : { ok: false, error: { code: "unsupported", message: "waiting" } };
    const fresh = await f.startNativeFeature(f.options);
    expect(fresh?.planning?.pending?.kind).toBe("feature");
    expect(fresh?.planning?.approval).toBeUndefined();
    expect(fresh?.planning?.transcript).toEqual([]);
    expect(await Bun.file(draft).text()).toBe(bytes);
    expect((await f.store.getRun(f.run.runId))?.planning?.approval).toEqual(
      old.approval,
    );
    await expect(complete()).rejects.toThrow("inactive");
  } finally {
    await f.project.cleanup();
  }
});
