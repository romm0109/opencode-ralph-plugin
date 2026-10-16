import type { DashboardEvent, LogPage, RunSnapshot } from "../projections.js";
export type RunSummary = Pick<RunSnapshot, "runId" | "phase" | "revision">;
export function createDashboardApi(token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, {
      headers,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw new Error(`Dashboard read failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  return {
    runs: () => get<RunSummary[]>("/api/runs"),
    snapshot: (runId: string) =>
      get<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`),
    log: (runId: string, logId: string, offset: number) =>
      get<LogPage>(
        `/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(logId)}?offset=${offset}`,
      ),
    async subscribe(
      runId: string,
      after: number,
      signal: AbortSignal,
      receive: (snapshot: RunSnapshot) => void,
    ) {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/events?after=${after}`,
        { headers, signal },
      );
      if (!response.ok || !response.body)
        throw new Error(`Event stream failed (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sequence = after;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Stream disconnected");
          buffer += decoder.decode(value, { stream: true });
          while (buffer.includes("\n\n")) {
            const boundary = buffer.indexOf("\n\n");
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = frame.split("\n");
            const kind = lines.find((l) => l.startsWith("event: "))?.slice(7);
            const data = lines
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            const parsed = JSON.parse(data) as RunSnapshot | DashboardEvent;
            const snapshot =
              kind === "snapshot"
                ? (parsed as RunSnapshot)
                : (parsed as DashboardEvent).snapshot;
            if (kind === "snapshot" || snapshot.sequence > sequence) {
              sequence = snapshot.sequence;
              receive(snapshot);
            }
          }
          if (buffer.length > 4 * 1024 * 1024)
            throw new Error("Event frame too large");
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
export type DashboardApi = ReturnType<typeof createDashboardApi>;
