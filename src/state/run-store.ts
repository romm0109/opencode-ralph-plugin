import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type {
  ExecutionEvidence,
  JobEnvelope,
  JobResult,
  RunControl,
  RunEvent,
  RunOperation,
  RunRecord,
} from "../core/types.js";
import { reconcileReadiness } from "../execution/readiness.js";
import { executionEligibilityMatchesRevision } from "../planning/approvals.js";
import { explanationHash, issueBundleHash } from "../planning/artifacts.js";
import { validateIssueGraph } from "../planning/graph.js";
import type { PlanningState } from "../planning/types.js";
import { processIdentity } from "../process/ownership.js";
import type { ReviewWorkflow } from "../reporting/completion.js";
import type { FunctionalReviewResult } from "../review/functional-results.js";
import type { ReviewResult, StoredReview } from "../review/types.js";
import {
  runtimeSecretValues,
  sanitizeDisplay,
  sanitizeValue,
} from "./sanitize.js";

const exec = promisify(execFile);
const id = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw new Error("Invalid run/job ID");
  return value;
};
export interface RunStore {
  readonly root: string;
  readonly repositoryId: string;
  createRun(runId: string): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  events(
    runId: string,
    options?: { latest?: boolean; afterSequence?: number },
  ): Promise<RunEvent[]>;
  recordIssueAttempt(
    runId: string,
    revision: number,
    attempt: import("../execution/execute-issue.js").IssueAttempt,
  ): Promise<boolean>;
  recoverCancelledAttempt(
    runId: string,
    revision: number,
    issueId: string,
    abortId: string,
  ): Promise<boolean>;
  recoverIssueAttempt(
    runId: string,
    revision: number,
    issueId: string,
    advanceId: string,
  ): Promise<boolean>;
  recordBaseline(
    runId: string,
    revision: number,
    baseline: NonNullable<RunRecord["baseline"]>,
    skips: string[],
  ): Promise<boolean>;
  recordPlanning(
    runId: string,
    revision: number,
    planning: PlanningState,
  ): Promise<boolean>;
  recordControl(
    runId: string,
    control: RunControl,
    revision?: number,
  ): Promise<boolean>;
  recordReviewWorkflow(
    runId: string,
    revision: number,
    workflow: ReviewWorkflow,
  ): Promise<boolean>;
  recordExecution(
    runId: string,
    revision: number,
    execution: ExecutionEvidence,
  ): Promise<boolean>;
  reopenReview(runId: string, revision: number): Promise<boolean>;
  recordReviewSnapshot(
    runId: string,
    revision: number,
    review: StoredReview,
  ): Promise<boolean>;
  recordReviewResult(
    runId: string,
    snapshot: StoredReview["snapshot"],
    result: ReviewResult,
    summary: string,
  ): Promise<boolean>;
  recordJobEvidence(
    job: JobEnvelope,
    evidence: import("../opencode/adapter.js").JobToolEvidence,
  ): Promise<boolean>;
  recordIntent(job: JobEnvelope): Promise<boolean>;
  attachSession(job: JobEnvelope, sessionId: string): Promise<boolean>;
  recordResult(result: JobResult): Promise<boolean>;
  recordFunctionalReviewResult(
    runId: string,
    snapshot: StoredReview["snapshot"],
    result: FunctionalReviewResult,
  ): Promise<boolean>;
  recordOperation(operation: RunOperation): Promise<boolean>;
}
export async function openRunStore(
  directory: string,
  options: { secrets?: readonly string[]; now?: () => number } = {},
): Promise<RunStore> {
  const now = options.now ?? Date.now;
  const secrets = [...runtimeSecretValues(), ...(options.secrets ?? [])];
  const common = (
    await exec("git", ["-C", directory, "rev-parse", "--git-common-dir"])
  ).stdout.trim();
  const repositoryId = await realpath(resolve(directory, common));
  const root = join(repositoryId, "ralph", "runs");
  await mkdir(root, { recursive: true });
  const journal = join(root, "events.jsonl");
  const owner = await processIdentity(process.pid);
  if (!owner) throw new Error("Run store owner identity unavailable");
  const ownerStart = owner.startedAt;
  async function recoverLock(lock: string) {
    const guard = `${lock}.recovery`;
    try {
      await mkdir(guard);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
      throw e;
    }
    try {
      const raw = await readFile(join(lock, "owner.json"), "utf8");
      const recorded = JSON.parse(raw) as {
        pid: number;
        startedAt: string;
        repositoryId: string;
        token: string;
      };
      if (
        recorded.repositoryId !== repositoryId ||
        !recorded.startedAt ||
        !recorded.token
      )
        return;
      const live = await processIdentity(recorded.pid);
      if (live && live.startedAt === recorded.startedAt) return;
      if ((await readFile(join(lock, "owner.json"), "utf8")) !== raw) return;
      await rm(lock, { recursive: true });
    } catch {
      /* Missing/corrupt owner or unavailable inspection is ambiguous; never steal. */
    } finally {
      await rm(guard, { recursive: true });
    }
  }
  let journalCache:
    | {
        identity: string;
        prefixLength: number;
        prefixHash: string;
        events: RunEvent[];
      }
    | undefined;
  const journalIdentity = (value: import("node:fs").BigIntStats) =>
    [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
  async function readEvents(): Promise<RunEvent[]> {
    const cached = journalCache;
    let before: string;
    let raw: string;
    try {
      before = journalIdentity(await stat(journal, { bigint: true }));
      if (cached?.identity === before) return cached.events;
      raw = await readFile(journal, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        journalCache = undefined;
        return [];
      }
      throw e;
    }
    // A torn final append is not committed. Reuse only a verified unchanged
    // prefix; replacement, truncation and rewrites require a full replay.
    const prefix = raw.slice(0, raw.lastIndexOf("\n") + 1);
    const hashPrefix = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const reuse =
      cached &&
      prefix.length >= cached.prefixLength &&
      hashPrefix(prefix.slice(0, cached.prefixLength)) === cached.prefixHash;
    const events = reuse ? [...cached.events] : [];
    const tail = reuse ? prefix.slice(cached.prefixLength) : prefix;
    for (const line of tail.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as RunEvent;
      if (
        event.sequence !== events.length + 1 ||
        event.schemaVersion !== 1 ||
        event.snapshot.repositoryId !== repositoryId
      )
        throw new Error("Invalid run journal");
      // Linked OpenCode locations each own a store. Keep historical snapshots
      // compressed; ordinary state reads expand only the latest requested run.
      const compressed = deflateRawSync(JSON.stringify(event.snapshot), {
        level: 1,
      });
      const { snapshot: _snapshot, ...metadata } = event;
      events.push(
        Object.defineProperty(metadata, "snapshot", {
          enumerable: true,
          get: () => JSON.parse(inflateRawSync(compressed).toString("utf8")),
        }) as RunEvent,
      );
    }
    const after = journalIdentity(await stat(journal, { bigint: true }));
    // Do not associate bytes with metadata from an append racing this read.
    if (before === after && journalCache === cached)
      journalCache = {
        identity: after,
        prefixLength: prefix.length,
        prefixHash: hashPrefix(prefix),
        events,
      };
    return events;
  }
  async function update(
    runId: string,
    type: RunEvent["type"],
    apply: (run: RunRecord | undefined) => RunRecord | undefined,
    job?: JobEnvelope,
  ) {
    id(runId);
    const lock = join(root, "write.lock");
    // Cross-instance serialization; replacement requires a proven dead birth identity.
    for (let retry = 0; ; retry++) {
      try {
        try {
          await access(`${lock}.recovery`);
          if (retry >= 100) throw new Error("Lock recovery owner uncertain");
          await new Promise((r) => setTimeout(r, 20));
          continue;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await mkdir(lock);
        const metadata = await open(join(lock, "owner.json"), "wx");
        try {
          await metadata.writeFile(
            JSON.stringify({
              pid: process.pid,
              startedAt: ownerStart,
              repositoryId,
              token: randomUUID(),
            }),
          );
          await metadata.sync();
        } finally {
          await metadata.close();
        }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || retry >= 100)
          throw e;
        await recoverLock(lock);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      const events = await readEvents();
      const previous = events.filter((e) => e.runId === runId).at(-1)?.snapshot;
      const next = apply(previous ? structuredClone(previous) : undefined);
      if (!next) return false;
      next.revision = (previous?.revision ?? 0) + 1;
      const event: RunEvent = {
        schemaVersion: 1,
        runId,
        sequence: events.length + 1,
        revision: next.revision,
        eventId: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        snapshot: next,
        ...(job
          ? {
              jobId: job.jobId,
              attempt: job.attempt,
              commit: job.baseCommit,
              ...(job.sessionId ? { sessionId: job.sessionId } : {}),
            }
          : {}),
      };
      const file = await open(journal, "a+");
      try {
        const raw = await file.readFile("utf8");
        const committedBytes = Buffer.byteLength(
          raw.slice(0, raw.lastIndexOf("\n") + 1),
        );
        await file.truncate(committedBytes);
        await file.write(`${JSON.stringify(event)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      const temp = join(root, `${runId}.${randomUUID()}.tmp`);
      const snapshot = await open(temp, "wx");
      try {
        await snapshot.writeFile(JSON.stringify(next));
        await snapshot.sync();
      } finally {
        await snapshot.close();
      }
      await rename(temp, join(root, `${runId}.json`));
      return true;
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  const store: RunStore = {
    root,
    repositoryId,
    async getRun(runId) {
      id(runId);
      return structuredClone(
        (await readEvents()).filter((e) => e.runId === runId).at(-1)?.snapshot,
      );
    },
    async listRuns() {
      const latest = new Map<string, RunEvent>();
      for (const event of await readEvents()) latest.set(event.runId, event);
      return structuredClone(
        [...latest.values()].map((event) => event.snapshot),
      );
    },
    async events(runId, options = {}) {
      let events = (await readEvents()).filter((e) => e.runId === runId);
      if (options.latest) events = events.slice(-1);
      else if (options.afterSequence !== undefined) {
        const after = options.afterSequence;
        if (!Number.isSafeInteger(after) || after < 0)
          throw new Error("Invalid event cursor");
        events = events.filter((event) => event.sequence > after);
      }
      return structuredClone(events);
    },
    async createRun(runId) {
      await update(runId, "run.created", (run) =>
        run
          ? undefined
          : {
              schemaVersion: 1,
              runId,
              repositoryId,
              revision: 0,
              phase: "ready",
              jobs: {},
              errors: [],
              operations: {},
            },
      );
      const run = await store.getRun(runId);
      if (!run) throw new Error("Run creation failed");
      return run;
    },
    recordIssueAttempt(runId, revision, attempt) {
      return update(runId, "issue.changed", (run) => {
        if (
          !run ||
          run.revision !== revision ||
          (run.control && !["active", "paused"].includes(run.control.status)) ||
          (run.control?.status === "paused" &&
            (run.issueAttempts?.[attempt.issueId]?.operationId !==
              attempt.operationId ||
              run.issueAttempts?.[attempt.issueId]?.job.jobId !==
                attempt.job.jobId ||
              run.issueAttempts?.[attempt.issueId]?.attempt !==
                attempt.attempt))
        )
          return undefined;
        run.issueAttempts ??= {};
        run.issueAttempts[attempt.issueId] = sanitizeValue(attempt, secrets);
        if (run.execution && run.planning?.graph && run.planning.prd)
          run.execution = reconcileReadiness(
            run,
            run.execution.integrationQueue,
          );
        run.phase = "running";
        return run;
      });
    },
    recoverCancelledAttempt(runId, revision, issueId, abortId) {
      return update(runId, "issue.changed", (run) => {
        const attempt = run?.issueAttempts?.[issueId];
        const abort = run?.operations[abortId];
        const entry = attempt && run?.jobs[attempt.job.jobId];
        if (
          !run ||
          run.revision !== revision ||
          run.control?.status !== "interrupted" ||
          run.control.source !== "recovery" ||
          !run.control.cleanupPending ||
          attempt?.status !== "executing" ||
          attempt.submission ||
          attempt.candidate ||
          entry?.status !== "terminal" ||
          entry.result?.outcome !== "cancelled" ||
          entry.envelope.attempt !== attempt.attempt ||
          !entry.envelope.sessionId ||
          abort?.kind !== "session.abort" ||
          abort.status !== "completed" ||
          abort.job.jobId !== entry.envelope.jobId ||
          abort.job.attempt !== attempt.attempt ||
          abort.job.sessionId !== entry.envelope.sessionId
        )
          return undefined;
        attempt.status = "failed";
        attempt.executionResult = entry.result;
        attempt.error = {
          code: "cancelled",
          message:
            "Interrupted executor proven idle during recovery; attempt consumed, workspace retained",
        };
        if (run.execution && run.planning?.graph && run.planning.prd)
          run.execution = reconcileReadiness(
            run,
            run.execution.integrationQueue,
          );
        return run;
      });
    },
    recoverIssueAttempt(runId, revision, issueId, advanceId) {
      return update(runId, "issue.changed", (run) => {
        const attempt = run?.issueAttempts?.[issueId];
        const advance = run?.operations[advanceId];
        if (
          !run ||
          run.revision !== revision ||
          run.control?.status !== "interrupted" ||
          !run.control.cleanupPending ||
          !attempt ||
          attempt.status !== "merging" ||
          advance?.kind !== "integration.advance" ||
          advance.status !== "completed" ||
          advance.job.jobId !== attempt.candidate?.job.jobId ||
          advance.job.attempt !== attempt.attempt ||
          !advance.expectedNew ||
          advance.expectedNew !== attempt.candidate?.commit
        )
          return undefined;
        attempt.status = "integrated";
        attempt.integratedCommit = advance.expectedNew;
        if (run.execution && run.planning?.graph && run.planning.prd)
          run.execution = reconcileReadiness(run, []);
        return run;
      });
    },
    recordBaseline(runId, revision, baseline, skips) {
      return update(runId, "baseline.changed", (run) => {
        if (
          !run ||
          run.revision !== revision ||
          (run.control && run.control.status !== "active")
        )
          return undefined;
        run.baseline = sanitizeValue(baseline, secrets);
        run.validationSkips = [
          ...new Set([...(run.validationSkips ?? []), ...skips]),
        ];
        return run;
      });
    },
    recordPlanning(runId, revision, planning) {
      return update(runId, "planning.changed", (run) => {
        if (
          !run ||
          run.revision !== revision ||
          (run.control && run.control.status !== "active")
        )
          return undefined;
        if (
          run.planning?.protocol === "native-interview-v1" &&
          planning.protocol !== run.planning.protocol
        )
          throw new Error(
            "Unsupported planning protocol; native ownership cannot be replaced.",
          );
        if (planning.protocol !== "native-interview-v1")
          throw new Error(
            "Unsupported planning protocol; no migration is available.",
          );
        if (planning.protocol === "native-interview-v1") {
          const owner = planning.owner;
          const old = run.planning;
          if (
            !owner ||
            !["interview", "prd", "issues"].includes(owner.stage) ||
            !Number.isSafeInteger(owner.attempt) ||
            owner.attempt < 1 ||
            owner.sessionId !== planning.sessionId ||
            (planning.pending &&
              planning.pending.sessionId !== owner.sessionId) ||
            (old &&
              (old.protocol !== planning.protocol ||
                (old.owner?.sessionId !== owner.sessionId &&
                  !(
                    (old.issueHandoff?.sessionId === owner.sessionId ||
                      (old.owner?.retired &&
                        old.owner.stage === "issues" &&
                        owner.attempt === old.owner.attempt + 1)) &&
                    owner.stage === "issues" &&
                    planning.issueHandoff?.sessionId === owner.sessionId
                  )) ||
                (old.owner?.attempt !== owner.attempt &&
                  !(
                    owner.stage === "issues" &&
                    old.owner?.stage !== "issues" &&
                    owner.attempt === 1
                  ) &&
                  !(
                    old.owner?.retired &&
                    owner.stage === old.owner.stage &&
                    owner.attempt === old.owner.attempt + 1 &&
                    planning.attempts?.at(-1)?.attempt === owner.attempt
                  ))))
          )
            throw new Error("Stale or invalid interview stage ownership");
        }
        const next = sanitizeValue(planning, [
          ...secrets,
          ...runtimeSecretValues(),
        ]);
        if (next.explanation) {
          next.explanation.hash = explanationHash(next.explanation);
          const old = run.planning?.explanation;
          if (
            old &&
            (old.hash !== next.explanation.hash ||
              old.revision !== next.explanation.revision)
          ) {
            if (
              !next.history?.some(
                (entry) => entry.explanation?.revision === old.revision,
              )
            )
              next.history = [
                ...(next.history ?? []),
                {
                  explanation: old,
                  approval: run.planning?.approval,
                  prd:
                    run.planning?.prd ?? run.planning?.prdAcceptance?.revision,
                  graph:
                    run.planning?.graph ?? run.planning?.issueAcceptance?.graph,
                  executionEligibility: run.planning?.executionEligibility,
                },
              ];
            delete next.publication;
            next.explanation.revision = Math.max(
              next.explanation.revision,
              old.revision + 1,
            );
            delete next.approval;
            delete next.prdDelivery;
            delete next.prdAcceptance;
            delete next.issueAcceptance;
            delete next.issueHandoff;
            if (next.owner) next.owner.stage = "interview";
            delete next.executionEligibility;
            delete next.prd;
            delete next.graph;
            next.phase = "explanation_approval";
            if (next.pending?.requestId === run.planning?.pending?.requestId)
              delete next.pending;
          }
          if (
            next.approval &&
            (next.approval.hash !== next.explanation.hash ||
              next.approval.revision !== next.explanation.revision)
          )
            delete next.approval;
        } else delete next.approval;
        if (next.phase === "explanation_approved" && !next.approval)
          next.phase = "explanation_approval";
        if (next.protocol === "native-interview-v1" && next.approval) {
          const approved = next.approval;
          const context = next.proposalContext;
          if (
            !context ||
            approved.sha !== context.sha ||
            approved.branch !== context.branch ||
            approved.commandHash !== context.commandHash ||
            approved.commandRevision !== context.commandRevision ||
            approved.sessionId !==
              (next.prdAcceptance?.sessionId ?? next.owner?.sessionId)
          )
            delete next.approval;
        }
        if (!next.approval) {
          delete next.executionEligibility;
          delete next.prdDelivery;
          if (next.owner?.stage === "prd") {
            next.owner.stage = "interview";
            next.phase = "explanation_approval";
          }
        }
        if (next.graph && next.prd) {
          next.graph.hash = issueBundleHash(next.graph.value, next.graph.files);
          const oldGraph = run.planning?.graph;
          const oldPrd = run.planning?.prd;
          if (
            (oldGraph &&
              (oldGraph.hash !== next.graph.hash ||
                oldGraph.revision !== next.graph.revision)) ||
            (oldPrd &&
              (oldPrd.hash !== next.prd.hash ||
                oldPrd.revision !== next.prd.revision ||
                oldPrd.artifactPath !== next.prd.artifactPath))
          ) {
            delete next.executionEligibility;
            if (next.phase === "execution_approved")
              next.phase = "execution_approval";
            if (next.pending?.requestId === run.planning?.pending?.requestId)
              delete next.pending;
            if (
              oldGraph &&
              (oldGraph.hash !== next.graph.hash ||
                oldGraph.revision !== next.graph.revision)
            )
              next.graph.revision = Math.max(
                next.graph.revision,
                oldGraph.revision + 1,
              );
          }
          if (next.executionEligibility) {
            validateIssueGraph(next.graph.value, next.graph.files, next.prd);
            if (
              next.executionEligibility.prdHash !== next.prd.hash ||
              next.executionEligibility.graphHash !== next.graph.hash ||
              next.executionEligibility.revision !== next.graph.revision
            )
              delete next.executionEligibility;
          }
        } else delete next.executionEligibility;
        if (
          next.executionEligibility &&
          !executionEligibilityMatchesRevision(next)
        )
          delete next.executionEligibility;
        if (next.phase === "execution_approved" && !next.executionEligibility)
          next.phase = "execution_approval";
        const enteringNativeWait =
          (!!next.pending && !run.planning?.pending) ||
          (!!next.nativeQuestions?.length &&
            !run.planning?.nativeQuestions?.length);
        for (const attempt of next.attempts ?? []) {
          if (enteringNativeWait && attempt.status === "active") {
            const previous = run.planning?.attempts?.find(
              (a) => a.job.jobId === attempt.job.jobId,
            );
            if (
              previous &&
              !previous.suspended &&
              previous.observedAt !== undefined
            )
              attempt.remainingMs = Math.max(
                0,
                previous.remainingMs - Math.max(0, now() - previous.observedAt),
              );
            attempt.suspended = true;
            delete attempt.observedAt;
          }
          const accepted =
            attempt.stage === "prd" ? next.prdAcceptance : next.issueAcceptance;
          if (
            attempt.job.inputRevisions.explanation ===
              next.explanation?.revision &&
            accepted?.attempt === attempt.attempt &&
            accepted.sessionId === attempt.sessionId &&
            attempt.status === "active"
          ) {
            attempt.status = "accepted";
            const job = run.jobs[attempt.job.jobId];
            if (job) {
              job.status = "terminal";
              job.result = {
                ...job.envelope,
                outcome: "completed",
                evidence: ["Stage completion tool accepted"],
              };
            }
          }
          if (
            attempt.status === "active" &&
            (attempt.job.inputRevisions.explanation !==
              next.explanation?.revision ||
              attempt.stage !== next.owner?.stage ||
              attempt.sessionId !== next.owner.sessionId ||
              attempt.attempt !== next.owner.attempt)
          ) {
            attempt.status = "retired";
            attempt.reason = {
              code: "cancelled",
              message:
                "Planning authority superseded by an authorized stage or scope transition",
            };
            const job = run.jobs[attempt.job.jobId];
            if (job) {
              job.status = "terminal";
              job.result = {
                ...job.envelope,
                outcome: "cancelled",
                evidence: [attempt.reason.message],
              };
            }
          }
          if (
            attempt.status === "active" &&
            attempt.suspended &&
            !next.pending &&
            !next.nativeQuestions?.length &&
            !next.revisionProposal &&
            ((attempt.stage === "prd" && next.phase === "prd_generation") ||
              (attempt.stage === "issues" && next.phase === "issue_generation"))
          ) {
            attempt.suspended = false;
            attempt.observedAt = now();
          }
        }
        run.planning = next;
        run.phase = "running";
        return run;
      });
    },
    recordControl(runId, control, revision) {
      return update(runId, "run.control", (run) => {
        if (!run || (revision !== undefined && run.revision !== revision))
          return undefined;
        // A restart/stop invalidates outstanding callbacks. Explicit resume creates
        // fresh human-input identities without changing answers or attempt budgets.
        if (
          control.status === "active" &&
          ["interrupted", "stopped"].includes(run.control?.status ?? "")
        ) {
          for (const attempt of Object.values(run.issueAttempts ?? {})) {
            if (
              attempt.status === "waiting" &&
              attempt.question &&
              !attempt.question.answer
            ) {
              attempt.question.epoch = run.control?.epoch ?? 0;
              attempt.question.request.requestId = randomUUID();
              delete attempt.question.error;
            }
          }
        }
        for (const attempt of run.planning?.attempts ?? []) {
          if (attempt.status === "active") {
            if (
              ["stopped", "blocked"].includes(control.status) ||
              (control.status === "interrupted" &&
                control.source !== "recovery")
            ) {
              attempt.status = "retired";
              attempt.reason = {
                code: "cancelled",
                message: `Planning attempt retired by ${control.status}`,
              };
              if (
                run.planning?.owner?.stage === attempt.stage &&
                run.planning.owner.attempt === attempt.attempt
              )
                run.planning.owner.retired = true;
            }
            attempt.suspended =
              control.status !== "active" ||
              !!run.planning?.pending ||
              !!run.planning?.nativeQuestions?.length ||
              !!run.planning?.revisionProposal;
            if (attempt.suspended) delete attempt.observedAt;
            else {
              attempt.observedAt = now();
              attempt.controlEpoch = run.control?.epoch ?? 0;
            }
          }
        }
        run.control = {
          ...structuredClone(control),
          epoch:
            (run.control?.epoch ?? 0) +
            (["stopped", "interrupted", "blocked"].includes(control.status)
              ? 1
              : 0),
        };
        return run;
      });
    },
    recordReviewWorkflow(runId, revision, workflow) {
      return update(runId, "review.workflow", (run) => {
        if (
          !run ||
          ["stopped", "interrupted", "blocked"].includes(
            run.control?.status ?? "",
          ) ||
          run.revision !== revision ||
          run.reviewWorkflow?.status === "terminal" ||
          (run.reviewWorkflow &&
            run.reviewWorkflow.ownerId !== workflow.ownerId) ||
          workflow.rounds.length > 3 ||
          workflow.rounds.some(
            (round, index) => round.snapshot.round !== index + 1,
          )
        )
          return undefined;
        run.reviewWorkflow = sanitizeValue(workflow, [
          ...secrets,
          ...runtimeSecretValues(),
        ]);
        run.phase =
          workflow.status === "terminal"
            ? workflow.report?.outcome === "unresolved"
              ? "failed"
              : "completed"
            : "running";
        return run;
      });
    },
    recordExecution(runId, revision, execution) {
      return update(runId, "execution.observed", (run) => {
        if (
          !run ||
          run.revision !== revision ||
          ["stopped", "interrupted", "blocked"].includes(
            run.control?.status ?? "",
          )
        )
          return undefined;
        run.execution = structuredClone(execution);
        // Any new execution evidence supersedes the frozen review round.
        if (run.review) run.review.superseded = true;
        for (const check of run.execution.checks)
          if (check.reason)
            check.reason = sanitizeDisplay(check.reason, secrets);
        for (const issue of run.execution.issues)
          issue.title = sanitizeDisplay(issue.title, secrets);
        return run;
      });
    },
    reopenReview(runId, revision) {
      return update(runId, "review.workflow", (run) => {
        const workflow = run?.reviewWorkflow;
        const snapshot = run?.review?.snapshot;
        if (
          !run ||
          run.revision !== revision ||
          run.control?.status !== "active" ||
          run.control.source !== "human" ||
          workflow?.status !== "terminal" ||
          workflow.report?.outcome !== "unverified" ||
          workflow.report.cleanupFailures.length ||
          workflow.rounds.length >= 3 ||
          !snapshot ||
          snapshot.round !== workflow.rounds.length + 1 ||
          snapshot.commit !== workflow.commit ||
          !run.review ||
          !run.operations[`review-pin-${snapshot.round}`] ||
          run.operations[`review-pin-${snapshot.round}`]?.status !==
            "completed" ||
          Object.values(run.jobs).some((job) => job.status !== "terminal")
        )
          return undefined;
        // The old terminal report remains immutable in the journal. A new owner
        // invalidates stale finalizers and gets a distinct terminal release ID.
        workflow.ownerId = randomUUID();
        workflow.status = "running";
        delete workflow.report;
        workflow.rounds.push({
          snapshot,
          repairs: [],
          disputes: [],
          validation: structuredClone(run.review.inputs.execution),
        });
        run.control.epoch = (run.control.epoch ?? 0) + 1;
        run.phase = "running";
        return run;
      });
    },
    recordReviewSnapshot(runId, revision, review) {
      return update(runId, "review.snapshot", (run) => {
        if (
          !run ||
          ["stopped", "interrupted", "blocked"].includes(
            run.control?.status ?? "",
          ) ||
          run.revision !== revision ||
          (run.review && run.review.snapshot.round >= review.snapshot.round)
        )
          return undefined;
        run.review = structuredClone(review);
        if (run.review.inputs.tddEvidence)
          run.review.inputs.tddEvidence = sanitizeValue(
            run.review.inputs.tddEvidence,
            secrets,
          );
        if (run.execution) run.execution.verification = "incomplete";
        run.phase = "running";
        return run;
      });
    },
    recordReviewResult(runId, snapshot, result, summary) {
      return update(runId, "review.result", (run) => {
        const current = run?.review;
        const job = run?.jobs[`code-review-${snapshot.round}`];
        if (
          !run ||
          !current ||
          ["stopped", "interrupted", "blocked"].includes(
            run.control?.status ?? "",
          ) ||
          current.superseded ||
          current.result ||
          !isDeepStrictEqual(current.snapshot, snapshot) ||
          result.reviewedCommit !== snapshot.commit ||
          result.round !== snapshot.round ||
          job?.status !== "terminal" ||
          job.envelope.sessionId !== result.sessionId
        )
          return undefined;
        current.result = structuredClone(result);
        for (const finding of current.result.findings) {
          finding.criterion = sanitizeDisplay(finding.criterion, secrets);
          finding.suggestedRepair = sanitizeDisplay(
            finding.suggestedRepair,
            secrets,
          );
          finding.evidence = finding.evidence.map((ref) =>
            sanitizeDisplay(ref, secrets),
          );
        }
        current.result.evidenceRefs = current.result.evidenceRefs.map((ref) =>
          sanitizeDisplay(ref, secrets),
        );
        if (current.result.error) {
          current.result.error.message = sanitizeDisplay(
            current.result.error.message,
            secrets,
          );
          run.errors.push(current.result.error);
        }
        current.summary = sanitizeDisplay(summary, secrets);
        run.phase = "running";
        return run;
      });
    },
    recordFunctionalReviewResult(runId, snapshot, result) {
      return update(runId, "review.result", (run) => {
        if (
          !run?.review ||
          ["stopped", "interrupted", "blocked"].includes(
            run.control?.status ?? "",
          ) ||
          run.review.superseded ||
          run.review.functionalResult ||
          !isDeepStrictEqual(run.review.snapshot, snapshot) ||
          result.reviewedCommit !== snapshot.commit ||
          result.round !== snapshot.round ||
          (result.sessionId !== undefined &&
            (run.jobs[`functional-review-${snapshot.round}`]?.status !==
              "terminal" ||
              run.jobs[`functional-review-${snapshot.round}`]?.envelope
                .sessionId !== result.sessionId))
        )
          return undefined;
        run.review.functionalResult = sanitizeValue(result, [
          ...secrets,
          ...runtimeSecretValues(),
        ]);
        return run;
      });
    },
    recordIntent(job) {
      id(job.jobId);
      return update(
        job.runId,
        "job.intent",
        (run) => {
          if (!run) throw new Error("Unknown run");
          if (run.planning && run.planning.protocol !== "native-interview-v1")
            throw new Error(
              "Unsupported saved workflow; a fresh workflow is required",
            );
          if (run.control && run.control.status !== "active") return undefined;
          if (
            ["code-review", "functional-review"].includes(job.role) &&
            (!run.review ||
              run.review.superseded ||
              run.review.snapshot.round !== job.inputRevisions.round ||
              run.review.snapshot.commit !== job.baseCommit)
          )
            return undefined;
          const previous = run.jobs[job.jobId];
          if (
            previous &&
            (previous.envelope.attempt >= job.attempt ||
              previous.status !== "terminal")
          )
            return undefined;
          run.jobs[job.jobId] = { envelope: job, status: "intent" };
          run.phase = "running";
          return run;
        },
        job,
      );
    },
    attachSession(job, sessionId) {
      return update(
        job.runId,
        "job.session",
        (run) => {
          const entry = run?.jobs[job.jobId];
          if (
            ["code-review", "functional-review"].includes(job.role) &&
            (!run?.review ||
              run.review.superseded ||
              run.review.snapshot.round !== job.inputRevisions.round ||
              run.review.snapshot.commit !== job.baseCommit)
          )
            return undefined;
          if (
            !run ||
            !entry ||
            entry.envelope.attempt !== job.attempt ||
            entry.status !== "intent" ||
            ["stopped", "interrupted", "blocked"].includes(
              run.control?.status ?? "",
            )
          )
            return undefined;
          entry.envelope.sessionId = sessionId;
          entry.status = "running";
          return run;
        },
        { ...job, sessionId },
      );
    },
    recordOperation(operation) {
      id(operation.operationId);
      return update(
        operation.job.runId,
        operation.status === "intent" ? "operation.intent" : "operation.result",
        (run) => {
          if (!run) throw new Error("Unknown run");
          if (
            operation.status === "intent" &&
            run.control &&
            run.control.status !== "active" &&
            ![
              "session.abort",
              "review.cleanup",
              "baseline.cleanup",
              "execution.environment.cleanup",
              ...(operation.kind === "run.release" &&
              run.control.status === "stopped" &&
              !run.control.cleanupPending &&
              !run.control.facts?.length &&
              !run.baseline &&
              !Object.keys(run.issueAttempts ?? {}).length
                ? ["run.release"]
                : []),
            ].includes(operation.kind)
          )
            return undefined;
          const existing = run.operations[operation.operationId];
          if (
            existing &&
            (existing.status !== "intent" ||
              (operation.status === "intent" &&
                !(
                  existing.kind === "process.spawn" &&
                  operation.kind === "process.spawn" &&
                  !existing.ownedProcess &&
                  operation.ownedProcess
                )))
          )
            return undefined;
          if (!existing && operation.status !== "intent")
            throw new Error("Operation has no intent");
          if (
            existing &&
            (!isDeepStrictEqual(existing.job, operation.job) ||
              existing.kind !== operation.kind ||
              existing.ref !== operation.ref ||
              existing.expectedOld !== operation.expectedOld ||
              existing.expectedNew !== operation.expectedNew)
          )
            return undefined;
          run.operations[operation.operationId] = operation;
          if (operation.error) run.errors.push(operation.error);
          return run;
        },
        operation.job,
      );
    },
    recordJobEvidence(job, evidence) {
      return update(
        job.runId,
        "job.evidence",
        (run) => {
          const entry = run?.jobs[job.jobId];
          if (
            !run ||
            !entry ||
            entry.nativeEvidence ||
            entry.status !== "terminal" ||
            entry.envelope.attempt !== job.attempt ||
            entry.result?.outcome !== "completed" ||
            entry.envelope.sessionId !== evidence.sessionId ||
            !evidence.resultMessageId ||
            !entry.result.evidence.includes(evidence.resultMessageId) ||
            evidence.source !== "opencode.session.context" ||
            !evidence.promptMessageId ||
            !evidence.observations.length
          )
            return undefined;
          entry.nativeEvidence = sanitizeValue(evidence, secrets);
          return run;
        },
        job,
      );
    },
    recordResult(result) {
      result = structuredClone(result);
      if (result.text !== undefined)
        result.text = sanitizeDisplay(result.text, secrets);
      if (result.error)
        result.error.message = sanitizeDisplay(result.error.message, secrets);
      result.evidence = result.evidence.map((value) =>
        sanitizeDisplay(value, secrets),
      );
      return update(
        result.runId,
        "job.result",
        (run) => {
          const entry = run?.jobs[result.jobId];
          if (
            ["code-review", "functional-review"].includes(result.role) &&
            (!run?.review ||
              run.review.superseded ||
              run.review.snapshot.round !== result.inputRevisions.round ||
              run.review.snapshot.commit !== result.baseCommit)
          )
            return undefined;
          if (
            !run ||
            !entry ||
            entry.status === "terminal" ||
            (result.outcome !== "cancelled" &&
              ["stopped", "interrupted", "blocked"].includes(
                run.control?.status ?? "",
              )) ||
            entry.envelope.attempt !== result.attempt ||
            entry.envelope.sessionId !== result.sessionId
          )
            return undefined;
          if (
            result.baseCommit !== entry.envelope.baseCommit ||
            result.workspace !== entry.envelope.workspace
          )
            return undefined;
          entry.status = "terminal";
          entry.result = result;
          run.lastResult = result;
          run.phase =
            ["code-review", "functional-review"].includes(result.role) ||
            (!!result.issueId &&
              !!run.issueAttempts?.[result.issueId] &&
              ["executor", "merger"].includes(result.role))
              ? "running"
              : result.outcome === "needs_input"
                ? "running"
                : result.outcome === "denied"
                  ? "failed"
                  : result.outcome;
          if (result.error) run.errors.push(result.error);
          return run;
        },
        result,
      );
    },
  };
  return store;
}
