import { createInterface } from "node:readline";
import { createCommandRouter } from "../../src/commands/router.js";
import { startDashboard } from "../../src/dashboard/server.js";
import { diamondFixture, gate, until } from "./diamond.js";
import { required } from "./single-issue.js";

// Playwright runs in Node; keep the real Bun scheduler/command runner in Bun.
const f = await diamondFixture();
const dashboard = await startDashboard(f.store, { pollIntervalMs: 25 });
const b = gate();
const c = gate();
f.holds.set("B", b);
f.holds.set("C", c);
const input = createInterface({ input: process.stdin });
const closed = gate();
input.on("line", (line) => {
  if (line === "release") {
    b.release();
    c.release();
  }
  if (line === "close") input.close();
});
input.on("close", () => {
  b.release();
  c.release();
  closed.release();
});
let pending: Promise<unknown> | undefined;
try {
  // A prior validation timeout is run-local debt, as in the concurrency fixture.
  const initial = required(await f.store.getRun(f.runId));
  await f.store.recordBaseline(
    f.runId,
    initial.revision,
    { ...required(initial.baseline), status: "passed_with_omissions" },
    ["test"],
  );
  const router = createCommandRouter(f.store, f.adapter, dashboard.url);
  pending = router.scheduleIssues(f.runId);
  await until(async () => {
    const run = await f.store.getRun(f.runId);
    return ["B", "C"].every((id) =>
      run?.execution?.issues.some((i) => i.id === id && i.status === "running"),
    );
  });
  // Captured by the browser harness only; never forwarded to test output.
  console.log(JSON.stringify(JSON.parse(await router.status(f.runId))));
  await pending;
  console.log(JSON.stringify({ settled: true }));
  await closed.promise;
} finally {
  input.close();
  b.release();
  c.release();
  await Promise.allSettled(pending ? [pending] : []);
  await dashboard.stop();
  await f.project.cleanup();
}
