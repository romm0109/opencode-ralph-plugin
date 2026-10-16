import { expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  previewProjectRemoval,
  removeProject,
} from "../../src/commands/remove-project.js";
import { saveProjectCommands } from "../../src/commands/save-commands.js";
import { RalphPlugin } from "../../src/plugin.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakePluginContext } from "../helpers/fake-opencode.js";
import { createTestProject, git } from "../helpers/project.js";

test("removal requires a new chat approval, clears state and allows setup again while preserving code and branches", async () => {
  const project = await createTestProject();
  const host = createFakePluginContext(project.directory);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("existing");
    await mkdir(join(project.directory, ".ralph"));
    await writeFile(
      join(project.directory, ".ralph/commands.json"),
      "old config",
    );
    await git("git", ["-C", project.directory, "branch", "ralph/completed"]);
    const tree = join(store.root, "worktrees", "preserved");
    await git("git", [
      "-C",
      project.directory,
      "worktree",
      "add",
      "-b",
      "ralph/retained",
      tree,
    ]);
    await writeFile(join(tree, "unsaved.txt"), "Keep this code");
    const tool = host.tools.get("ralph_remove");
    if (!tool) throw new Error("Missing removal tool");
    const invoke = async (input: unknown) =>
      JSON.parse(
        (
          await tool.execute(input, {
            sessionID: "main",
            signal: new AbortController().signal,
          } as never)
        ).content as string,
      );
    await host.hooks.get("session.prompt")?.({
      sessionID: "main",
      messageID: "too-early",
      prompt: { text: "approve" },
    });
    const preview = await invoke({ action: "preview" });
    expect(preview.blockers).toEqual([]);
    expect(preview.retainedWorktrees).toContain(await realpath(tree));
    await expect(
      invoke({ action: "remove", planId: preview.planId }),
    ).rejects.toThrow("new user approval");
    await host.hooks.get("session.prompt")?.({
      sessionID: "main",
      messageID: "reject",
      prompt: { text: "no" },
    });
    await expect(
      invoke({ action: "remove", planId: preview.planId }),
    ).rejects.toThrow("new user approval");
    await host.hooks.get("session.prompt")?.({
      sessionID: "main",
      messageID: "approve",
      prompt: { text: "yes" },
    });
    expect(
      (await invoke({ action: "remove", planId: preview.planId })).status,
    ).toBe("removed");
    expect(await store.listRuns()).toEqual([]);
    expect(
      await Bun.file(join(project.directory, ".ralph/commands.json")).exists(),
    ).toBe(false);
    expect(await readFile(join(tree, "unsaved.txt"), "utf8")).toBe(
      "Keep this code",
    );
    expect(await readFile(join(project.directory, "README.md"), "utf8")).toBe(
      "Fixture\n",
    );
    expect(
      (
        await git("git", [
          "-C",
          project.directory,
          "rev-parse",
          "ralph/completed",
        ])
      ).stdout.trim(),
    ).toBe(project.commit);
    await saveProjectCommands(
      project.directory,
      {
        schemaVersion: 1,
        revision: 1,
        rationale: "Reinitialize",
        commands: [
          {
            id: "test",
            phase: "check",
            executable: "bun",
            args: ["test"],
            cwd: ".",
            timeoutMs: 1000,
            platforms: ["darwin", "linux", "win32"],
            env: {},
          },
        ],
      },
      store,
    );
    expect(
      await Bun.file(join(project.directory, ".ralph/commands.json")).exists(),
    ).toBe(true);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
});

test("a changed removal preview or active job prevents deletion", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await mkdir(join(project.directory, ".ralph"));
    await writeFile(
      join(project.directory, ".ralph/commands.json"),
      "Keep this",
    );
    const preview = await previewProjectRemoval(project.directory, store);
    await writeFile(join(project.directory, ".ralph/new-file"), "New content");
    await expect(
      removeProject(project.directory, store, preview.planId),
    ).rejects.toThrow("changed");
    await store.createRun("active");
    await store.recordIntent({
      runId: "active",
      jobId: "executor",
      role: "executor",
      attempt: 1,
      workspace: project.directory,
      inputRevisions: {},
      baseCommit: project.commit,
      prompt: "Work",
    });
    const blocked = await previewProjectRemoval(project.directory, store);
    expect(blocked.blockers.join("\n")).toContain("active or unsettled");
    await expect(
      removeProject(project.directory, store, blocked.planId),
    ).rejects.toThrow("active or unsettled");
    expect(
      await Bun.file(join(project.directory, ".ralph/commands.json")).text(),
    ).toBe("Keep this");
  } finally {
    await project.cleanup();
  }
});

test("removal unlinks a configuration symlink without traversing its target", async () => {
  if (process.platform === "win32") return;
  const project = await createTestProject();
  const outside = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await symlink(outside.directory, join(project.directory, ".ralph"));
    const plan = await previewProjectRemoval(project.directory, store);
    await removeProject(project.directory, store, plan.planId);
    expect(await readFile(join(outside.directory, "README.md"), "utf8")).toBe(
      "Fixture\n",
    );
  } finally {
    await project.cleanup();
    await outside.cleanup();
  }
});
