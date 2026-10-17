import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { preflightRun } from "../../src/execution/preflight.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { RalphPlugin } from "../../src/plugin.js";
import { reconcileRun } from "../../src/recovery/reconcile.js";
import { openRunStore } from "../../src/state/run-store.js";
import {
  createFakeOpenCode,
  createFakePluginContext,
} from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";

test("public feature tools omit the chat protocol and preserve native questions", async () => {
  const project = await createTestProject();
  const host = createFakePluginContext(
    project.directory,
    createFakeOpenCode().client,
  );
  const dispose = await RalphPlugin.setup(host.context);
  try {
    expect(host.tools.has("ralph_workflow")).toBe(false);
    // Removal is a deterministic command; no model tool can remove state.
    expect(host.tools.has("ralph_remove")).toBe(false);
    for (const tool of [
      "ralph_complete_interview",
      "ralph_complete_prd",
      "ralph_complete_issues",
      "ralph_save_commands",
    ])
      expect(host.tools.has(tool)).toBe(true);
    const input = {
      sessionID: "main",
      tools: { question: {}, read: {} },
      system: [],
    };
    await host.hooks.get("session.context")?.(input);
    expect(input.tools.question).toBeDefined();
    await host.hooks.get("tool.execute.before")?.({
      sessionID: "main",
      tool: "question",
    });
    expect(input.system).toEqual([]);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("every public resume rejects unsupported saved planning without changing its bytes or artifacts", async () => {
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  const host = createFakePluginContext(project.directory, fake.client);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("old-feature");
    // Historical records are disk input, never accepted through a new planning write.
    const path = join(store.root, "events.jsonl");
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    events.at(-1).snapshot.planning = {
      phase: "execution_approved",
      workspace: project.directory,
      sessionId: "main",
    };
    await writeFile(
      path,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    expect((await store.getRun("old-feature"))?.planning?.phase).toBe(
      "execution_approved",
    );
    await mkdir(join(project.directory, ".ralph"));
    const artifact = join(project.directory, ".ralph", "old-draft.md");
    await writeFile(artifact, "Preserve this draft");
    const before = await readFile(path, "utf8");
    const adapter = createOpenCodeAdapter(fake.client, store);
    const router = createCommandRouter(store, adapter);
    await expect(
      router.dispatch("ralph-resume", "old-feature", {
        workspace: project.directory,
        sessionId: "main",
      }),
    ).rejects.toThrow("fresh workflow");
    await expect(
      host.tools
        .get("ralph_control")
        ?.execute({ action: "resume", runId: "old-feature" }, {
          sessionID: "main",
          signal: new AbortController().signal,
        } as never),
    ).rejects.toThrow("fresh workflow");
    for (const invoke of [
      () => router.continuePlanning("old-feature"),
      () => router.scheduleIssues("old-feature"),
      () => router.executeIssue("old-feature", "A"),
    ])
      await expect(invoke()).rejects.toThrow("fresh workflow");
    await expect(preflightRun(store, adapter, "old-feature")).rejects.toThrow(
      "fresh workflow",
    );
    expect(
      (
        await reconcileRun({
          store,
          adapter,
          directory: project.directory,
          runId: "old-feature",
        })
      ).facts.join(" "),
    ).toContain("fresh workflow");
    const job = {
      runId: "old-feature",
      jobId: "obsolete-job",
      role: "executor",
      attempt: 1,
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: {},
      prompt: "Do not execute",
    };
    expect(await adapter.dispatchJob(job)).toMatchObject({
      outcome: "failed",
      error: {
        code: "unsupported",
        message: expect.stringContaining("fresh workflow"),
      },
    });
    await expect(store.recordIntent(job)).rejects.toThrow("fresh workflow");
    const old = (await store.getRun("old-feature"))?.planning;
    if (!old) throw new Error("Missing unsupported record");
    await expect(
      store.recordPlanning(
        "old-feature",
        (await store.getRun("old-feature"))?.revision ?? 0,
        old,
      ),
    ).rejects.toThrow("no migration");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(artifact, "utf8")).toBe("Preserve this draft");
    expect(
      fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(0);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});
