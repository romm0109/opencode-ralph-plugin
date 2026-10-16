import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApprovedCommandConfig,
  type CommandSpec,
  commandConfigHash,
  parseCommandConfig,
} from "../config/commands.js";
import type { JobEnvelope } from "../core/types.js";
import { type Clock, systemClock } from "../execution/attempts.js";
import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import {
  referencedSecretValues,
  runtimeSecretValues,
  sanitizeDisplay,
} from "../state/sanitize.js";
import { allocatedEnvironmentValue } from "./environment.js";
import {
  type OwnedProcess,
  processIdentity,
  terminateOwnedProcess,
} from "./ownership.js";
import { bunRuntime } from "./runtime.js";

export interface CommandResult {
  status:
    | "completed"
    | "timed_out"
    | "cancelled"
    | "permission_denied"
    | "setup_failed"
    | "spawn_error";
  commandId: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  cause?: { code?: string; message: string };
  ownedProcess?: OwnedProcess;
  cleanupError?: string;
}
export interface CommandContext {
  store: RunStore;
  adapter: OpenCodeAdapter;
  job: JobEnvelope;
  config: ApprovedCommandConfig;
  signal?: AbortSignal | undefined;
  clock?: Clock;
  sourceWorkspace?: string;
  /** Main-session permission owner before an executor session exists. */
  permissionSessionId?: string;
}
export async function runCommand(
  command: CommandSpec,
  context: CommandContext,
): Promise<CommandResult> {
  const { store, adapter, job, config, signal } = context;
  const hash = commandConfigHash(config);
  const base = { commandId: command.id, stdout: "", stderr: "" };
  if (signal?.aborted) return { ...base, status: "cancelled" };
  const platform = process.platform;
  const secrets = [
    ...runtimeSecretValues(),
    ...referencedSecretValues(Object.values(command.env)),
  ].filter(Boolean);
  const clean = (s: string) => sanitizeDisplay(s, secrets);
  let permission: Awaited<
    ReturnType<NonNullable<OpenCodeAdapter["authorizeCommand"]>>
  >;
  try {
    permission = (await adapter.authorizeCommand?.({
      job: context.permissionSessionId
        ? { ...job, sessionId: context.permissionSessionId }
        : job,
      command,
      hash,
    })) ?? {
      ok: false,
    };
  } catch (error) {
    permission = {
      ok: false,
      error: { code: "permission-denied", message: clean(String(error)) },
    };
  }
  if (!permission.ok)
    return {
      ...base,
      status: "permission_denied",
      cause: {
        message: clean(
          permission.error?.message ??
            "Host command execution permission is unavailable",
        ),
      },
    };
  let cwd: string;
  const env: NodeJS.ProcessEnv = {};
  // Keep only portable system variables and explicitly approved references.
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
  ])
    if (process.env[name]) env[name] = process.env[name];
  try {
    const saved = parseCommandConfig(
      JSON.parse(
        await readFile(
          join(
            context.sourceWorkspace ?? job.workspace,
            ".ralph/commands.json",
          ),
          "utf8",
        ),
      ),
    );
    if (
      commandConfigHash(saved) !== hash ||
      !config.commands.some(
        (c) => JSON.stringify(c) === JSON.stringify(command),
      )
    )
      throw new Error("Command is not in the saved approved revision");
    if (!command.platforms.some((p) => p === platform))
      throw new Error(`Command unsupported on ${platform}`);
    const root = await realpath(job.workspace);
    cwd = await realpath(resolve(root, command.cwd));
    const location = relative(root, cwd);
    if (
      isAbsolute(location) ||
      location === ".." ||
      location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    )
      throw new Error("Command cwd escapes workspace");
    for (const [target, source] of Object.entries(command.env)) {
      const value = config.resources?.[source]
        ? allocatedEnvironmentValue(job, source)
        : process.env[source];
      if (value === undefined)
        throw new Error(
          `Missing environment reference or allocation ${source}`,
        );
      env[target] = value;
    }
  } catch (error) {
    return {
      ...base,
      status: "setup_failed",
      exitCode: null,
      cause: { message: clean(String(error)) },
    };
  }
  const parent = await processIdentity(process.pid).catch(() => undefined);
  if (!parent)
    return {
      ...base,
      status: "cancelled",
      cause: { message: "Parent identity unavailable" },
    };
  const ownerToken = randomUUID();
  const operation = {
    operationId: `command-${ownerToken}`,
    kind: "process.spawn" as const,
    job: { ...job, workspace: cwd },
    status: "intent" as const,
  };
  if (!(await store.recordOperation(operation)))
    return {
      ...base,
      status: "cancelled",
      cause: { message: "Stale operation" },
    };
  const control = (await store.getRun(job.runId))?.control;
  if (control && control.status !== "active")
    return { ...base, status: "cancelled" };
  const child = spawn(
    bunRuntime(),
    [
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./command-child.ts"
            : "./command-child.js",
          import.meta.url,
        ),
      ),
      String(process.pid),
      parent.startedAt,
      ownerToken,
      cwd,
      store.repositoryId,
      command.shell ?? "",
      command.executable,
      ...command.args,
    ],
    {
      cwd,
      env,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "",
    stderr = "",
    stdoutOverflow = false,
    stderrOverflow = false;
  // Redact after complete collection so secrets split across chunks cannot escape.
  child.stdout?.on("data", (chunk) => {
    if (stdoutOverflow) return;
    stdoutOverflow = stdout.length + chunk.length > 65536;
    stdout = stdoutOverflow
      ? "[output exceeded limit]"
      : stdout + chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    if (stderrOverflow) return;
    stderrOverflow = stderr.length + chunk.length > 65536;
    stderr = stderrOverflow
      ? "[output exceeded limit]"
      : stderr + chunk.toString();
  });
  let owned: OwnedProcess | undefined;
  let cancelCompletion = () => {};
  const completion = new Promise<CommandResult>((finish) => {
    let done = false;
    const end = (result: CommandResult) => {
      if (done) return;
      done = true;
      disposeTimer();
      signal?.removeEventListener("abort", abort);
      finish(result);
    };
    const abort = () => end({ ...base, status: "cancelled" });
    cancelCompletion = abort;
    const disposeTimer = (context.clock ?? systemClock).schedule(
      command.timeoutMs,
      () =>
        end({ ...base, status: signal?.aborted ? "cancelled" : "timed_out" }),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("message", (message: unknown) => {
      const value = message as {
        type?: string;
        code?: number | string | null;
        message?: string;
        stdout?: string;
        stderr?: string;
      };
      if (value.type === "started" && command.phase === "start")
        end({ ...base, status: "completed", exitCode: 0 });
      if (value.type === "exit") {
        if (
          typeof value.stdout !== "string" ||
          typeof value.stderr !== "string"
        ) {
          end({
            ...base,
            status: "spawn_error",
            exitCode: null,
            cause: { message: "Owned wrapper omitted final output receipt" },
          });
          return;
        }
        stdout = value.stdout;
        stderr = value.stderr;
        // Ignore late pipe events: these same bytes are already in the receipt.
        stdoutOverflow = true;
        stderrOverflow = true;
        end({
          ...base,
          status: "completed",
          exitCode: typeof value.code === "number" ? value.code : null,
        });
      }
      if (value.type === "error")
        end({
          ...base,
          status: "spawn_error",
          exitCode: null,
          cause: {
            code: String(value.code),
            message: clean(value.message ?? "Spawn failed"),
          },
        });
    });
    child.once("error", (e: NodeJS.ErrnoException) =>
      end({
        ...base,
        status: "spawn_error",
        exitCode: null,
        cause: {
          ...(e.code ? { code: e.code } : {}),
          message: clean(e.message),
        },
      }),
    );
    child.once("exit", () =>
      end({
        ...base,
        status: "spawn_error",
        exitCode: null,
        cause: { message: "Owned wrapper exited before result collection" },
      }),
    );
  });
  if (child.pid) {
    const identity = await processIdentity(child.pid).catch(() => undefined);
    if (identity)
      owned = {
        pid: child.pid,
        startedAt: identity.startedAt,
        ownerToken,
        workspace: cwd,
        repositoryId: store.repositoryId,
      };
  }
  if (owned) {
    // Publish live ownership so /ralph-stop can terminate the tree while waiting.
    try {
      if (!(await store.recordOperation({ ...operation, ownedProcess: owned })))
        cancelCompletion();
    } catch (cause) {
      cancelCompletion();
      await terminateOwnedProcess(owned);
      throw cause;
    }
  }
  let result = await completion;
  result = {
    ...result,
    stdout: clean(stdout),
    stderr: clean(stderr),
    ...(owned ? { ownedProcess: owned } : {}),
  };
  if (!owned) {
    if (platform === "win32" && child.pid)
      await new Promise<void>((resolve) =>
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], () =>
          resolve(),
        ),
      );
    else child.kill();
    result = {
      ...result,
      exitCode: null,
      cause: { message: "Process ownership could not be established" },
    };
  }
  if (
    owned &&
    (command.phase !== "start" ||
      result.status !== "completed" ||
      result.exitCode !== 0 ||
      signal?.aborted)
  ) {
    if (!(await terminateOwnedProcess(owned)))
      result.cleanupError = "Owned process cleanup failed";
    if (child.connected) child.disconnect();
  } else {
    child.unref();
    child.channel?.unref?.();
  }
  const latestControl = (await store.getRun(job.runId))?.control;
  if (
    ["stopped", "interrupted", "blocked"].includes(latestControl?.status ?? "")
  )
    result = { ...result, status: "cancelled" };
  let recorded: boolean;
  try {
    recorded = await store.recordOperation({
      ...operation,
      status:
        result.status === "completed" &&
        result.exitCode === 0 &&
        !result.cleanupError
          ? "completed"
          : "failed",
      ...(owned ? { ownedProcess: owned } : {}),
    });
  } catch (error) {
    if (owned) await terminateOwnedProcess(owned);
    throw error;
  }
  if (!recorded) {
    if (owned) await terminateOwnedProcess(owned);
    return {
      ...result,
      status: "cancelled",
      cause: { message: "Stale completion" },
    };
  }
  return result;
}
