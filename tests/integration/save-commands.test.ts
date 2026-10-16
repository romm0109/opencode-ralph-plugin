import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertProjectConfigured,
  assertProjectReady,
  projectStatus,
} from "../../src/commands/project-setup.js";
import { saveProjectCommands } from "../../src/commands/save-commands.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { startInterview } from "../../src/planning/interview.js";
import { RalphPlugin } from "../../src/plugin.js";
import { openRunStore } from "../../src/state/run-store.js";
import {
  createFakeOpenCode,
  createFakePluginContext,
} from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";

const proposal = {
  schemaVersion: 1,
  revision: 1,
  rationale: "Run the repository's tests",
  commands: [
    {
      id: "test",
      phase: "check",
      executable: "bun",
      args: ["test"],
      cwd: ".",
      timeoutMs: 30000,
      platforms: ["darwin", "linux", "win32"],
      env: {},
    },
  ],
};

test("save tool writes approved commands without sessions, jobs or verification", async () => {
  const project = await createTestProject();
  const host = createFakePluginContext(project.directory);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    const tool = host.tools.get("ralph_save_commands");
    if (!tool) throw new Error("Missing save tool");
    const result = await tool.execute(proposal, {
      sessionID: "main",
      signal: new AbortController().signal,
    } as never);
    expect(result.content).toContain('"status":"configured"');
    expect(
      await Bun.file(join(project.directory, ".ralph/commands.json")).json(),
    ).toEqual(proposal);
    expect(
      await Bun.file(
        join(project.directory, ".ralph/verification.json"),
      ).exists(),
    ).toBe(false);
    const store = await openRunStore(project.directory);
    expect(await store.listRuns()).toHaveLength(0);
    const status = await projectStatus(project.directory);
    expect(status.status).toBe("configured");
    expect(
      await Bun.file(
        join(store.root, "command-revisions", `${status.hash}.json`),
      ).json(),
    ).toEqual(proposal);
    await assertProjectConfigured(project.directory);
    await expect(assertProjectReady(project.directory)).rejects.toThrow(
      "not run",
    );
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("invalid or stale proposals preserve the saved file; accepted updates clear old verification", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await saveProjectCommands(project.directory, proposal, store);
    const path = join(project.directory, ".ralph/commands.json");
    const before = await Bun.file(path).text();
    await expect(
      saveProjectCommands(
        project.directory,
        { ...proposal, commands: [] },
        store,
      ),
    ).rejects.toThrow();
    await expect(
      saveProjectCommands(project.directory, proposal, store),
    ).rejects.toThrow("revision 2");
    expect(await Bun.file(path).text()).toBe(before);
    await writeFile(
      join(project.directory, ".ralph/verification.json"),
      '{"status":"verified"}',
    );
    await saveProjectCommands(
      project.directory,
      { ...proposal, revision: 2 },
      store,
    );
    expect((await projectStatus(project.directory)).status).toBe("configured");
    expect((await Bun.file(path).json()).revision).toBe(2);
  } finally {
    await project.cleanup();
  }
});

test("saving refuses active runs and cancelled calls", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await expect(
      saveProjectCommands(
        project.directory,
        proposal,
        store,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    await mkdir(join(store.root, "active-run.lock"));
    await expect(
      saveProjectCommands(project.directory, proposal, store),
    ).rejects.toThrow("active feature run");
    expect(
      await Bun.file(join(project.directory, ".ralph/commands.json")).exists(),
    ).toBe(false);
  } finally {
    await project.cleanup();
  }
});

test("saved commands can begin planning without running setup verification", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    const saved = await saveProjectCommands(project.directory, proposal, store);
    const fake = createFakeOpenCode();
    fake.respond(
      JSON.stringify({
        kind: "question",
        question: "What should reset do?",
        recommendation: "Reset the counter",
      }),
    );
    const adapter = createOpenCodeAdapter(fake.client, store);
    adapter.getSessionModel = async () => ({
      providerID: "fixture",
      modelID: "fixture",
    });
    adapter.discoverTools = async () => ["question"];
    let asked = false;
    adapter.requestUserInput = async () => {
      asked = true;
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Test stops at the interview question",
        },
      };
    };
    await startInterview({
      workspace: project.directory,
      sessionId: "main",
      feature: "Add reset",
      store,
      adapter,
    });
    expect(asked).toBe(true);
    expect((await store.listRuns())[0]?.planning?.commandHash).toBe(saved.hash);
    expect(
      await Bun.file(
        join(project.directory, ".ralph/verification.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await project.cleanup();
  }
});
