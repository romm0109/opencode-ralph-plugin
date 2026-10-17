import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { gitOutput } from "../git/worktrees.js";
import { inspectOwnedProcess } from "../process/ownership.js";
import type { RunStore } from "../state/run-store.js";

const liveFiles = new Set([
  "host.json",
  "host.lock",
  "host.lock.recovery",
  "write.lock",
  "write.lock.recovery",
  "project-setup.lock",
]);
async function describe(
  path: string,
  progress: { root: string; runs: string[] },
): Promise<unknown[]> {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return [];
  if (info.isFile() && dirname(path) === progress.root) {
    const name = basename(path);
    if (
      progress.runs.some((runId) => {
        const cursor = `${runId}.json`;
        return (
          name === cursor ||
          (name.startsWith(`${cursor}.`) &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
              name.slice(cursor.length + 1),
            ))
        );
      })
    )
      return [];
  }
  return [
    // Observer checkpoints are not workflow authority. Atomic cursor writes
    // change this directory's size/mtime; unknown children remain fingerprinted.
    path === progress.root && info.isDirectory()
      ? [path, info.mode]
      : [path, info.mode, info.size, info.mtimeMs],
    ...(info.isDirectory()
      ? (
          await Promise.all(
            (
              await readdir(path)
            )
              .sort()
              .map((name) => describe(join(path, name), progress)),
          )
        ).flat()
      : []),
  ];
}
export async function previewProjectRemoval(
  workspace: string,
  store: RunStore,
) {
  const directory = await realpath(workspace);
  if (
    (await realpath(store.root)) !== join(store.repositoryId, "ralph", "runs")
  )
    throw new Error("Ralph state directory must not be a symlink");
  const runs = await store.listRuns();
  const blockers: string[] = [];
  for (const run of runs) {
    if (
      Object.values(run.jobs).some((job) => job.status !== "terminal") ||
      run.control?.cleanupPending ||
      Object.values(run.operations).some((op) => op.status === "intent")
    )
      blockers.push(
        `Run ${run.runId} has active or unsettled work. Use /ralph-stop ${run.runId} and resolve cleanup first.`,
      );
    for (const op of Object.values(run.operations)) {
      if (!op.ownedProcess) continue;
      const state = await inspectOwnedProcess(op.ownedProcess);
      if (state.status === "owned" || state.status === "unknown")
        blockers.push(
          `Process cleanup is required for ${run.runId}/${op.operationId}`,
        );
    }
  }
  const worktrees = (
    await gitOutput(directory, ["worktree", "list", "--porcelain", "-z"])
  )
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice(9));
  // Preserve workspaces even after an interrupted Git operation lost registration.
  const retained = new Set<string>(["worktrees", "review-workspaces"]);
  for (const worktree of worktrees) {
    const path = relative(store.root, worktree);
    if (
      path &&
      !path.startsWith(`..${sep}`) &&
      path !== ".." &&
      !isAbsolute(path)
    )
      retained.add(path.split(sep)[0] as string);
    const configPath = relative(join(directory, ".ralph"), worktree);
    if (
      !configPath ||
      (!configPath.startsWith(`..${sep}`) &&
        configPath !== ".." &&
        !isAbsolute(configPath))
    )
      blockers.push(
        `A Git worktree lives inside .ralph: ${worktree}; move it before removal.`,
      );
  }
  const config = join(directory, ".ralph");
  const targets = [
    config,
    ...(await readdir(store.root))
      .sort()
      .filter((name) => !liveFiles.has(name) && !retained.has(name))
      .map((name) => join(store.root, name)),
  ];
  const progress = {
    root: join(store.root, "chat-progress"),
    runs: runs.map((run) => run.runId),
  };
  const inventory = (
    await Promise.all(targets.map((path) => describe(path, progress)))
  ).flat();
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        inventory,
        worktrees,
        revisions: runs.map((run) => [run.runId, run.revision]),
      }),
    )
    .digest("hex");
  return {
    planId: hash,
    targets: targets.filter((path) =>
      inventory.some((entry) => Array.isArray(entry) && entry[0] === path),
    ),
    blockers: [...new Set(blockers)],
    retainedWorktrees: worktrees.filter((path) => path !== directory),
    preserves:
      "Project code, Git history, feature branches, registered Git worktrees, and the globally installed plugin. Live host bookkeeping remains until OpenCode unloads this location.",
    sharedState:
      "Saved workflow state is shared by linked worktrees of this repository.",
  };
}

export async function removeProject(
  workspace: string,
  store: RunStore,
  planId: string,
  signal?: AbortSignal,
) {
  const setupLock = join(store.root, "project-setup.lock");
  const writeLock = join(store.root, "write.lock");
  await mkdir(setupLock);
  let locked = false;
  let createdGuard = false;
  let removed = false;
  const activeLock = join(store.root, "active-run.lock");
  try {
    await mkdir(writeLock);
    locked = true;
    const plan = await previewProjectRemoval(workspace, store);
    if (plan.planId !== planId)
      throw new Error(
        "Ralph files or state changed. Show a fresh removal preview and ask again.",
      );
    if (plan.blockers.length) throw new Error(plan.blockers.join("\n"));
    try {
      await mkdir(activeLock);
      createdGuard = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(
        await readFile(join(activeLock, "owner.json"), "utf8"),
      );
      if (!(await store.getRun(owner.runId)))
        throw new Error("A feature is starting; wait before removing Ralph");
    }
    signal?.throwIfAborted();
    for (const path of plan.targets)
      if (path !== activeLock) await rm(path, { recursive: true, force: true });
    removed = true;
    return {
      status: "removed",
      removed: plan.targets,
      preserved: plan.preserves,
      retainedWorktrees: plan.retainedWorktrees,
    };
  } finally {
    if (createdGuard || removed)
      await rm(activeLock, { recursive: true, force: true });
    if (locked) await rm(writeLock, { recursive: true });
    await rm(setupLock, { recursive: true });
  }
}
