import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import { readReviewGit } from "../git/review-workspace.js";
import type { RunStore } from "../state/run-store.js";
import { artifactHash, explanationHash } from "./artifacts.js";
import { assertPlanningOwner } from "./completion.js";
import { savePlanning } from "./generation.js";

export const planningFileInput = z
  .object({
    runId: z.string().regex(/^feature-[A-Za-z0-9-]+$/),
    attempt: z.number().int().positive(),
    path: z
      .string()
      .regex(
        /^(PRD\.md|graph\.json|issues\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/,
      ),
    content: z.string().trim().min(1),
  })
  .strict();

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return undefined;
  }
}

/** A stage-relative filename is the entire writable namespace. No source paths. */
export async function writePlanningFile(
  store: RunStore,
  input: z.infer<typeof planningFileInput>,
  sessionId: string,
) {
  const value = planningFileInput.parse(input);
  const { run, state } = await assertPlanningOwner(
    store,
    value.runId,
    value.attempt,
    sessionId,
  );
  if (
    !(
      (state.owner?.stage === "prd" &&
        state.phase === "prd_generation" &&
        !state.prdAcceptance &&
        !state.prd &&
        value.path === "PRD.md") ||
      (state.owner?.stage === "issues" &&
        state.phase === "issue_generation" &&
        !state.issueAcceptance &&
        state.prd &&
        value.path !== "PRD.md")
    ) ||
    !state.approval ||
    !state.explanation ||
    state.approval.hash !== explanationHash(state.explanation) ||
    state.approval.revision !== state.explanation.revision ||
    state.approval.sessionId !== (state.prdAcceptance?.sessionId ?? sessionId)
  )
    throw new Error(
      "Planning writer requires the authorized owning PRD draft stage",
    );
  const config = await loadProjectConfig(state.workspace);
  if (
    commandConfigHash(config.commands) !== state.approval.commandHash ||
    (await readReviewGit(state.workspace, ["rev-parse", "HEAD"])).trim() !==
      state.approval.sha
  )
    throw new Error(
      "Approved commit or configuration changed; renew explanation approval",
    );
  let directory = await realpath(state.workspace);
  for (const part of [
    ".ralph",
    "features",
    value.runId,
    `${state.owner?.stage === "issues" ? "issues" : "prd"}-draft-${value.attempt}`,
    ...(value.path.startsWith("issues/") ? ["issues"] : []),
  ]) {
    directory = join(directory, part);
    const info = await stat(directory);
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new Error(
        "Planning draft ancestors must be real directories, never symlinks",
      );
    if (!info) await mkdir(directory);
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Planning draft symlink escape denied");
  }
  const target = join(directory, value.path.split("/").at(-1) as string);
  const existing = await stat(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile()))
    throw new Error("Planning file symlink or non-file denied");
  const temporary = join(directory, `.write-${randomUUID()}`);
  try {
    await writeFile(temporary, input.content, { flag: "wx" });
    const latest = await assertPlanningOwner(
      store,
      value.runId,
      value.attempt,
      sessionId,
    );
    if (latest.run.revision !== run.revision)
      throw new Error("Stale planning write; retry from current state");
    await rename(temporary, target);
    const next = structuredClone(latest.state);
    const relative = `.ralph/features/${value.runId}/${state.owner?.stage === "issues" ? "issues" : "prd"}-draft-${value.attempt}/${value.path}`;
    next.managedArtifacts = {
      ...next.managedArtifacts,
      [relative]: artifactHash(input.content),
    };
    await savePlanning(store, value.runId, latest.run.revision, next);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    outcome: "accepted",
    path: `.ralph/features/${value.runId}/${state.owner?.stage === "issues" ? "issues" : "prd"}-draft-${value.attempt}/${value.path}`,
  };
}

/** Read only an existing regular draft beneath real run-owned ancestors. */
export async function readPrdDraft(
  workspace: string,
  runId: string,
  attempt: number,
) {
  let path = await realpath(workspace);
  for (const part of [
    ".ralph",
    "features",
    runId,
    `prd-draft-${attempt}`,
    "PRD.md",
  ]) {
    path = join(path, part);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (part === "PRD.md" ? !info.isFile() : !info.isDirectory())
    )
      throw new Error(
        "PRD draft must use real directories and a regular file; symlinks denied",
      );
  }
  return path;
}

/** Confined read for recorded planning outputs, rejecting every symlink ancestor. */
export async function readPlanningArtifact(workspace: string, path: string) {
  if (
    !/^\.ralph\/features\/feature-[A-Za-z0-9-]+\/(?:prd-draft-[1-9][0-9]*|issues-draft-[1-9][0-9]*|prd-[1-9][0-9]*|graph-[1-9][0-9]*)\/(?:PRD\.md|graph\.json|issues\/[A-Za-z0-9_-]+\.md)$/.test(
      path,
    )
  )
    throw new Error("Invalid managed planning artifact path");
  let current = await realpath(workspace);
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      throw new Error("Planning artifact symlink or non-file denied");
  }
  return current;
}
