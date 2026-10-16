import { beforeAll, expect, test } from "bun:test";
import { startDashboard } from "../../src/dashboard/server.js";
import { explanationHash } from "../../src/planning/artifacts.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createTestProject } from "../helpers/project.js";
import { required } from "../helpers/single-issue.js";

beforeAll(async () => {
  const build = Bun.spawn([process.execPath, "run", "build:dashboard"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0)
    throw new Error(
      `Dashboard fixture build failed: ${await new Response(build.stderr).text()}`,
    );
});

test("dashboard authenticates reads, rejects cross-origin and mutation requests, and exposes persisted state", async () => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  await store.createRun("r");
  const dashboard = await startDashboard(store);
  try {
    const headers = {
      Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}`,
    };
    const base = new URL(dashboard.url).origin;
    expect((await fetch(`${base}/api/runs`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/runs`, {
          headers: { ...headers, Origin: "https://evil.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/runs/r`, { method: "POST", headers })).status,
    ).toBe(405);
    expect((await fetch(`${base}/api/runs/unknown`, { headers })).status).toBe(
      404,
    );
    const snapshot = await (
      await fetch(`${base}/api/runs/r`, { headers })
    ).json();
    expect(snapshot).toMatchObject({
      runId: "r",
      phase: "ready",
      verification: "unavailable",
    });
    expect(
      await (await fetch(`${base}/api/runs/r/issues`, { headers })).json(),
    ).toEqual([]);
    expect((await fetch(base)).status).toBe(200);
    expect(await (await fetch(base)).text()).not.toContain(
      new URL(dashboard.url).hash.slice(1),
    );
  } finally {
    await dashboard.stop();
    await project.cleanup();
  }
});

test("execution evidence stays distinct from successful agent output and is replayed in sequence", async () => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  await store.createRun("diamond");
  const dashboard = await startDashboard(store, { pollIntervalMs: 20 });
  const base = new URL(dashboard.url).origin;
  const headers = {
    Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}`,
  };
  try {
    const revision = (await store.getRun("diamond"))?.revision ?? 0;
    const execution = {
      issues: [
        {
          id: "A",
          title: "A",
          dependencies: [],
          status: "integrated" as const,
          blockers: [],
        },
        {
          id: "B",
          title: "B",
          dependencies: ["A"],
          status: "running" as const,
          blockers: [],
        },
        {
          id: "C",
          title: "C",
          dependencies: ["A"],
          status: "running" as const,
          blockers: [],
        },
        {
          id: "D",
          title: "D",
          dependencies: ["B", "C"],
          status: "blocked" as const,
          blockers: ["B", "C"],
        },
      ],
      integrationQueue: ["B"],
      checks: [
        {
          id: "tests",
          status: "skipped" as const,
          reason: "timeout",
          attempt: 1,
          candidateCommit: project.commit,
          commandRevision: 1,
        },
      ],
    };
    expect(await store.recordExecution("diamond", revision, execution)).toBe(
      true,
    );
    expect(
      await store.recordExecution("diamond", revision, {
        ...execution,
        checks: [],
      }),
    ).toBe(false);
    const snapshot = await (
      await fetch(`${base}/api/runs/diamond`, { headers })
    ).json();
    expect(snapshot.verification).toBe("incomplete");
    expect(snapshot.issues[3]).toMatchObject({
      status: "blocked",
      blockers: ["B", "C"],
    });
    expect(snapshot.checks[0].status).toBe("skipped");
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/runs/diamond/events?after=1`, {
      headers,
      signal: controller.signal,
    });
    const reader = stream.body?.getReader();
    const replay = new TextDecoder().decode((await reader?.read())?.value);
    expect(replay).toContain("id: 2\nevent: event");
    controller.abort();
    const fallback = new AbortController();
    const missing = await fetch(`${base}/api/runs/diamond/events?after=999`, {
      headers,
      signal: fallback.signal,
    });
    expect(
      new TextDecoder().decode((await missing.body?.getReader().read())?.value),
    ).toContain("id: 2\nevent: snapshot");
    fallback.abort();
    expect(
      (await openRunStore(project.directory)).getRun("diamond"),
    ).resolves.toMatchObject({ execution });
  } finally {
    await dashboard.stop();
    await project.cleanup();
  }
});

