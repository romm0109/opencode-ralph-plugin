import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { JobEnvelope } from "../core/types.js";

/** Execution's approved lifecycle owns command policy and partially started services.
 * No command discovery or config mutation is performed by review. */
export interface CommandResult {
  status: "completed" | "failed" | "timeout" | "cancelled" | "denied";
  evidenceRefs: string[];
  reason?: string;
}
export interface EnvironmentLease {
  url: string;
  evidenceRefs: string[];
  ownerId?: string;
  directory?: string;
  values?: Record<string, string>;
}
export interface ApprovedEnvironment {
  revision: number;
  prepare(job: JobEnvelope): Promise<EnvironmentLease>;
  /** Must also dispose partial startup when prepare throws. */
  dispose(job: JobEnvelope): Promise<CommandResult>;
}
interface OwnedEnvironment {
  environment: ApprovedEnvironment;
  job: JobEnvelope;
  disposal?: Promise<CommandResult>;
  preparation?: Promise<EnvironmentLease>;
}
const active = new Set<OwnedEnvironment>();
const leases = new WeakMap<
  ApprovedEnvironment,
  Map<string, OwnedEnvironment>
>();
function dispose(lease: OwnedEnvironment) {
  if (!lease.disposal) {
    lease.disposal = Promise.resolve().then(() =>
      lease.environment.dispose(lease.job),
    );
    lease.disposal.then(
      (result) => {
        if (result.status === "completed") active.delete(lease);
      },
      () => {},
    );
  }
  return lease.disposal;
}
const environmentJobKey = (job: JobEnvelope) =>
  JSON.stringify([job.runId, job.jobId, job.attempt, job.workspace]);
export function prepareEnvironment(
  environment: ApprovedEnvironment,
  job: JobEnvelope,
) {
  let jobs = leases.get(environment);
  if (!jobs) {
    jobs = new Map();
    leases.set(environment, jobs);
  }
  const key = environmentJobKey(job);
  const existing = jobs.get(key);
  if (existing?.preparation) return existing.preparation;
  const lease: OwnedEnvironment = { environment, job: structuredClone(job) };
  jobs.set(key, lease);
  active.add(lease); // Register partial startup before external work.
  lease.preparation = Promise.resolve().then(() => environment.prepare(job));
  return lease.preparation;
}
export function disposeEnvironment(
  environment: ApprovedEnvironment,
  job: JobEnvelope,
): Promise<CommandResult> {
  const lease = leases.get(environment)?.get(environmentJobKey(job));
  return lease
    ? dispose(lease)
    : Promise.resolve({ status: "completed", evidenceRefs: [] });
}
export async function disposeRunEnvironments(
  runId: string,
  workspaces: string[],
) {
  await Promise.all(
    [...active]
      .filter(
        (lease) =>
          lease.job.runId === runId && workspaces.includes(lease.job.workspace),
      )
      .map(async (lease) => {
        const result = await dispose(lease);
        if (result.status !== "completed")
          throw new Error(
            result.reason ?? `Environment cleanup ${result.status}`,
          );
      }),
  );
}

interface ResourceLease {
  owner: string;
  job: JobEnvelope;
  directory: string;
  values: Record<string, string>;
  ports: number[];
  releases: (() => void)[];
}
const resources = new Map<string, ResourceLease>();
const resourceLocks = new Map<string, Promise<void>>();
const ports = new Set<number>();
const resourceKey = (job: JobEnvelope) =>
  `${job.workspace}:${job.jobId}:${job.attempt}`;
export function allocatedEnvironmentValue(job: JobEnvelope, name: string) {
  return resources.get(resourceKey(job))?.values[name];
}
async function acquireResource(key: string) {
  const previous = resourceLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  resourceLocks.set(key, tail);
  await previous;
  return () => {
    release();
    if (resourceLocks.get(key) === tail) resourceLocks.delete(key);
  };
}
async function allocateResources(
  context: import("./runner.js").CommandContext,
  job: JobEnvelope,
) {
  const owner = randomUUID();
  const lease: ResourceLease = {
    owner,
    job: structuredClone(job),
    directory: join(context.store.root, "environments", owner),
    values: {},
    ports: [],
    releases: [],
  };
  resources.set(resourceKey(job), lease);
  const operation = {
    operationId: `environment-${owner}`,
    kind: "execution.environment" as const,
    status: "intent" as const,
    job: structuredClone(job),
    environment: {
      ownerId: owner,
      directory: lease.directory,
      values: {},
      exclusiveResources: context.config.exclusiveResources ?? [],
    },
  };
  if (!(await context.store.recordOperation(operation)))
    throw new Error("Stale resource allocation");
  const exclusive = [...(context.config.exclusiveResources ?? [])];
  if (
    context.config.commands.some(
      (c) =>
        c.phase === "start" && c.platforms.some((p) => p === process.platform),
    ) &&
    !Object.values(context.config.resources ?? {}).includes("port")
  )
    exclusive.push("unisolated-services");
  for (const name of [...new Set(exclusive)].sort())
    lease.releases.push(
      await acquireResource(`${context.store.repositoryId}:${name}`),
    );
  const current = await context.store.getRun(job.runId);
  if (current?.control && current.control.status !== "active")
    throw new Error("Run inactive while waiting for resources");
  await mkdir(lease.directory, { recursive: true });
  for (const [name, kind] of Object.entries(context.config.resources ?? {})) {
    if (kind === "namespace") lease.values[name] = `ralph-${owner}`;
    else if (kind === "directory") lease.values[name] = lease.directory;
    else {
      let port: number;
      do {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Port allocation unavailable");
        port = address.port;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } while (ports.has(port));
      ports.add(port);
      lease.ports.push(port);
      lease.values[name] = String(port);
    }
  }
  job.environment = { ...lease.values };
  if (
    !(await context.store.recordOperation({
      ...operation,
      status: "completed",
      environment: {
        ownerId: owner,
        directory: lease.directory,
        values: { ...lease.values },
        exclusiveResources: exclusive,
      },
    }))
  )
    throw new Error("Stale resource allocation completion");
  return lease;
}
async function releaseResources(
  store: import("../state/run-store.js").RunStore,
  lease: ResourceLease,
) {
  if (resources.get(resourceKey(lease.job))?.owner !== lease.owner) return;
  const operation = {
    operationId: `environment-cleanup-${lease.owner}`,
    kind: "execution.environment.cleanup" as const,
    status: "intent" as const,
    job: lease.job,
    environment: {
      ownerId: lease.owner,
      directory: lease.directory,
      values: { ...lease.values },
      exclusiveResources: [],
    },
  };
  if (!(await store.recordOperation(operation)))
    throw new Error("Resource cleanup intent was rejected");
  await rm(lease.directory, { recursive: true, force: true });
  for (const port of lease.ports) ports.delete(port);
  for (const release of lease.releases) release();
  resources.delete(resourceKey(lease.job));
  if (!(await store.recordOperation({ ...operation, status: "completed" })))
    throw new Error("Resource cleanup completion was rejected");
}

