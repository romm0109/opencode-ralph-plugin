import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JobEnvelope } from "../core/types.js";
import type { RunStore } from "../state/run-store.js";
import { bunRuntime } from "./runtime.js";

const exec = promisify(execFile);
export interface OwnedProcess {
  pid: number;
  startedAt: string;
  ownerToken: string;
  workspace: string;
  repositoryId: string;
}
export async function processIdentity(
  pid: number,
): Promise<{ startedAt: string; command: string } | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid PID");
  try {
    if (process.platform === "win32") {
      const result = await exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ startedAt = $p.CreationDate.ToUniversalTime().ToString('o'); command = $p.CommandLine } | ConvertTo-Json -Compress }`,
      ]);
      return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
    }
    const startedAt = (
      await exec("ps", ["-p", String(pid), "-o", "lstart="])
    ).stdout.trim();
    const command = (
      await exec("ps", ["-ww", "-p", String(pid), "-o", "command="])
    ).stdout.trim();
    return startedAt ? { startedAt, command } : undefined;
  } catch (cause) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    throw cause; // Inspection failure is never proof of ownership or death.
  }
}
export async function inspectOwnedProcess(
  record: OwnedProcess,
): Promise<{ status: "owned" | "gone" | "unrelated" | "unknown" }> {
  try {
    const actual = await processIdentity(record.pid);
    if (!actual) return { status: "gone" };
    return {
      status:
        actual.startedAt === record.startedAt &&
        actual.command.includes(record.ownerToken) &&
        actual.command.includes(record.workspace) &&
        actual.command.includes(record.repositoryId)
          ? "owned"
          : "unrelated",
    };
  } catch {
    return { status: "unknown" };
  }
}
export async function terminateOwnedProcess(
  record: OwnedProcess,
): Promise<boolean> {
  const state = await inspectOwnedProcess(record);
  if (state.status === "gone") return true;
  if (state.status !== "owned") return false;
  try {
    if (process.platform === "win32")
      await exec("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"]);
    else process.kill(-record.pid, "SIGTERM");
    for (let i = 0; i < 40; i++) {
      if ((await inspectOwnedProcess(record)).status === "gone") return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if ((await inspectOwnedProcess(record)).status !== "owned") return false;
    if (process.platform !== "win32") process.kill(-record.pid, "SIGKILL");
    return (await inspectOwnedProcess(record)).status === "gone";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
/** Called only by approved command/environment owners. Intent precedes launch. */
export async function startOwnedProcess(
  store: RunStore,
  job: JobEnvelope,
  executable: string,
  args: string[],
): Promise<OwnedProcess> {
  const parent = await processIdentity(process.pid);
  if (!parent) throw new Error("Parent identity unavailable");
  const ownerToken = randomUUID();
  const operation = {
    operationId: `process-${ownerToken}`,
    kind: "process.spawn" as const,
    job,
    status: "intent" as const,
  };
  if (!(await store.recordOperation(operation)))
    throw new Error("Duplicate process intent");
  const child = spawn(
    bunRuntime(),
    [
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./owned-child.ts"
            : "./owned-child.js",
          import.meta.url,
        ),
      ),
      String(process.pid),
      parent.startedAt,
      ownerToken,
      job.workspace,
      store.repositoryId,
      executable,
      ...args,
    ],
    {
      cwd: job.workspace,
      detached: process.platform !== "win32",
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("Owned child has no PID");
  const identity = await processIdentity(child.pid);
  if (!identity) throw new Error("Owned child exited during launch");
  const ownedProcess = {
    pid: child.pid,
    startedAt: identity.startedAt,
    ownerToken,
    workspace: job.workspace,
    repositoryId: store.repositoryId,
  };
  child.unref();
  await store.recordOperation({
    ...operation,
    status: "completed",
    ownedProcess,
  });
  const control = (await store.getRun(job.runId))?.control;
  if (control && !["active", "paused"].includes(control.status)) {
    await terminateOwnedProcess(ownedProcess);
    throw new Error("Process launch interrupted; artifacts retained");
  }
  return ownedProcess;
}
