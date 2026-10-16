import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { commandConfigHash, parseCommandConfig } from "../config/commands.js";
import type { RunStore } from "../state/run-store.js";
import {
  referencedSecretValues,
  runtimeSecretValues,
} from "../state/sanitize.js";

export const commandSetupPrompt = `Set up Ralph project commands in this conversation.
Search the actual project files (package scripts, CI, README and AGENTS.md) using your normal read/search tools. Read .ralph/commands.json if it exists. Do not assume source directories exist or delegate discovery to another session.
Propose only commands supported by the repository: setup, checks, and service startup/readiness/cleanup if needed. Follow repository instructions and disclose missing capabilities. Use the ralph_save_commands input schema; start revision at 1 or increment the existing revision. Use environment variable names, never secret values.
Show the exact proposed commands with their working directories and any environment, platform, timeout or resource requirements in a readable list. Ask the user whether they approve, then wait for their answer. If they request changes, show the updated proposal and ask again.
Only after the user approves, call ralph_save_commands with exactly the approved configuration. If rejected, save nothing. Do not write the file yourself, execute the proposed commands, run verification, or start a background job. After saving .ralph/commands.json, confirm the path and finish.`;

/** The assistant obtains approval in chat; this tool validates and saves only. */
export async function saveProjectCommands(
  workspace: string,
  input: unknown,
  store: RunStore,
  signal?: AbortSignal,
) {
  const config = parseCommandConfig(input);
  const serialized = JSON.stringify(config);
  if (
    [
      ...runtimeSecretValues(),
      ...referencedSecretValues(
        config.commands.flatMap((command) => Object.values(command.env)),
      ),
    ].some((secret) => serialized.includes(JSON.stringify(secret).slice(1, -1)))
  )
    throw new Error(
      "Use environment variable references instead of secret values",
    );
  signal?.throwIfAborted();
  if (await stat(join(store.root, "active-run.lock")).catch(() => undefined))
    throw new Error(
      "Project commands cannot change during an active feature run",
    );
  const lock = join(store.root, "project-setup.lock");
  await mkdir(lock);
  try {
    const directory = join(await realpath(workspace), ".ralph");
    await mkdir(directory, { recursive: true });
    if ((await realpath(directory)) !== directory)
      throw new Error("Configuration directory must not be a symlink");
    const path = join(directory, "commands.json");
    const previous = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const revision = previous
      ? parseCommandConfig(JSON.parse(previous)).revision + 1
      : 1;
    if (config.revision !== revision)
      throw new Error(
        `Expected command revision ${revision}; read the current file and review the proposal again`,
      );
    const hash = commandConfigHash(config);
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    // Execution pins this revision later; saving does not claim checks have passed.
    const archiveDirectory = join(store.root, "command-revisions");
    await mkdir(archiveDirectory, { recursive: true });
    await writeFile(join(archiveDirectory, `${hash}.json`), contents, {
      flag: "wx",
    }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const temporary = join(directory, `commands-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    await rm(join(directory, "verification.json"), { force: true });
    return { status: "configured" as const, path, revision, hash };
  } finally {
    await rm(lock, { recursive: true });
  }
}
