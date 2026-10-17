import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type ApprovedCommandConfig,
  commandConfigHash,
  parseCommandConfig,
} from "../config/commands.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import {
  createApprovedEnvironment,
  disposeEnvironment,
  prepareEnvironment,
} from "../process/environment.js";
import type { CommandResult } from "../process/runner.js";
import type { RunStore } from "../state/run-store.js";
import {
  referencedSecretValues,
  runtimeSecretValues,
} from "../state/sanitize.js";

export interface ProjectSetupOptions {
  workspace: string;
  sessionId: string;
  signal?: AbortSignal;
}
export interface ProjectSetupStatus {
  status: "rejected" | "not-ready" | "configured" | "verified";
  hash?: string;
  revision?: number;
  platform?: string;
  reason?: string;
  results?: CommandResult[];
  cleanupError?: string;
}
async function performSetup(
  options: ProjectSetupOptions & { store: RunStore; adapter: OpenCodeAdapter },
): Promise<ProjectSetupStatus> {
  const { store, adapter, workspace, sessionId, signal } = options;
  signal?.throwIfAborted();
  const runId = `setup-${randomUUID()}`;
  await store.createRun(runId);
  const previous = await readFile(
    join(workspace, ".ralph/commands.json"),
    "utf8",
  ).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  const revision = previous
    ? parseCommandConfig(JSON.parse(previous)).revision + 1
    : 1;
  const instructions = await readFile(
    new URL("../../skills/command-discovery/SKILL.md", import.meta.url),
    "utf8",
  );
  const model = await adapter.getSessionModel?.(sessionId);
  const job = {
    runId,
    jobId: "command-discovery",
    attempt: 1,
    role: "command-discovery",
    workspace: await realpath(workspace),
    inputRevisions: { commands: revision },
    baseCommit: "",
    readOnly: true,
    ...(model ? { model } : {}),
    prompt: `${instructions}\nExplore this repository using read-only tools. Return ONLY a complete JSON command configuration: schemaVersion:1, revision:${revision}, rationale as one non-empty string (never an array), commands with id, phase(setup/check/start/readiness/cleanup), executable, args array, cwd relative to workspace, timeoutMs, platforms(darwin/linux/win32), env mapping target variable names to source variable names; optional explicit shell. Optional resources maps approved environment source names to port, namespace, or directory allocation; commands reference those source names through env. Use exclusiveResources for shared resources that cannot be isolated. Startup without an allocated port is serialized. Missing required isolation capabilities must be disclosed as setup blockers, never invent setup commands. Explain absent scripts honestly in rationale, unsupported platforms in unsupportedPlatforms. Require a check per supported platform; order lifecycle phases. Never execute commands, write files, or include secret values. Only reference environment source names present in this host (or declared allocated resources): ${JSON.stringify(Object.keys(process.env))}. Do not require optional smoke/live opt-in variables unless they are already present. This proposal is not approval.`,
  };
  let config: ApprovedCommandConfig | undefined;
  let proposalError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await adapter.dispatchJob({
      ...job,
      attempt,
      prompt:
        job.prompt +
        (proposalError
          ? `\nCorrect the previous proposal's schema error: ${proposalError.slice(0, 4000)}\nReturn a complete corrected configuration at the same requested revision. rationale must be a non-empty string. This remains a read-only proposal, not approval.`
          : ""),
    });
    // Denial, cancellation and missing host output are not schema repair grants.
    if (result.outcome !== "completed" || !result.text)
      return {
        status: "not-ready",
        reason: result.error?.message ?? "No discovery output",
      };
    try {
      const candidate = parseCommandConfig(JSON.parse(result.text));
      if (candidate.revision !== revision)
        throw new Error("Unexpected command revision");
      config = candidate;
      break;
    } catch (cause) {
      proposalError = String(cause);
    }
  }
  if (!config)
    return {
      status: "not-ready",
      reason: `Discovery proposal invalid after three attempts: ${proposalError}`,
    };
  const references = referencedSecretValues(
    config.commands.flatMap((c) => Object.values(c.env)),
  );
  if (
    [...runtimeSecretValues(), ...references].some((secret) =>
      JSON.stringify(config).includes(JSON.stringify(secret).slice(1, -1)),
    )
  )
    return {
      status: "not-ready",
      reason:
        "Proposal contains a runtime secret value; use environment references",
    };
  const hash = commandConfigHash(config);
  const request = {
    runId,
    sessionId,
    workspace,
    requestId: randomUUID(),
    revision,
    question: `Approve this exact command configuration (hash ${hash}) by replying approve ${hash}, or reject:\n${JSON.stringify(config, null, 2)}`,
  };
  await adapter.publishStatus(sessionId, workspace, request.question);
  const approval = await adapter.requestUserInput(request);
  signal?.throwIfAborted();
  if (!approval.ok)
    return { status: "not-ready", reason: approval.error.message };
  if (
    approval.requestId !== request.requestId ||
    approval.revision !== revision ||
    approval.sessionId !== sessionId ||
    approval.source !== "user" ||
    !approval.messageId ||
    approval.text.trim() !== `approve ${hash}`
  )
    return {
      status: "rejected",
      reason: "Rejected, modified or stale approval",
    };
  const current = await readFile(
    join(workspace, ".ralph/commands.json"),
    "utf8",
  ).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (current !== previous)
    return {
      status: "rejected",
      reason: "Configuration changed while awaiting approval",
    };
  const executionJob = {
    ...job,
    jobId: "command-verification",
    role: "command-verification",
    prompt: `Verify the approved project command configuration ${hash}`,
    sessionId,
    readOnly: false,
  };
  if (!(await store.recordIntent(executionJob)))
    return { status: "not-ready", reason: "Stale verification intent" };
  if (!(await store.attachSession(executionJob, sessionId)))
    return { status: "not-ready", reason: "Stale verification session" };
  const saveOperation = {
    operationId: `commands-${randomUUID()}`,
    kind: "project.commands" as const,
    job: executionJob,
    status: "intent" as const,
    ref: JSON.stringify({
      hash,
      revision,
      requestId: request.requestId,
      sessionId,
      messageId: approval.messageId,
    }),
  };
  if (!(await store.recordOperation(saveOperation)))
    return { status: "not-ready", reason: "Stale configuration save intent" };
  await mkdir(join(workspace, ".ralph"), { recursive: true });
  if (
    (await realpath(join(workspace, ".ralph"))) !==
    join(await realpath(workspace), ".ralph")
  )
    return {
      status: "not-ready",
      reason:
        "Configuration directory must be inside the workspace without symlinks",
    };
  // Keep each approved revision outside the working tree for future run pinning.
  const revisions = join(store.root, "command-revisions");
  await mkdir(revisions, { recursive: true });
  const archive = join(revisions, `${hash}.json`);
  const archived = await readFile(archive, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (archived !== undefined) {
    if (commandConfigHash(parseCommandConfig(JSON.parse(archived))) !== hash)
      throw new Error("Immutable command archive is corrupt");
  } else await atomicJson(archive, config);
  const temporary = join(workspace, `.ralph/commands-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
    });
    signal?.throwIfAborted();
    await rename(temporary, join(workspace, ".ralph/commands.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  if (!(await store.recordOperation({ ...saveOperation, status: "completed" })))
    return {
      status: "not-ready",
      reason: "Stale configuration save completion",
    };
  const environment = createApprovedEnvironment({
    store,
    adapter,
    job: executionJob,
    config,
    signal,
  });
  let reason: string | undefined;
  try {
    signal?.throwIfAborted();
    await prepareEnvironment(environment, executionJob);
  } catch (e) {
    reason = String(e);
  }
  const cleanup = await disposeEnvironment(environment, executionJob).catch(
    (e) => ({ status: "failed", reason: String(e) }),
  );
  const status: ProjectSetupStatus = {
    status: reason || cleanup.status !== "completed" ? "not-ready" : "verified",
    revision,
    hash,
    platform: process.platform,
    results: environment.results,
    ...(reason ? { reason } : {}),
    ...(cleanup.status !== "completed" ? { cleanupError: cleanup.reason } : {}),
  };
  const recorded = await store.recordResult({
    ...executionJob,
    outcome: status.status === "verified" ? "completed" : "failed",
    evidence: environment.results.map((r) => r.commandId),
    text: JSON.stringify(status),
  });
  if (!recorded)
    return { status: "not-ready", reason: "Stale verification completion" };
  await atomicJson(join(workspace, ".ralph/verification.json"), status);
  await adapter.publishStatus(
    sessionId,
    workspace,
    JSON.stringify(status, null, 2),
  );
  return status;
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function projectStatus(
  workspace: string,
): Promise<ProjectSetupStatus> {
  try {
    const config = parseCommandConfig(
      JSON.parse(
        await readFile(join(workspace, ".ralph/commands.json"), "utf8"),
      ),
    );
    const verification = await readFile(
      join(workspace, ".ralph/verification.json"),
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!verification)
      return {
        status: "configured",
        hash: commandConfigHash(config),
        revision: config.revision,
        reason: "Commands saved; execution checks have not run",
      };
    const status = JSON.parse(verification) as ProjectSetupStatus;
    if (
      status.hash !== commandConfigHash(config) ||
      status.platform !== process.platform ||
      status.revision !== config.revision
    )
      return {
        status: "not-ready",
        reason: "Configuration or host differs from verification",
      };
    return status;
  } catch {
    return {
      status: "not-ready",
      reason: "Project commands are not set up",
    };
  }
}
export async function assertProjectReady(workspace: string) {
  const status = await projectStatus(workspace);
  if (status.status !== "verified")
    throw new Error(
      `${status.reason ?? status.cleanupError ?? "Project commands are not verified"}. Run /ralph-commands to discover and approve project commands, then retry.`,
    );
}

/** Saved commands can enter planning; baseline validation runs before execution. */
export async function assertProjectConfigured(workspace: string) {
  const status = await projectStatus(workspace);
  if (status.status !== "configured" && status.status !== "verified")
    throw new Error(
      `${status.reason ?? status.cleanupError ?? "Project commands are not configured"}. Run /ralph-commands to discover and approve project commands, then retry.`,
    );
}

/** Canonical repository lock covers discovery, approval, save and verification. */
export async function setupProject(
  options: ProjectSetupOptions & { store: RunStore; adapter: OpenCodeAdapter },
): Promise<ProjectSetupStatus> {
  const lock = join(options.store.root, "project-setup.lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      return {
        status: "not-ready",
        reason:
          "Project setup is already active; interrupted locks require reconciliation",
      };
    throw e;
  }
  try {
    const result = await performSetup(options);
    await options.adapter.publishStatus(
      options.sessionId,
      options.workspace,
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    await rm(lock, { recursive: true });
  }
}