test("public status provides a working dashboard URL and plugin disposal closes it", async () => {
  const { RalphPlugin } = await import("../../src/plugin.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  const project = await createTestProject();
  const host = createFakePluginContext(project.directory);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("public");
    const tool = host.tools.get("ralph_status");
    const output = await tool?.execute(
      { runId: "public" },
      {} as Parameters<NonNullable<typeof tool>["execute"]>[1],
    );
    const url = new URL(
      JSON.parse(String(output?.content ?? "{}")).dashboardUrl,
    );
    expect(url.hostname).toBe("127.0.0.1");
    expect(
      (
        await fetch(`${url.origin}/api/runs/public`, {
          headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
        })
      ).status,
    ).toBe(200);
    await dispose?.();
    await expect(fetch(url.origin)).rejects.toThrow();
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("logs are known IDs, paged and bounded, sanitized on write and display", async () => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  await store.createRun("r");
  const job = {
    runId: "r",
    jobId: "j",
    attempt: 1,
    role: "executor",
    workspace: project.directory,
    inputRevisions: {},
    baseCommit: project.commit,
    prompt: "never expose this prompt",
  };
  await store.recordIntent(job);
  await store.attachSession(job, "s");
  await store.recordResult({
    ...job,
    sessionId: "s",
    outcome: "completed",
    evidence: [],
    text: `password=fixture-secret Bearer fixture-token\u001b[31m\n${"X".repeat(100000)}`,
  });
  const dashboard = await startDashboard(store);
  const base = new URL(dashboard.url).origin;
  const headers = {
    Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}`,
  };
  try {
    expect((await store.getRun("r"))?.lastResult?.text).not.toContain(
      "fixture-secret",
    );
    const response = await fetch(`${base}/api/runs/r/logs/j--1?limit=999999`, {
      headers,
    });
    const log = await response.json();
    expect(log.content.length).toBeLessThanOrEqual(4096);
    expect(log).toMatchObject({
      total: 65536,
      truncated: true,
      nextOffset: 4096,
    });
    expect(log.content).not.toContain("fixture-token");
    expect(log.content).not.toContain("\u001b");
    const second = await (
      await fetch(`${base}/api/runs/r/logs/j--1?offset=4096`, { headers })
    ).json();
    expect(second.offset).toBe(4096);
    for (const id of [
      "unknown",
      "%2e%2e%2f%2e%2e%2fconfig",
      "%2fetc%2fpasswd",
      "%FF",
    ])
      expect(
        (await fetch(`${base}/api/runs/r/logs/${id}`, { headers })).status,
      ).toBe(404);
    expect(
      (await fetch(`${base}/api/runs/r/logs/j--1?offset=-1`, { headers }))
        .status,
    ).toBe(400);
    expect(
      await (await fetch(`${base}/api/runs/r`, { headers })).text(),
    ).not.toContain("never expose this prompt");
  } finally {
    await dashboard.stop();
    await project.cleanup();
  }
});

test("ordered live events survive repository-wide sequence gaps and reconnect", async () => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  await store.createRun("r");
  await store.createRun("other");
  const dashboard = await startDashboard(store, { pollIntervalMs: 20 });
  const base = new URL(dashboard.url).origin;
  const headers = {
    Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}`,
  };
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/api/runs/r/events?after=1`, {
      headers,
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "fixture",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "s");
    let received = "";
    while (!received.includes("id: 4\n"))
      received += new TextDecoder().decode((await reader?.read())?.value);
    expect(
      [...received.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    ).toEqual([3, 4]);
    controller.abort();
    await store.recordResult({
      ...job,
      sessionId: "s",
      outcome: "completed",
      text: "result",
      evidence: ["m"],
    });
    const replay = new AbortController();
    const resumed = await fetch(`${base}/api/runs/r/events`, {
      headers: { ...headers, "Last-Event-ID": "4" },
      signal: replay.signal,
    });
    const frame = new TextDecoder().decode(
      (await resumed.body?.getReader().read())?.value,
    );
    expect(frame).toContain("id: 5\nevent: event");
    expect(frame).toContain('"evidence":["m"]');
    replay.abort();
    const missing = new AbortController();
    const fallback = await fetch(`${base}/api/runs/r/events?after=2`, {
      headers,
      signal: missing.signal,
    });
    expect(
      new TextDecoder().decode(
        (await fallback.body?.getReader().read())?.value,
      ),
    ).toContain("id: 5\nevent: snapshot");
    missing.abort();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
      expect(
        (await fetch(`${base}/api/runs/r`, { method, headers })).status,
      ).toBe(405);
    expect(
      (
        await fetch(`${base}/api/runs/r`, {
          headers: { Authorization: "Bearer incorrect" },
        })
      ).status,
    ).toBe(401);
  } finally {
    controller.abort();
    await dashboard.stop();
    await project.cleanup();
  }
});

test("configured secret values are removed before persisting log output", async () => {
  const project = await createTestProject();
  const fixtureSecret = "synthetic-private-value";
  try {
    const store = await openRunStore(project.directory, {
      secrets: [fixtureSecret],
    });
    await store.createRun("r");
    const job = {
      runId: "r",
      jobId: "j",
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "fixture",
    };
    await store.recordIntent(job);
    await store.attachSession(job, "s");
    await store.recordResult({
      ...job,
      sessionId: "s",
      outcome: "completed",
      text: `response ${fixtureSecret}`,
      evidence: [],
    });
    expect((await store.getRun("r"))?.lastResult?.text).toBe(
      "response [REDACTED]",
    );
    expect(JSON.stringify(await store.events("r"))).not.toContain(
      fixtureSecret,
    );
  } finally {
    await project.cleanup();
  }
});

test("passed checks require explicit complete validation evidence before a green summary", async () => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  await store.createRun("r");
  const dashboard = await startDashboard(store);
  const base = new URL(dashboard.url).origin;
  const headers = {
    Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}`,
  };
  try {
    const execution = {
      issues: [],
      integrationQueue: [],
      checks: [
        {
          id: "tests",
          status: "passed" as const,
          attempt: 1,
          candidateCommit: project.commit,
          commandRevision: 1,
        },
      ],
    };
    await store.recordExecution(
      "r",
      (await store.getRun("r"))?.revision ?? 0,
      execution,
    );
    expect(
      (await (await fetch(`${base}/api/runs/r`, { headers })).json())
        .verification,
    ).toBe("incomplete");
    await store.recordExecution("r", (await store.getRun("r"))?.revision ?? 0, {
      ...execution,
      verification: "passed",
    });
    expect(
      (await (await fetch(`${base}/api/runs/r`, { headers })).json())
        .verification,
    ).toBe("passed");
    await store.recordExecution("r", (await store.getRun("r"))?.revision ?? 0, {
      ...execution,
      verification: "passed",
      checks: execution.checks.map((c) => ({
        ...c,
        status: "skipped",
        reason: "timeout",
      })),
    });
    expect(
      (await (await fetch(`${base}/api/runs/r`, { headers })).json())
        .verification,
    ).toBe("incomplete");
  } finally {
    await dashboard.stop();
    await project.cleanup();
  }
});

