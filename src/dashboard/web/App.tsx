import { useEffect, useState } from "react";
import type { LogPage, RunSnapshot } from "../projections.js";
import type { DashboardApi, RunSummary } from "./api.js";

function State({ value }: { value: string }) {
  return <span className={`state ${value}`}>{value.replaceAll("_", " ")}</span>;
}
function Logs({
  api,
  runId,
  logId,
}: {
  api: DashboardApi;
  runId: string;
  logId: string;
}) {
  const [page, setPage] = useState<LogPage>();
  const [error, setError] = useState("");
  const read = (offset: number) => {
    api
      .log(runId, logId, offset)
      .then(setPage)
      .catch((e) => setError(String(e)));
  };
  // The component is keyed by log identity, so an old response cannot replace another log.
  useEffect(() => {
    let active = true;
    api
      .log(runId, logId, 0)
      .then((p) => {
        if (active) setPage(p);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api, runId, logId]);
  return (
    <section aria-label="Logs">
      <h3>Log {logId}</h3>
      {error && <p role="alert">{error}</p>}
      <pre>{page?.content ?? "Loading log…"}</pre>
      <p>
        {page &&
          `Characters ${page.offset}–${page.offset + page.content.length} of ${page.total}${page.truncated ? " (bounded; remaining output omitted)" : ""}`}
      </p>
      <button
        type="button"
        disabled={!page || page.offset === 0}
        onClick={() => read(Math.max(0, (page?.offset ?? 0) - 4096))}
      >
        Previous log page
      </button>{" "}
      <button
        type="button"
        disabled={page?.nextOffset == null}
        onClick={() => read(page?.nextOffset ?? 0)}
      >
        Next log page
      </button>
    </section>
  );
}
export function App({ api }: { api: DashboardApi }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState("");
  const [snapshot, setSnapshot] = useState<RunSnapshot>();
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const [log, setLog] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api
        .runs()
        .then((items) => {
          if (active) {
            setRuns(items);
            setRunId((current) => current || items.at(-1)?.runId || "");
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let sequence = 0;
    let stream: AbortController | undefined;
    const offline = () => {
      stream?.abort();
      setConnection("reconnecting");
    };
    window.addEventListener("offline", offline);
    setSnapshot(undefined);
    setLog("");
    setError("");
    const receive = (next: RunSnapshot) => {
      if (!controller.signal.aborted) {
        sequence = next.sequence;
        setSnapshot(next);
        setConnection("connected");
      }
    };
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          if (!sequence) receive(await api.snapshot(runId));
          stream = new AbortController();
          await api.subscribe(
            runId,
            sequence,
            AbortSignal.any([controller.signal, stream.signal]),
            receive,
          );
        } catch (e) {
          if (controller.signal.aborted) return;
          setConnection("reconnecting");
          setError(String(e));
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 500);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    })();
    return () => {
      window.removeEventListener("offline", offline);
      controller.abort();
    };
  }, [api, runId]);
  return (
    <main>
      <header>
        <p className="eyebrow">RALPH · READ ONLY</p>
        <h1>Execution dashboard</h1>
        <output>Connection: {connection}</output>
        <label>
          Run{" "}
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            <option value="">Select a run</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.runId}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error && connection !== "connected" && <p role="alert">{error}</p>}
      {!runId && <p>No persisted runs yet.</p>}
      {snapshot && (
        <>
          <section>
            <h2>{snapshot.runId}</h2>
            <p>
              Phase: <State value={snapshot.phase} />
              {snapshot.control && (
                <>
                  {" "}
                  · Control: <State value={snapshot.control.status} />
                </>
              )}{" "}
              · Revision {snapshot.revision} · Event {snapshot.sequence}
            </p>
            {snapshot.planning && (
              <section aria-label="Planning stage">
                <h3>Planning stage: {snapshot.planning.stage}</h3>
                <p>
                  <State value={snapshot.planning.status} /> · Attempt{" "}
                  {snapshot.planning.owner.attempt} · Session{" "}
                  {snapshot.planning.owner.sessionId}
                </p>
                {snapshot.planning.waitingReason && (
                  <p>{snapshot.planning.waitingReason}</p>
                )}
                {snapshot.planning.attempts.map((a) => (
                  <p key={`${a.stage}-${a.attempt}`}>
                    {a.stage} attempt {a.attempt}: <State value={a.status} />
                    {a.reason && ` · ${a.reason}`}
                  </p>
                ))}
              </section>
            )}
            <p>
              Verification: <State value={snapshot.verification} />
            </p>
            {snapshot.errors.map((e) => (
              <p key={`${e.code}-${e.message}`}>
                {e.code}: {e.message}
              </p>
            ))}
          </section>
          <section aria-label="Dependency graph">
            <h2>Dependency graph</h2>
            {!snapshot.executionAvailable && (
              <p>Execution graph evidence unavailable.</p>
            )}
            <div className="graph">
              {snapshot.issues.map((issue) => (
                <article key={issue.id}>
                  <h3>
                    {issue.id}: {issue.title}
                  </h3>
                  <State value={issue.status} />
                  <p>
                    Dependencies: {issue.dependencies.join(" → ") || "none"}
                  </p>
                  {issue.blockers.length > 0 && (
                    <p>Blocked by: {issue.blockers.join(", ")}</p>
                  )}
                </article>
              ))}
            </div>
          </section>
          <section>
            <h2>Agents and attempts</h2>
            {!snapshot.agents.length && <p>No agent evidence.</p>}
            {snapshot.agents.map((agent) => (
              <article key={`${agent.jobId}-${agent.attempt}`}>
                <h3>
                  {agent.issueId ?? agent.jobId} · {agent.role}
                </h3>
                <p>
                  Attempt {agent.attempt} · Session{" "}
                  {agent.sessionId ?? "waiting"} ·{" "}
                  <State value={agent.status} />
                </p>
                <p>
                  Base commit: <code>{agent.baseCommit}</code> · Input
                  revisions: <code>{JSON.stringify(agent.inputRevisions)}</code>
                </p>
                <p>Evidence: {agent.evidence.join(", ") || "unavailable"}</p>
                {agent.error && (
                  <p>
                    {agent.error.code}: {agent.error.message}
                  </p>
                )}
                {agent.logId && (
                  <button
                    type="button"
                    onClick={() => setLog(agent.logId ?? "")}
                  >
                    View log {agent.jobId}
                  </button>
                )}
              </article>
            ))}
          </section>
          <section aria-label="Review report">
            <h2>Review report</h2>
            {snapshot.completion && (
              <>
                <p>
                  Outcome: <State value={snapshot.completion.outcome} />
                </p>
                <p>
                  Feature branch: {snapshot.completion.branch} · Commit:{" "}
                  <code>{snapshot.completion.commit}</code>
                </p>
                <p>
                  Completed issues:{" "}
                  {snapshot.completion.completedIssues.join(", ") || "none"} ·
                  Blocked:{" "}
                  {snapshot.completion.blockedIssues.join(", ") || "none"}
                </p>
                <p>
                  Repairs: {snapshot.completion.repairCount} · Repaired:{" "}
                  {snapshot.completion.repairedIssues.join(", ") || "none"}
                </p>
                <p>
                  Attempts:{" "}
                  {snapshot.completion.attempts
                    .map((a) => `${a.issueId}: ${a.used}`)
                    .join(", ") || "none"}
                </p>
                <p>
                  Evidence:{" "}
                  {snapshot.completion.evidenceRefs.join(", ") || "unavailable"}
                </p>
                <p>
                  Skipped checks:{" "}
                  {snapshot.completion.skippedChecks.join("; ") || "none"}
                </p>
                <p>
                  Unavailable review:{" "}
                  {snapshot.completion.unavailableReview.join("; ") || "none"}
                </p>
                <p>
                  Retained resources:{" "}
                  {snapshot.completion.retainedResourceCount}
                </p>
                {[...new Set(snapshot.completion.cleanupFailures)].map(
                  (failure) => (
                    <p key={failure}>Cleanup failure: {failure}</p>
                  ),
                )}
              </>
            )}
            {snapshot.reviewRounds.map((round) => (
              <article key={round.round}>
                <h3>Review round {round.round}</h3>
                <p>
                  Commit: <code>{round.commit}</code>
                </p>
                <p>
                  Code: <State value={round.code} /> · Functional:{" "}
                  <State value={round.functional} /> · Infrastructure attempts:{" "}
                  {round.infrastructureAttempts}
                </p>
                {round.findings.map((f) => (
                  <p key={`${f.role}-${f.id}`}>
                    {f.id} · {f.role} · {f.blocking ? "blocking" : "optional"} ·{" "}
                    {f.disposition}: {f.criterion} · Evidence:{" "}
                    {f.evidence.join("; ")}
                  </p>
                ))}
                {round.criteria.map((c) => (
                  <p key={c.id}>
                    {c.criterion}: <State value={c.status} /> · {c.reason} ·
                    Evidence: {c.evidenceRefs.join("; ") || "unavailable"}
                  </p>
                ))}
                {round.repairs.map((r) => (
                  <p key={r.id}>
                    {r.id}: <State value={r.status} /> · Attempts: {r.attempts}
                  </p>
                ))}
              </article>
            ))}
          </section>
          <section>
            <h2>Integration queue</h2>
            {!snapshot.executionAvailable ? (
              <p>Queue evidence unavailable.</p>
            ) : (
              <ol>
                {snapshot.integrationQueue.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <h2>Validation checks</h2>
            {!snapshot.checks.length && (
              <p>No validation evidence available.</p>
            )}
            {snapshot.checks.map((check) => (
              <article
                key={`${check.id}-${check.candidateCommit}-${check.attempt}`}
              >
                <h3>
                  {check.id} <State value={check.status} />
                </h3>
                <p>{check.reason}</p>
                <p>
                  Attempt {check.attempt} · Command revision{" "}
                  {check.commandRevision} · Candidate{" "}
                  <code>{check.candidateCommit}</code>
                </p>
              </article>
            ))}
          </section>
          {log && (
            <Logs key={`${runId}-${log}`} api={api} runId={runId} logId={log} />
          )}
        </>
      )}
    </main>
  );
}
