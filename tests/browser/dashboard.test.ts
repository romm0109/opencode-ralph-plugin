import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { createCommandRouter } from "../../src/commands/router.js";
import { startDashboard } from "../../src/dashboard/server.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";

test("scheduler-produced diamond catches up after reconnect and retains all-skipped validation", async ({
  page,
  context,
}) => {
  const child = spawn("bun", ["run", "tests/helpers/dashboard-scheduler.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  const lines = createInterface({ input: child.stdout });
  const settled = new Promise<void>((resolve) => {
    lines.on("line", (line) => {
      if (JSON.parse(line).settled) resolve();
    });
  });
  try {
    const status = await new Promise<{ dashboardUrl: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error(`Scheduler fixture exited: ${diagnostics}`)),
        );
        lines.once("line", (line) => resolve(JSON.parse(line)));
      },
    );
    await page.goto(status.dashboardUrl);
    const graph = page.getByRole("region", { name: "Dependency graph" });
    const issue = (id: string) =>
      graph.getByRole("article").filter({
        has: page.getByRole("heading", { name: new RegExp(`^${id}:`) }),
      });
    await expect(page.getByRole("status")).toContainText("connected");
    await expect(
      issue("A").getByText("integrated", { exact: true }),
    ).toBeVisible();
    await expect(graph.getByText("running", { exact: true })).toHaveCount(2);
    await expect(
      issue("D").getByText("pending", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("skipped", { exact: true })).not.toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByRole("status")).toContainText("reconnecting");
    child.stdin.write("release\n");
    await settled;
    await context.setOffline(false);
    await expect(graph.getByText("integrated", { exact: true })).toHaveCount(5);
    await expect(page.getByRole("status")).toContainText("connected");
    await expect(page.getByText("skipped", { exact: true })).toHaveCount(5);
    await expect(page.getByText("incomplete", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /approve|answer|pause|retry|stop|resume/i,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: /^View log/ })
      .first()
      .click();
    await expect(page.getByRole("region", { name: "Logs" })).toContainText(
      "submittedCommit",
    );
  } finally {
    child.stdin.end("close\n");
    await exited;
    lines.close();
  }
});

test("observes two live agents, blocked descendants, skipped validation and reconnect without workflow controls", async ({
  page,
  context,
}) => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  const dashboard = await startDashboard(store, { pollIntervalMs: 50 });
  const fake = createFakeOpenCode();
  fake.hold();
  const router = createCommandRouter(
    store,
    createOpenCodeAdapter(fake.client, store),
    dashboard.url,
  );
  const pending = ["B", "C"].map((id) =>
    router.runJob({
      runId: "diamond",
      jobId: id,
      issueId: id,
      attempt: 1,
      role: "executor",
      workspace: project.directory,
      inputRevisions: { graph: 1 },
      baseCommit: project.commit,
      prompt: "fixture",
    }),
  );
  try {
    await expect
      .poll(
        () =>
          fake.requests.filter((request) => request.path.endsWith("/prompt"))
            .length,
      )
      .toBe(2);
    const execution = {
      issues: [
        {
          id: "A",
          title: "Root",
          dependencies: [],
          status: "integrated" as const,
          blockers: [],
        },
        {
          id: "B",
          title: "Left",
          dependencies: ["A"],
          status: "running" as const,
          blockers: [],
        },
        {
          id: "C",
          title: "Right",
          dependencies: ["A"],
          status: "running" as const,
          blockers: [],
        },
        {
          id: "D",
          title: "Join",
          dependencies: ["B", "C"],
          status: "blocked" as const,
          blockers: ["B", "C"],
        },
      ],
      integrationQueue: [],
      checks: [
        {
          id: "unit-tests",
          status: "skipped" as const,
          reason: "timeout",
          attempt: 1,
          candidateCommit: project.commit,
          commandRevision: 1,
        },
      ],
    };
    await store.recordExecution(
      "diamond",
      (await store.getRun("diamond"))?.revision ?? 0,
      execution,
    );
    const status = JSON.parse(await router.status("diamond"));
    await page.goto(status.dashboardUrl);
    // Fragment is removed after bootstrap; request URLs never contain the token.
    await expect(page).toHaveURL(`${new URL(dashboard.url).origin}/`);
    await expect(page.getByRole("status")).toContainText("connected");
    const graph = page.getByRole("region", { name: "Dependency graph" });
    await expect(graph.getByText("running", { exact: true })).toHaveCount(2);
    await expect(graph.getByText("Blocked by: B, C")).toBeVisible();
    await expect(page.getByText("skipped", { exact: true })).toBeVisible();
    await expect(page.getByText("incomplete", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /approve|answer|pause|retry|stop|resume/i,
      }),
    ).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByRole("status")).toContainText("reconnecting");
    fake.release();
    await Promise.all(pending);
    await store.recordExecution(
      "diamond",
      (await store.getRun("diamond"))?.revision ?? 0,
      {
        ...execution,
        integrationQueue: ["B", "C"],
        issues: execution.issues.map((i) =>
          i.id === "B" || i.id === "C"
            ? { ...i, status: "integration_queued" as const }
            : i,
        ),
      },
    );
    await context.setOffline(false);
    await expect(page.getByRole("status")).toContainText("connected");
    await expect(
      graph.getByText("integration queued", { exact: true }),
    ).toHaveCount(2);
    await expect(graph.getByText("Blocked by: B, C")).toBeVisible();
    await page.getByRole("button", { name: "View log B", exact: true }).click();
    await expect(page.getByRole("region", { name: "Logs" })).toContainText(
      "actual response",
    );
    await expect(page.getByText("skipped", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /approve|answer|pause|retry|stop|resume/i,
      }),
    ).toHaveCount(0);
  } finally {
    fake.release();
    await Promise.allSettled(pending);
    await dashboard.stop();
    await project.cleanup();
  }
});