test("status dashboard projects native planning ownership and bounded waiting blockers without prompts or paths", async () => {
  const { projectPlanning } = await import(
    "../../src/dashboard/projections.js"
  );
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    const run = await store.createRun("planning");
    const planning = {
      protocol: "native-interview-v1" as const,
      phase: "prd_generation" as const,
      owner: { stage: "prd" as const, sessionId: "interview-1", attempt: 2 },
      sessionId: "interview-1",
      workspace: project.directory,
      feature: "private prompt",
      explanation: {
        revision: 1,
        hash: explanationHash({ text: "approved", scope: [], criteria: [] }),
        text: "approved",
        scope: [],
        criteria: [],
      },
      approval: {
        revision: 1,
        hash: explanationHash({ text: "approved", scope: [], criteria: [] }),
        messageId: "human",
        requestId: "question",
        sha: project.commit,
        branch: "main",
        commandHash: "hash",
        commandRevision: 1,
        sessionId: "interview-1",
      },
      proposalContext: {
        sha: project.commit,
        branch: "main",
        commandHash: "hash",
        commandRevision: 1,
      },
      commandHash: "hash",
      settings: { concurrency: 1, timeoutMs: 1000, models: {}, skills: {} },
      transcript: [],
      turn: 1,
      nativeQuestions: ["question-private"],
    };
    expect(await store.recordPlanning(run.runId, run.revision, planning)).toBe(
      true,
    );
    const dashboard = await startDashboard(store);
    try {
      const snapshot = await (
        await fetch(`${new URL(dashboard.url).origin}/api/runs/planning`, {
          headers: {
            Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}`,
          },
        })
      ).json();
      expect(snapshot.planning).toMatchObject({
        stage: "prd",
        status: "waiting",
        owner: { sessionId: "interview-1", attempt: 2 },
        waitingReason: "Waiting for native question response",
      });
      expect(JSON.stringify(snapshot)).not.toContain("private prompt");
      expect(JSON.stringify(snapshot)).not.toContain(project.directory);
      const current = required(await store.getRun(run.runId));
      expect(
        projectPlanning({
          ...current,
          planning: {
            ...planning,
            nativeQuestions: [],
            owner: { ...planning.owner, retired: true },
          },
        })?.status,
      ).toBe("retrying");
      expect(
        projectPlanning({
          ...current,
          planning: { ...planning, nativeQuestions: [] },
        })?.status,
      ).toBe("writing");
      const blocked = projectPlanning({
        ...current,
        planning: {
          ...planning,
          error: {
            code: "unsupported",
            message: `secret=hidden /private/project ${"x".repeat(2000)}`,
          },
        },
      });
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.waitingReason).not.toContain("hidden");
      expect(blocked?.waitingReason).not.toContain("/private/project");
      expect(blocked?.waitingReason?.length).toBeLessThanOrEqual(1024);
    } finally {
      await dashboard.stop();
    }
  } finally {
    await project.cleanup();
  }
});

test("native progress follows persisted owner, survives observer restart, and delivers bounded reviewer and qualified final results without model turns", async () => {
  const { createProgressObserver, MAX_PROGRESS_CHARS } = await import(
    "../../src/opencode/progress.js"
  );
  const { createOpenCodeAdapter } = await import(
    "../../src/opencode/adapter.js"
  );
  const { createFakeOpenCode } = await import("../helpers/fake-opencode.js");
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  const fake = createFakeOpenCode();
  const adapter = createOpenCodeAdapter(fake.client, store);
  const observer = () =>
    createProgressObserver({
      store,
      directory: project.directory,
      async deliver({ runId, sessionId, id, text }) {
        const result = await adapter.publishProgress?.(
          runId,
          sessionId,
          project.directory,
          id,
          text,
        );
        if (!result?.ok) throw new Error(result?.error?.message);
      },
    });
  let progress = observer();
  const messages = () =>
    fake.requests.filter((r) => r.path.endsWith("/synthetic"));
  try {
    let run = await store.createRun("visible");
    const planning = {
      protocol: "native-interview-v1" as const,
      phase: "prd_generation" as const,
      owner: {
        stage: "interview" as const,
        sessionId: "interview",
        attempt: 1,
      },
      sessionId: "interview",
      workspace: project.directory,
      feature: "RAW PRIVATE PROMPT",
      issueHandoff: {
        jobId: "issues",
        attempt: 1,
        prd: { revision: 1, hash: "hash", artifactPath: "PRD.md" },
        prompt: "RAW PRIVATE PROMPT",
        messageId: "handoff",
        sessionId: "issues",
      },
      commandHash: "hash",
      settings: { concurrency: 1, timeoutMs: 1000, models: {}, skills: {} },
      transcript: [],
      turn: 1,
    };
    expect(await store.recordPlanning(run.runId, run.revision, planning)).toBe(
      true,
    );
    await progress.flush();
    expect(messages().map((m) => m.path)).toEqual([
      "/api/session/interview/synthetic",
    ]);
    // A backlog from the retired chat must not starve the new visible owner.
    for (let i = 0; i < 101; i++)
      await store.recordControl(run.runId, {
        status: "active",
        source: "human",
      });
    run = required(await store.getRun(run.runId));
    expect(
      await store.recordPlanning(run.runId, run.revision, {
        ...planning,
        sessionId: "issues",
        phase: "issue_generation",
        owner: { stage: "issues", sessionId: "issues", attempt: 1 },
      }),
    ).toBe(true);
    const before = messages().length;
    await progress.flush();
    expect(messages()).toHaveLength(before + 1);
    expect(
      messages()
        .slice(before)
        .every((m) => m.path === "/api/session/issues/synthetic"),
    ).toBe(true);
    run = required(await store.getRun(run.runId));
    expect(
      await store.recordReviewSnapshot(run.runId, run.revision, {
        snapshot: {
          runId: run.runId,
          round: 1,
          commit: project.commit,
          prdRevision: "1",
          graphRevision: "1",
          evidenceRefs: [],
        },
        inputs: {
          baseCommit: project.commit,
          prd: "RAW PRIVATE PROMPT",
          graph: "private",
          diff: "private",
          tests: [],
          execution: { issues: [], checks: [], integrationQueue: [] },
        },
      }),
    ).toBe(true);
    const job = {
      runId: run.runId,
      jobId: "reviewer",
      role: "code-review",
      sessionId: "review-session",
      attempt: 1,
      workspace: project.directory,
      inputRevisions: { round: 1 },
      baseCommit: project.commit,
      prompt: "RAW PRIVATE PROMPT",
    };
    expect(await store.recordIntent(job)).toBe(true);
    expect(await store.attachSession(job, job.sessionId)).toBe(true);
    expect(
      await store.recordResult({
        ...job,
        outcome: "completed",
        text: `secret=hidden ${"review evidence ".repeat(4000)}`,
        evidence: ["review-result", "x".repeat(30000)],
      }),
    ).toBe(true);
    await progress.flush();
    expect(messages().at(-1)?.body.text).toContain("code-review");
    expect(messages().at(-1)?.body.text).toContain("review-session");
    expect(messages().at(-1)?.body.text).toContain("completed");
    expect(
      messages().some((m) =>
        String(m.body.text).includes("Progress truncated"),
      ),
    ).toBe(true);
    run = required(await store.getRun(run.runId));
    expect(
      await store.recordReviewWorkflow(run.runId, run.revision, {
        ownerId: "review-owner",
        branch: "feature",
        commit: project.commit,
        status: "terminal",
        rounds: [],
        report: {
          outcome: "incomplete-validation",
          branch: "feature",
          commit: project.commit,
          rounds: [],
          completedIssues: ["A"],
          blockedIssues: [],
          repairCount: 0,
          repairedIssues: [],
          attempts: [{ issueId: "A", used: 1 }],
          findings: [],
          evidenceRefs: ["review-result"],
          skippedChecks: [
            {
              id: "browser",
              status: "skipped",
              attempt: 1,
              candidateCommit: project.commit,
              commandRevision: 1,
              reason: "timeout",
            },
          ],
          unavailableReview: ["Functional review unavailable"],
          retainedResources: ["/private/retained"],
          cleanupFailures: [],
        },
      }),
    ).toBe(true);
    await progress.flush();
    const final = required(messages().at(-1));
    expect(final.path).toBe("/api/session/issues/synthetic");
    expect(final.body.text).toContain("incomplete-validation");
    expect(final.body.text).toContain("browser: timeout");
    expect(final.body.text).toContain("Functional review unavailable");
    for (const message of messages()) {
      expect(message.body.resume).toBe(false);
      expect(String(message.body.text).length).toBeLessThanOrEqual(
        MAX_PROGRESS_CHARS,
      );
      expect(message.body.text).not.toContain("hidden");
      expect(message.body.text).not.toContain("RAW PRIVATE PROMPT");
    }
    expect(
      fake.requests.filter((r) => /\/(prompt|wait)$/.test(r.path)),
    ).toEqual([]);
    const count = messages().length;
    const revision = required(await store.getRun(run.runId)).revision;
    await progress.stop();
    progress = observer();
    await progress.flush();
    expect(messages()).toHaveLength(count);
    expect(required(await store.getRun(run.runId)).revision).toBe(revision);
    await progress.stop();
    let rejectDelivery = true;
    progress = createProgressObserver({
      store,
      directory: project.directory,
      async deliver({ runId, sessionId, id, text }) {
        if (rejectDelivery) throw new Error("Temporary delivery failure");
        const result = await adapter.publishProgress?.(
          runId,
          sessionId,
          project.directory,
          id,
          text,
        );
        if (!result?.ok) throw new Error(result?.error?.message);
      },
    });
    await store.recordControl(run.runId, { status: "paused", source: "human" });
    await expect(progress.flush()).rejects.toThrow(
      "Temporary delivery failure",
    );
    expect(messages()).toHaveLength(count);
    rejectDelivery = false;
    await progress.flush();
    expect(messages()).toHaveLength(count + 1);
    expect(messages().at(-1)?.body.text).toContain("paused");
    const { git } = await import("../helpers/project.js");
    const linked = `${project.directory}/linked`;
    await git("git", [
      "-C",
      project.directory,
      "worktree",
      "add",
      "-b",
      "linked",
      linked,
    ]);
    const foreign = createProgressObserver({
      store: await openRunStore(linked),
      directory: linked,
      async deliver() {
        throw new Error("Cross-location progress must not be delivered");
      },
    });
    await foreign.flush();
    await foreign.stop();

    expect(
      await adapter.publishProgress?.(
        run.runId,
        "interview",
        project.directory,
        "late",
        "stale",
      ),
    ).toMatchObject({ ok: false });
    expect(
      await adapter.publishProgress?.(
        run.runId,
        "issues",
        "/other",
        "foreign",
        "foreign",
      ),
    ).toMatchObject({ ok: false });
  } finally {
    await progress.stop();
    await project.cleanup();
  }
});