/** Approved lifecycle implementation shared by setup and review consumers. */
export function createApprovedEnvironment(
  context: import("./runner.js").CommandContext,
  options: { skipChecks?: boolean } = {},
): ApprovedEnvironment & { results: import("./runner.js").CommandResult[] } {
  const results: import("./runner.js").CommandResult[] = [];
  const owned: import("./ownership.js").OwnedProcess[] = [];
  const applicable = context.config.commands.filter((c) =>
    c.platforms.some((p) => p === process.platform),
  );
  let cleanup: Promise<CommandResult> | undefined;
  let preparing: Promise<EnvironmentLease> | undefined;
  return {
    revision: context.config.revision,
    results,
    prepare(job) {
      if (preparing) return preparing;
      preparing = (async () => {
        const { runCommand } = await import("./runner.js");
        if (!applicable.some((c) => c.phase === "check"))
          throw new Error(`Unsupported host platform ${process.platform}`);
        const allocation = await allocateResources(context, job);
        for (const command of applicable.filter(
          (c) =>
            c.phase !== "cleanup" &&
            !(options.skipChecks && c.phase === "check"),
        )) {
          const started = Date.now();
          let result: import("./runner.js").CommandResult;
          do {
            const deadline =
              command.phase === "readiness"
                ? AbortSignal.timeout(
                    Math.max(1, command.timeoutMs - (Date.now() - started)),
                  )
                : undefined;
            result = await runCommand(command, {
              ...context,
              job,
              signal: deadline
                ? context.signal
                  ? AbortSignal.any([context.signal, deadline])
                  : deadline
                : context.signal,
            });
            if (deadline?.aborted && !context.signal?.aborted)
              result = { ...result, status: "timed_out" };
            // Run the exact approved spec; retries share a bounded readiness deadline.
            if (result.ownedProcess && command.phase === "start")
              owned.push(result.ownedProcess);
            if (
              command.phase !== "readiness" ||
              result.status !== "completed" ||
              result.exitCode === 0 ||
              result.cause ||
              result.cleanupError
            )
              break;
            if (Date.now() - started >= command.timeoutMs) {
              result = { ...result, status: "timed_out" };
              break;
            }
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(50, command.timeoutMs - (Date.now() - started)),
              ),
            );
          } while (Date.now() - started < command.timeoutMs);
          if (
            command.phase === "readiness" &&
            result.status === "completed" &&
            result.exitCode !== 0 &&
            !result.cause
          )
            result = { ...result, status: "timed_out" };
          results.push(result);
          if (
            result.status !== "completed" ||
            result.exitCode !== 0 ||
            result.cleanupError
          )
            throw new Error(
              `${command.phase}: ${command.id} ${result.status}${result.cause ? ` (${result.cause.message})` : ` (exit ${result.exitCode})`}`,
            );
        }
        return {
          url: context.config.url ?? "",
          ownerId: allocation.owner,
          directory: allocation.directory,
          values: { ...allocation.values },
          evidenceRefs: results.map((r) => r.commandId),
        };
      })();
      return preparing;
    },
    dispose(job) {
      if (!cleanup)
        cleanup = (async () => {
          await preparing?.catch(() => {});
          const { runCommand } = await import("./runner.js");
          const { terminateOwnedProcess } = await import("./ownership.js");
          const errors: string[] = [];
          for (const command of applicable.filter(
            (c) => c.phase === "cleanup",
          )) {
            try {
              const result = await runCommand(command, {
                ...context,
                job,
                signal: undefined,
              });
              results.push(result);
              if (
                result.status !== "completed" ||
                result.exitCode !== 0 ||
                result.cleanupError
              )
                errors.push(
                  `cleanup: ${command.id} ${result.status} exit ${result.exitCode}`,
                );
            } catch (e) {
              errors.push(String(e));
            }
          }
          for (const process of owned)
            if (!(await terminateOwnedProcess(process)))
              errors.push(`cleanup: owned process ${process.pid} remains`);
          const lease = resources.get(resourceKey(job));
          if (!errors.length && lease) {
            try {
              await releaseResources(context.store, lease);
            } catch (cause) {
              errors.push(String(cause));
            }
          }
          return {
            status: errors.length ? "failed" : "completed",
            evidenceRefs: results.map((r) => r.commandId),
            ...(errors.length ? { reason: errors.join("; ") } : {}),
          } as CommandResult;
        })();
      return cleanup;
    },
  };
}
