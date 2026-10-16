import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function readReviewGit(
  directory: string,
  args: string[],
): Promise<string> {
  return (
    await exec("git", ["-C", directory, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
}
export async function resolveReviewCommit(
  directory: string,
  commit: string,
): Promise<string> {
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commit))
    throw new Error("Review requires an exact commit SHA");
  const resolved = (
    await readReviewGit(directory, [
      "rev-parse",
      "--verify",
      `${commit}^{commit}`,
    ])
  ).trim();
  if (resolved !== commit)
    throw new Error("Review requires a commit object SHA");
  return resolved;
}
export async function pinReviewCommit(
  directory: string,
  ref: string,
  commit: string,
) {
  await readReviewGit(directory, ["update-ref", ref, commit]);
}
export async function createReviewWorkspace(
  directory: string,
  workspace: string,
  commit: string,
) {
  await readReviewGit(directory, [
    "worktree",
    "add",
    "--detach",
    workspace,
    commit,
  ]);
}
export async function verifyReviewWorkspace(workspace: string, commit: string) {
  const head = (await readReviewGit(workspace, ["rev-parse", "HEAD"])).trim();
  const status = await readReviewGit(workspace, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignored",
  ]);
  if (head !== commit || status.trim())
    throw new Error("Reviewer workspace changed from the frozen commit");
}

export async function verifyReviewRepository(
  directory: string,
  repositoryId: string,
) {
  const common = (
    await readReviewGit(directory, ["rev-parse", "--git-common-dir"])
  ).trim();
  if ((await realpath(resolve(directory, common))) !== repositoryId)
    throw new Error("Review directory belongs to a different repository");
}
export async function verifyFindingEvidence(
  workspace: string,
  commit: string,
  evidence: string[],
  refs: string[],
) {
  for (const ref of evidence) {
    if (refs.some((known) => ref === known || ref.startsWith(`${known}:`)))
      return;
    const location = /^(\S+):(\d+)\b/.exec(ref);
    if (!location) continue;
    const path = location[1];
    const line = Number(location[2]);
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      !Number.isSafeInteger(line) ||
      line < 1
    )
      continue;
    try {
      const content = await readReviewGit(workspace, [
        "show",
        `${commit}:${path}`,
      ]);
      if (line <= content.trimEnd().split("\n").length) return;
    } catch {
      /* Try the remaining citations; absent files are not evidence. */
    }
  }
  throw new Error(
    "Blocking finding has no valid evidence location at the reviewed commit",
  );
}

/** Review-owned detached worktree at an exact SHA. */
export const createOwnedWorktree = createReviewWorkspace;
export async function verifyFunctionalWorkspace(
  workspace: string,
  commit: string,
) {
  const head = (await readReviewGit(workspace, ["rev-parse", "HEAD"])).trim();
  const changes = await readReviewGit(workspace, ["diff", "HEAD", "--"]);
  if (head !== commit || changes.trim())
    throw new Error("Functional workspace changed from reviewed commit");
}
