import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { RunEvent } from "../core/types.js";
import type { RunStore } from "../state/run-store.js";
import { runtimeSecretValues } from "../state/sanitize.js";
import {
  logId,
  MAX_LOG_CHARS,
  MAX_PAGE_CHARS,
  projectRunSnapshot,
  sanitizeDisplay,
} from "./projections.js";

const processToken = randomBytes(32).toString("hex");
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
export async function startDashboard(
  store: RunStore,
  options: { secrets?: readonly string[]; pollIntervalMs?: number } = {},
) {
  const secrets = [
    processToken,
    ...runtimeSecretValues(),
    ...(options.secrets ?? []),
  ];
  const clients = new Set<ServerResponse>();
  let stopped = false;
  let origin = "";
  const snapshot = (event: RunEvent) =>
    projectRunSnapshot(event.snapshot, event.sequence, secrets);
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.host !== new URL(origin).host)
        return reply(403, { error: "Invalid host" });
      if (req.headers.origin && req.headers.origin !== origin)
        return reply(403, { error: "Cross-origin access denied" });
      if (req.method !== "GET")
        return reply(405, { error: "Read-only dashboard" });
      const url = new URL(req.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        const assets: Record<string, [string, string]> = {
          "/": ["index.html", "text/html"],
          "/assets/app.js": ["assets/app.js", "text/javascript"],
          "/assets/app.css": ["assets/app.css", "text/css"],
        };
        const asset = assets[url.pathname];
        if (!asset) return reply(404, { error: "Unknown asset" });
        try {
          const content = await readFile(
            new URL(`./public/${asset[0]}`, import.meta.url),
          );
          res.writeHead(200, { "Content-Type": asset[1] });
          res.end(content);
        } catch {
          reply(503, {
            error: "Dashboard assets unavailable; run bun run build",
          });
        }
        return;
      }
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${processToken}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
        return reply(401, { error: "Unauthorized" });
      if (url.pathname === "/api/runs") {
        const runs = await store.listRuns();
        return reply(
          200,
          runs.map((run) => ({
            runId: run.runId,
            phase: run.phase,
            revision: run.revision,
          })),
        );
      }
      let parts: string[];
      try {
        parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
      } catch {
        return reply(404, { error: "Unknown ID" });
      }
      const runId = parts[2];
      if (
        parts[0] !== "api" ||
        parts[1] !== "runs" ||
        !runId ||
        !validId(runId)
      )
        return reply(404, { error: "Unknown run" });
      // Journal is the committed source of truth, including after torn snapshot writes.
      let events = await store.events(runId, { latest: true });
      const last = events.at(-1);
      if (!last) return reply(404, { error: "Unknown run" });
      if (parts.length === 3) return reply(200, snapshot(last));
      if (parts.length === 4 && parts[3] === "issues")
        return reply(200, snapshot(last).issues);
      if (parts.length === 5 && parts[3] === "logs") {
        const history = await store.events(runId);
        const known = history
          .flatMap((e) => Object.values(e.snapshot.jobs))
          .find(
            (j) =>
              j.result?.text !== undefined &&
              logId(j.envelope.jobId, j.envelope.attempt) === parts[4],
          );
        if (!known?.result || known.result.text === undefined)
          return reply(404, { error: "Unknown log" });
        const raw = sanitizeDisplay(known.result.text, secrets);
        const bounded = raw.slice(0, MAX_LOG_CHARS);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? MAX_PAGE_CHARS);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1
        )
          return reply(400, { error: "Invalid log page" });
        const end = Math.min(
          bounded.length,
          offset + Math.min(limit, MAX_PAGE_CHARS),
        );
        return reply(200, {
          logId: parts[4],
          offset,
          content: bounded.slice(offset, end),
          total: bounded.length,
          truncated: raw.length > bounded.length,
          nextOffset: end < bounded.length ? end : null,
        });
      }
      if (parts.length !== 4 || parts[3] !== "events")
        return reply(404, { error: "Unknown endpoint" });
      const cursorText =
        url.searchParams.get("after") ?? req.headers["last-event-id"] ?? "0";
      let cursor = Number(cursorText);
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        return reply(400, { error: "Invalid sequence" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      clients.add(res);
      const write = (kind: string, event: RunEvent) => {
        res.write(
          `id: ${event.sequence}\nevent: ${kind}\ndata: ${JSON.stringify(kind === "snapshot" ? snapshot(event) : { sequence: event.sequence, type: event.type, timestamp: event.timestamp, snapshot: snapshot(event) })}\n\n`,
        );
        cursor = event.sequence;
      };
      if (cursor > 0)
        events = await store.events(runId, { afterSequence: cursor - 1 });
      if (cursor === 0 || !events.some((e) => e.sequence === cursor))
        write("snapshot", last);
      else
        for (const event of events)
          if (event.sequence > cursor) write("event", event);
      let polling = false;
      const timer = setInterval(async () => {
        if (polling || res.destroyed || stopped) return;
        polling = true;
        try {
          const fresh = await store.events(runId, {
            afterSequence: Math.max(0, cursor - 1),
          });
          const latest =
            fresh.at(-1) ??
            (await store.events(runId, { latest: true })).at(-1);
          if (!latest) return res.destroy();
          if (!fresh.some((e) => e.sequence === cursor))
            write("snapshot", latest);
          else
            for (const event of fresh) {
              if (event.sequence > cursor) {
                if (res.writableLength > 256 * 1024) {
                  res.destroy();
                  break;
                }
                write("event", event);
              }
            }
          if (!res.destroyed) res.write(": heartbeat\n\n");
        } catch {
          res.destroy();
        } finally {
          polling = false;
        }
      }, options.pollIntervalMs ?? 250);
      res.on("close", () => {
        clearInterval(timer);
        clients.delete(res);
      });
    } catch {
      if (res.headersSent) res.destroy();
      else reply(500, { error: "Dashboard read failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No dashboard address");
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  return {
    url: `${origin}/#${processToken}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const client of clients) client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) =>
          e && (e as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(e)
            : resolve(),
        ),
      );
    },
  };
}