test("native planning shows owner, attempts, waiting and blockers without browser mutations", async ({
  page,
}) => {
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  const run = await store.createRun("planning");
  const planning = {
    protocol: "native-interview-v1" as const,
    phase: "issue_generation" as const,
    owner: {
      stage: "issues" as const,
      sessionId: "planner-session",
      attempt: 2,
    },
    sessionId: "planner-session",
    workspace: project.directory,
    feature: "PRIVATE PROMPT",
    commandHash: "hash",
    settings: { concurrency: 1, timeoutMs: 1000, models: {}, skills: {} },
    transcript: [],
    turn: 1,
    nativeQuestions: ["native-question"],
  };
  await store.recordPlanning(run.runId, run.revision, planning);
  const dashboard = await startDashboard(store, { pollIntervalMs: 50 });
  try {
    await page.goto(dashboard.url);
    const stage = page.getByRole("region", { name: "Planning stage" });
    await expect(stage).toContainText("issues");
    await expect(stage).toContainText("Attempt 2");
    await expect(stage).toContainText("planner-session");
    await expect(stage.getByText("waiting", { exact: true })).toBeVisible();
    await store.recordPlanning(
      run.runId,
      (await store.getRun(run.runId))?.revision ?? 0,
      { ...planning, nativeQuestions: [] },
    );
    await expect(stage.getByText("writing", { exact: true })).toBeVisible();
    await store.recordPlanning(
      run.runId,
      (await store.getRun(run.runId))?.revision ?? 0,
      {
        ...planning,
        nativeQuestions: [],
        owner: { ...planning.owner, retired: true },
      },
    );
    await expect(stage.getByText("retrying", { exact: true })).toBeVisible();
    await store.recordPlanning(
      run.runId,
      (await store.getRun(run.runId))?.revision ?? 0,
      {
        ...planning,
        error: {
          code: "unsupported",
          message: "secret=hidden /private/artifact Native input unavailable",
        },
      },
    );
    await expect(stage.getByText("blocked", { exact: true })).toBeVisible();
    await expect(stage).toContainText("Native input unavailable");
    await expect(page.locator("body")).not.toContainText("hidden");
    await expect(page.locator("body")).not.toContainText("PRIVATE PROMPT");
    await expect(page.locator("body")).not.toContainText("/private/artifact");
    await expect(
      page.getByRole("button", {
        name: /approve|answer|pause|retry|stop|resume/i,
      }),
    ).toHaveCount(0);
  } finally {
    await dashboard.stop();
    await project.cleanup();
  }
});
