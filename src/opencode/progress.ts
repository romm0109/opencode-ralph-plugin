import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandConfigHash } from "../config/commands.js";
import { loadProjectConfig } from "../config/project.js";
import type { RunRecord } from "../core/types.js";
import { projectRunSnapshot } from "../dashboard/projections.js";
import type { RunStore } from "../state/run-store.js";
import { runtimeSecretValues, sanitizeValue } from "../state/sanitize.js";

export const MAX_PROGRESS_CHARS = 16000;

function visibleOwner(run: RunRecord) {
  return run.planning?.protocol === "native-interview-v1"
    ? run.planning.owner?.sessionId
    : undefined;
}
async function progressView(run: RunRecord) {
  let commands:
    | {
        revision?: number;
        selected?: {
          id: string;
          phase: string;
          executable: string;
          args: string[];
        }[];
        unavailable?: string;
      }
    | undefined;
  if (run.baseline && run.planning) {
    try {
      const config = (await loadProjectConfig(run.planning.workspace)).commands;
      commands =
        commandConfigHash(config) === run.planning.commandHash
          ? {
              revision: config.revision,
              selected: config.commands.map((c) => ({
                id: c.id,
                phase: c.phase,
                executable: c.executable,
                args: c.args,
              })),
            }
          : {
              unavailable:
                "Command configuration changed; inspect baseline blocker",
            };
    } catch {
      commands = {
        unavailable:
          "Approved command configuration unavailable; inspect baseline status",
      };
    }
  }
  const snapshot = projectRunSnapshot(run, 0, runtimeSecretValues());
  return sanitizeValue(
    {
      commands,
      completion: snapshot.completion && {
        ...snapshot.completion,
        retainedResources: run.reviewWorkflow?.report?.retainedResources,
        findings: run.reviewWorkflow?.report?.findings,
      },
      planning: snapshot.planning,
      control: snapshot.control,
      baseline: run.baseline && {
        status: run.baseline.status,
        blocker: run.baseline.blocker,
        error: run.baseline.error?.message,
        commandRevision: run.baseline.commandRevision,
      },
      agents: snapshot.agents.map((a) => ({
        ...a,
        result:
          run.jobs[a.jobId]?.result?.text === undefined
            ? undefined
            : sanitizeValue(
                run.jobs[a.jobId]?.result?.text ?? "",
                runtimeSecretValues(),
              ).slice(0, 2000),
      })),
      issues: snapshot.issues,
      checks: snapshot.checks,
      review: snapshot.reviewRounds,
      errors: snapshot.errors,
    },
    runtimeSecretValues(),
  );
}
const SECTION_LABELS: Record<string, string> = {
  commands: "Commands",
  completion: "Result",
  planning: "Stage",
  control: "Run",
  baseline: "Baseline",
  agents: "Agents",
  issues: "Issues",
  checks: "Checks",
  review: "Review",
  errors: "Errors",
};
function scalar(value: unknown) {
  return value === null || typeof value !== "object";
}
function readable(value: unknown, indent = ""): string[] {
  if (value === null || value === undefined) return [];
  if (scalar(value)) return [`${indent}${String(value)}`];
  if (Array.isArray(value))
    return value.flatMap((item) => {
      if (scalar(item)) return [`${indent}- ${String(item)}`];
      const entries = Object.entries(item as object).filter(
        ([, v]) => v !== null && v !== undefined,
      );
      if (entries.every(([, v]) => scalar(v)))
        return [
          `${indent}- ${entries.map(([k, v]) => `${k}: ${v}`).join(", ")}`,
        ];
      const [first, ...rest] = readable(item, `${indent}  `);
      return first ? [`${indent}- ${first.trimStart()}`, ...rest] : [];
    });
  return Object.entries(value as object).flatMap(([key, v]) => {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length))
      return [];
    if (scalar(v)) return [`${indent}${key}: ${String(v)}`];
    const nested = readable(v, `${indent}  `);
    return nested.length ? [`${indent}${key}:`, ...nested] : [];
  });
}
/** One line a person can read at a glance; also used as the chat entry title. */
export function progressHeadline(
  view: Awaited<ReturnType<typeof progressView>>,
) {
  if (view.completion)
    return `Ralph finished: ${view.completion.outcome} (${view.completion.branch})`;
  if (view.control && view.control.status !== "active")
    return `Ralph ${view.control.status}`;
  const planning = view.planning;
  if (!planning) return "Ralph progress";
  const reason = planning.waitingReason ? ` — ${planning.waitingReason}` : "";
  return `Ralph ${planning.stage}: ${planning.status}${reason}`;
}
function formatProgress(
  view: Awaited<ReturnType<typeof progressView>>,
  changed: Record<string, unknown>,
) {
  return [
    progressHeadline(view),
    ...Object.entries(changed).flatMap(([key, value]) => {
      const body = readable(value, "  ");
      return body.length ? [`${SECTION_LABELS[key] ?? key}:`, ...body] : [];
    }),
  ].join("\n");
}
type Cursor = {
  sequence: number;
  sessionId: string;
  view: Awaited<ReturnType<typeof progressView>>;
};

