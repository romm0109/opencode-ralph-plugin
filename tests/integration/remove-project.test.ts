import { expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  realpath,
  rm,
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

test("removal asks one native question for its exact preview, clears state and allows setup again while preserving code and branches", async () => {
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
    // The command asks one native question bound to its own preview.
    const asked: { sessionID: string; question: string; options: string[] }[] =
      [];
    let answer: string | undefined;
    host.tools.set("question", {
      id: "question",
      name: "question",
      description: "Native input",
      input: {} as never,
      async execute(input, context) {
        const [q] = (
          input as {
            questions: { question: string; options: { label: string }[] }[];
          }
        ).questions;
        asked.push({
          sessionID: context.sessionID,
          question: q?.question ?? "",
          options: q?.options.map((o) => o.label) ?? [],
        });
        return {
          content: "",
          metadata: answer ? { answers: [[answer]] } : {},
        };
      },
    });
    const remove = () =>
      host.commands.get("ralph-remove")?.execute({
        sessionID: "main",
        prompt: { text: "" },
        delivery: "steer",
      } as never);
    // No answer from the form: nothing is removed and no model is prompted.
    await remove();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.sessionID).toBe("main");
    expect(asked[0]?.question).toContain(".ralph");
    expect(asked[0]?.question).toContain(await realpath(tree));
    expect(asked[0]?.options).toEqual([
      "Remove Ralph state",
      "Keep everything",
    ]);
    expect(await store.listRuns()).toHaveLength(1);
    // Declining keeps everything.
    answer = "Keep everything";
    await remove();
    expect(await store.listRuns()).toHaveLength(1);
    expect(
      await Bun.file(join(project.directory, ".ralph/commands.json")).exists(),
    ).toBe(true);
    answer = "Remove Ralph state";
    await remove();
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

test("removal ignores known observation cursor churn but guards unknown files and workflow changes", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("observed");
    await mkdir(join(project.directory, ".ralph"));
    await writeFile(join(project.directory, ".ralph/commands.json"), "config");
    const progress = join(store.root, "chat-progress");
    await mkdir(progress);
    await writeFile(join(progress, "observed.json"), '{"sequence":1}');
    const preview = await previewProjectRemoval(project.directory, store);
    await writeFile(
      join(progress, "observed.json"),
      '{"sequence":200,"view":{"changed":true}}',
    );
    await writeFile(
      join(progress, "observed.json.12345678-1234-4234-8234-123456789abc.tmp"),
      "pending atomic checkpoint",
    );
    expect((await previewProjectRemoval(project.directory, store)).planId).toBe(
      preview.planId,
    );
    await writeFile(join(progress, "notes.txt"), "Unrecognized user file");
    await expect(
      removeProject(project.directory, store, preview.planId),
    ).rejects.toThrow("changed");
    await rm(join(progress, "notes.txt"));
    expect((await previewProjectRemoval(project.directory, store)).planId).toBe(
      preview.planId,
    );
    await store.recordControl("observed", {
      status: "paused",
      source: "human",
    });
    await expect(
      removeProject(project.directory, store, preview.planId),
    ).rejects.toThrow("changed");
    const current = await previewProjectRemoval(project.directory, store);
    expect(
      (await removeProject(project.directory, store, current.planId)).status,
    ).toBe("removed");
    expect(await Bun.file(join(progress, "observed.json")).exists()).toBe(
      false,
    );
    expect(await readFile(join(project.directory, "README.md"), "utf8")).toBe(
      "Fixture\n",
    );
  } finally {
    await project.cleanup();
  }
});
