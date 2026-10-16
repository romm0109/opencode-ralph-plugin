import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
export const git = promisify(execFile);
export async function createTestProject(prefix = "ralph-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await git("git", ["init", directory]);
  await git("git", [
    "-C",
    directory,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await git("git", ["-C", directory, "config", "user.name", "Fixture"]);
  await writeFile(join(directory, "README.md"), "Fixture\n");
  await git("git", ["-C", directory, "add", "."]);
  await git("git", ["-C", directory, "commit", "-m", "fixture"]);
  const commit = (
    await git("git", ["-C", directory, "rev-parse", "HEAD"])
  ).stdout.trim();
  return {
    directory,
    commit,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