/** Observes committed state only. It never calls a stage, prompt, or scheduler. */
export function createProgressObserver(options: {
  store: RunStore;
  directory: string;
  deliver: (message: {
    runId: string;
    sessionId: string;
    id: string;
    text: string;
  }) => Promise<void>;
}) {
  const { store, directory, deliver } = options;
  const root = join(store.root, "chat-progress");
  let stopped = false;
  let running: Promise<void> | undefined;
  async function observe() {
    let location: string;
    try {
      location = await realpath(directory);
    } catch (cause) {
      // A location module can outlive successful owned-worktree cleanup.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    await mkdir(root, { recursive: true });
    for (const run of await store.listRuns()) {
      if (stopped || !visibleOwner(run) || !run.planning) continue;
      // Linked worktrees share a journal, but never share visible chat ownership.
      try {
        if ((await realpath(run.planning.workspace)) !== location) continue;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw cause;
      }
      const path = join(root, `${run.runId}.json`);
      let cursor: Cursor | undefined;
      try {
        cursor = JSON.parse(await readFile(path, "utf8"));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      for (const event of (
        await store.events(run.runId, { afterSequence: cursor?.sequence ?? 0 })
      )
        .filter((event) => visibleOwner(event.snapshot) === visibleOwner(run))
        .slice(0, 100)) {
        if (stopped) return;
        const sessionId = visibleOwner(event.snapshot);
        if (!sessionId) continue;
        // Re-read before delivery: retired owners cannot receive queued progress.
        const current = await store.getRun(run.runId);
        if (
          !current ||
          visibleOwner(current) !== sessionId ||
          current.planning?.workspace !== run.planning.workspace
        )
          continue;
        const view = await progressView(event.snapshot);
        const changed = Object.fromEntries(
          Object.entries(view).filter(
            ([key, value]) =>
              cursor?.sessionId !== sessionId ||
              JSON.stringify(value) !==
                JSON.stringify(cursor.view[key as keyof typeof view]),
          ),
        );
        if (Object.keys(changed).length) {
          const text = sanitizeValue(
            formatProgress(view, changed),
            runtimeSecretValues(),
          );
          await deliver({
            runId: run.runId,
            sessionId,
            id: `msg_ralph-progress-${run.runId}-${event.sequence}`,
            text:
              text.length > MAX_PROGRESS_CHARS
                ? `${text.slice(0, MAX_PROGRESS_CHARS - 60)}\n[Progress truncated; full evidence in Ralph status/logs.]`
                : text,
          });
        }
        cursor = { sequence: event.sequence, sessionId, view };
        // Separate observation checkpoint: never invalidate execution revisions.
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(
          temp,
          JSON.stringify(sanitizeValue(cursor, runtimeSecretValues())),
        );
        await rename(temp, path);
      }
    }
  }
  return {
    flush() {
      if (stopped) return Promise.resolve();
      running ??= observe().finally(() => {
        running = undefined;
      });
      return running;
    },
    async stop() {
      stopped = true;
      await running?.catch(() => {});
    },
  };
}
