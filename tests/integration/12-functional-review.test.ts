import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { createReviewSnapshot } from "../../src/review/snapshot.js";
import { openRunStore } from "../../src/state/run-store.js";
import { startReviewApp, writeReviewApp } from "../fixtures/review-app.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject, git } from "../helpers/project.js";

async function fixture() {
  const project = await createTestProject();
  const graph = {
    revision: "g1",
    issues: [{ id: "a", acceptanceCriteria: ["API returns sum"] }],
  };
  await writeFile(
    join(project.directory, "PRD.md"),
    "## Acceptance criteria\n- [ ] API returns sum\n",
  );
  await writeFile(join(project.directory, "graph.json"), JSON.stringify(graph));
  await writeReviewApp(project.directory);
  await git("git", ["-C", project.directory, "add", "."]);
  await git("git", ["-C", project.directory, "commit", "-m", "requirements"]);
  const commit = (
    await git("git", ["-C", project.directory, "rev-parse", "HEAD"])
  ).stdout.trim();
  const store = await openRunStore(project.directory);
  await store.createRun("r");
  const run = await store.getRun("r");
  if (!run) throw new Error("Missing fixture run");
  await store.recordExecution("r", run.revision, {
    issues: [
      {
        id: "a",
        title: "A",
        dependencies: [],
        status: "integrated",
        blockers: [],
      },
    ],
    integrationQueue: [],
    checks: [],
  });
  const snapshot = await createReviewSnapshot({
    store,
    directory: project.directory,
    runId: "r",
    round: 1,
    commit,
    baseCommit: project.commit,
    prdRevision: "p1",
    graph,
    evidenceRefs: ["execution"],
  });
  const fake = createFakeOpenCode();
  const router = createCommandRouter(
    store,
    createOpenCodeAdapter(fake.client, store),
  );
  return { project, store, snapshot, fake, router };
}

test("backend review records every criterion and retains evidence through the public adapter", async () => {
  const f = await fixture();
  let cleaned = 0;
  try {
    f.fake.respond(
      JSON.stringify({
        reviewedCommit: f.snapshot.commit,
        round: 1,
        evidence: [
          {
            id: "http-1",
            kind: "http",
            summary: "POST /api/sum returns 3 for 1 + 2",
            reviewedCommit: f.snapshot.commit,
          },
        ],
        criteria: [
          {
            id: "prd-1",
            status: "pass",
            coverage: ["http"],
            evidenceRefs: ["http-1"],
          },
          {
            id: "issue-a-1",
            status: "pass",
            coverage: ["http"],
            evidenceRefs: ["http-1"],
          },
        ],
      }),
    );
    const result = await f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      environment: {
        revision: 1,
        async prepare() {
          return { url: "http://127.0.0.1:1234", evidenceRefs: ["startup"] };
        },
        async dispose() {
          cleaned++;
          return { status: "completed", evidenceRefs: ["cleanup"] };
        },
      },
      surfaces: { ui: false, http: true },
      tools: { http: "http" },
    });
    expect(result.outcome).toBe("passed");
    expect(result.criteria).toHaveLength(2);
    expect(cleaned).toBe(1);
    expect((await f.store.getRun("r"))?.review?.functionalResult).toEqual(
      result,
    );
  } finally {
    await f.project.cleanup();
  }
});

test("unavailable test access retries exactly three times with owned cleanup and retained blockers", async () => {
  const f = await fixture();
  let started = 0;
  let cleaned = 0;
  try {
    const result = await f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      surfaces: { ui: false, http: true },
      tools: { http: "http" },
      requiredEnvRefs: ["RALPH_NONEXISTENT_FIXTURE_ACCOUNT"],
      environment: {
        revision: 1,
        async prepare() {
          started++;
          return {
            url: "http://localhost:1234",
            evidenceRefs: [`startup-${started}`],
          };
        },
        async dispose() {
          cleaned++;
          return { status: "completed", evidenceRefs: [`cleanup-${cleaned}`] };
        },
      },
    });
    expect(result.outcome).toBe("unverified");
    expect(result.attempts).toHaveLength(3);
    expect(started).toBe(3);
    expect(cleaned).toBe(3);
    expect(
      result.criteria.every((c) =>
        c.reason?.includes("RALPH_NONEXISTENT_FIXTURE_ACCOUNT"),
      ),
    ).toBe(true);
    expect(result.evidenceRefs).toContain("cleanup-3");
    expect(f.fake.requests.some((r) => r.path === "/api/session")).toBe(false);
    expect(
      await f.router.reviewFunctional(f.snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
        surfaces: { ui: false, http: true },
        tools: { http: "http" },
        environment: {
          revision: 1,
          async prepare() {
            throw new Error("Must not repeat");
          },
          async dispose() {
            throw new Error("Must not repeat");
          },
        },
      }),
    ).toEqual(result);
  } finally {
    await f.project.cleanup();
  }
});

test("fabricated evidence references cannot pass review", async () => {
  const f = await fixture();
  try {
    f.fake.respond(
      JSON.stringify({
        reviewedCommit: f.snapshot.commit,
        round: 1,
        criteria: ["prd-1", "issue-a-1"].map((id) => ({
          id,
          status: "pass",
          coverage: ["http"],
          evidenceRefs: ["fiction"],
        })),
      }),
    );
    const result = await f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      surfaces: { ui: false, http: true },
      tools: { http: "http" },
      environment: {
        revision: 1,
        async prepare() {
          return { url: "http://localhost:1234", evidenceRefs: [] };
        },
        async dispose() {
          return { status: "completed", evidenceRefs: [] };
        },
      },
    });
    expect(result.outcome).toBe("unverified");
    expect(result.error?.code).toBe("invalid-review");
    expect(result.attempts).toHaveLength(1);
  } finally {
    await f.project.cleanup();
  }
});

test("fixture UI/API runs at frozen SHA and observed failures remain blocking without retry", async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof startReviewApp>> | undefined;
  let setupCount = 0;
  try {
    // The source branch can change; review still launches the committed addition app.
    await writeFile(
      join(f.project.directory, "app.json"),
      JSON.stringify({ operation: "subtract" }),
    );
    const result = await f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      surfaces: { ui: true, http: true },
      tools: { browser: "agent-browser", http: "http" },
      environment: {
        revision: 9,
        async prepare(job) {
          setupCount++;
          server = await startReviewApp(job.workspace);
          const html = await (await fetch(server.url)).text();
          expect(html).toContain("<form>");
          const response = await fetch(new URL("/api/sum", server.url), {
            method: "POST",
            body: JSON.stringify({ a: 1, b: 2 }),
          });
          expect(await response.json()).toEqual({ sum: 3 });
          f.fake.respond(
            JSON.stringify({
              reviewedCommit: f.snapshot.commit,
              round: 1,
              evidence: [
                {
                  id: "http",
                  kind: "http",
                  reviewedCommit: f.snapshot.commit,
                  summary:
                    "POST /api/sum 1+2 returned 3; requirement expects 4 (planted acceptance defect)",
                },
                {
                  id: "browser",
                  kind: "browser",
                  reviewedCommit: f.snapshot.commit,
                  summary: "Fake browser form submission shows 3",
                  screenshot: "screenshots/form.png",
                },
              ],
              unavailable: true,
              criteria: [
                {
                  id: "prd-1",
                  status: "fail",
                  coverage: ["http"],
                  evidenceRefs: ["http"],
                  reason: "Observed result differs from acceptance expectation",
                },
                {
                  id: "issue-a-1",
                  status: "unverified",
                  coverage: [],
                  evidenceRefs: [],
                  reason: "Test account unavailable",
                },
              ],
            }),
          );
          return { url: server.url.toString(), evidenceRefs: ["startup-log"] };
        },
        async dispose() {
          server?.stop(true);
          return { status: "completed", evidenceRefs: ["shutdown-log"] };
        },
      },
    });
    expect(result.outcome).toBe("findings");
    expect(result.findings[0]?.blocking).toBe(true);
    expect(result.criteria[1]?.status).toBe("unverified");
    expect(setupCount).toBe(1);
    expect(result.attempts).toHaveLength(1);
    const prompt = f.fake.requests.find(
      (r) => r.path.endsWith("/prompt") && r.body.text,
    );
    const restriction = f.fake.requests.find((request) =>
      request.path.endsWith("/prepareReview"),
    );
    expect(restriction?.body).toMatchObject({
      input: { tools: expect.arrayContaining(["agent-browser", "http"]) },
    });
    expect(JSON.stringify(restriction?.body)).not.toContain('"shell"');
    expect(JSON.stringify(prompt?.body.text)).toContain(f.snapshot.commit);
  } finally {
    server?.stop(true);
    await f.project.cleanup();
  }
});

test("bad startup and missing tools exhaust three attempts without changing approved lifecycle", async () => {
  for (const mode of ["startup", "tool"] as const) {
    const f = await fixture();
    let cleaned = 0;
    try {
      const environment = {
        revision: 7,
        async prepare() {
          if (mode === "startup") throw new Error("Readiness timed out");
          return {
            url: "http://localhost:1234",
            evidenceRefs: ["readiness-log"],
          };
        },
        async dispose() {
          cleaned++;
          return {
            status: "completed" as const,
            evidenceRefs: ["cleanup-log"],
          };
        },
      };
      Object.freeze(environment);
      const result = await f.router.reviewFunctional(f.snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
        environment,
        surfaces: { ui: true, http: true },
        tools: { browser: "missing-browser", http: "http" },
      });
      expect(result.outcome).toBe("unverified");
      expect(result.attempts).toHaveLength(3);
      expect(cleaned).toBe(3);
      expect(environment.revision).toBe(7);
      expect(
        result.criteria.every((c) => c.status === "unverified" && !!c.reason),
      ).toBe(true);
    } finally {
      await f.project.cleanup();
    }
  }
});

test("wrong SHA, omitted criteria and unjustified non-applicability are unverified; justified N/A passes", async () => {
  for (const mode of ["sha", "omitted", "unjustified", "justified"] as const) {
    const f = await fixture();
    try {
      f.fake.respond(
        JSON.stringify({
          reviewedCommit: mode === "sha" ? "a".repeat(40) : f.snapshot.commit,
          round: 1,
          criteria: (mode === "omitted"
            ? ["prd-1"]
            : ["prd-1", "issue-a-1"]
          ).map((id) => ({
            id,
            status: "not-applicable",
            evidenceRefs: [],
            ...(mode !== "unjustified"
              ? {
                  reason:
                    "Criterion applies only to external production deployment; this feature is local",
                }
              : {}),
          })),
        }),
      );
      const result = await f.router.reviewFunctional(f.snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
        surfaces: { ui: false, http: true },
        tools: { http: "http" },
        environment: {
          revision: 1,
          async prepare() {
            return { url: "http://localhost:1234", evidenceRefs: [] };
          },
          async dispose() {
            return { status: "completed", evidenceRefs: [] };
          },
        },
      });
      expect(result.outcome).toBe(
        mode === "justified" ? "passed" : "unverified",
      );
      expect(result.attempts).toHaveLength(1);
    } finally {
      await f.project.cleanup();
    }
  }
});

test("superseded functional completion cannot replace or publish a newer snapshot", async () => {
  const f = await fixture();
  try {
    f.fake.respond(
      JSON.stringify({
        reviewedCommit: f.snapshot.commit,
        round: 1,
        criteria: ["prd-1", "issue-a-1"].map((id) => ({
          id,
          status: "unverified",
          evidenceRefs: [],
          reason: "Unsupported feature surface",
        })),
      }),
    );
    f.fake.hold();
    const pending = f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      surfaces: { ui: false, http: true },
      tools: { http: "http" },
      environment: {
        revision: 1,
        async prepare() {
          return { url: "http://localhost:1234", evidenceRefs: [] };
        },
        async dispose() {
          return { status: "completed", evidenceRefs: [] };
        },
      },
    });
    const settled = pending.then(
      () => "accepted",
      (e: Error) => e.message,
    );
    while (
      !f.fake.requests.some((r) => r.path.endsWith("/prompt") && r.body.text)
    )
      await Bun.sleep(5);
    const run = await f.store.getRun("r");
    if (!run?.execution) throw new Error("Missing execution");
    await f.store.recordExecution("r", run.revision, run.execution);
    f.fake.release();
    expect(await settled).toContain("superseded");
    expect(
      (await f.store.getRun("r"))?.review?.functionalResult,
    ).toBeUndefined();
  } finally {
    f.fake.release();
    await f.project.cleanup();
  }
});

const browserSmoke =
  process.env.RUN_AGENT_BROWSER_SMOKE === "1" ? test : test.skip;
browserSmoke(
  "real agent-browser submits committed fixture form and retains screenshot",
  async () => {
    const f = await fixture();
    let server: Awaited<ReturnType<typeof startReviewApp>> | undefined;
    const session = `ralph-smoke-${Date.now()}`;
    try {
      const result = await f.router.reviewFunctional(f.snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
        surfaces: { ui: true, http: true },
        tools: { browser: "agent-browser", http: "http" },
        environment: {
          revision: 1,
          async prepare(job) {
            server = await startReviewApp(job.workspace);
            await git("agent-browser", [
              "--session",
              session,
              "open",
              server.url.toString(),
            ]);
            await git("agent-browser", [
              "--session",
              session,
              "snapshot",
              "-i",
            ]);
            await git("agent-browser", [
              "--session",
              session,
              "find",
              "label",
              "A",
              "fill",
              "1",
            ]);
            await git("agent-browser", [
              "--session",
              session,
              "find",
              "label",
              "B",
              "fill",
              "2",
            ]);
            await git("agent-browser", [
              "--session",
              session,
              "find",
              "role",
              "button",
              "click",
              "--name",
              "Sum",
            ]);
            await git("agent-browser", [
              "--session",
              session,
              "wait",
              "--fn",
              "document.querySelector('output').textContent === '3'",
            ]);
            const browser = (
              await git("agent-browser", [
                "--session",
                session,
                "get",
                "text",
                "body",
              ])
            ).stdout;
            expect(browser).toContain("3");
            const screenshot = join(f.store.root, "form.png");
            await git("agent-browser", [
              "--session",
              session,
              "screenshot",
              screenshot,
            ]);
            const response = await fetch(new URL("/api/sum", server.url), {
              method: "POST",
              body: JSON.stringify({ a: 1, b: 2 }),
            });
            const body = await response.text();
            expect(JSON.parse(body)).toEqual({ sum: 3 });
            f.fake.respond(
              JSON.stringify({
                reviewedCommit: f.snapshot.commit,
                round: 1,
                evidence: [
                  {
                    id: "browser",
                    kind: "browser",
                    summary: browser,
                    screenshot,
                    reviewedCommit: f.snapshot.commit,
                  },
                  {
                    id: "http",
                    kind: "http",
                    summary: `POST /api/sum {a:1,b:2} => ${response.status} ${body}`,
                    reviewedCommit: f.snapshot.commit,
                  },
                ],
                criteria: ["prd-1", "issue-a-1"].map((id) => ({
                  id,
                  status: "pass",
                  coverage: ["browser", "http"],
                  evidenceRefs: ["browser", "http"],
                })),
              }),
            );
            return {
              url: server.url.toString(),
              evidenceRefs: ["smoke-startup"],
            };
          },
          async dispose() {
            try {
              await git("agent-browser", ["--session", session, "close"]);
            } finally {
              server?.stop(true);
            }
            return { status: "completed", evidenceRefs: ["smoke-cleanup"] };
          },
        },
      });
      expect(result.outcome).toBe("passed");
    } finally {
      server?.stop(true);
      await f.project.cleanup();
    }
  },
  60000,
);

test("startup diagnostics never persist test-account secret values", async () => {
  const f = await fixture();
  process.env.RALPH_FIXTURE_PASSWORD = 'quote"sensitive-fixture';
  try {
    await f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      surfaces: { ui: false, http: true },
      tools: { http: "http" },
      environment: {
        revision: 1,
        async prepare() {
          throw new Error(
            `Startup failed with ${process.env.RALPH_FIXTURE_PASSWORD}`,
          );
        },
        async dispose() {
          return { status: "completed", evidenceRefs: [] };
        },
      },
    });
    const state = await f.store.getRun("r");
    expect(JSON.stringify(state)).not.toContain("sensitive-fixture");
    expect(JSON.stringify(await f.store.events("r"))).not.toContain(
      "sensitive-fixture",
    );
  } finally {
    delete process.env.RALPH_FIXTURE_PASSWORD;
    await f.project.cleanup();
  }
});

test("cleanup failure is disclosed and missing agent output cannot pass", async () => {
  for (const mode of ["cleanup", "empty"] as const) {
    const f = await fixture();
    try {
      if (mode === "empty") f.fake.empty();
      else
        f.fake.respond(
          JSON.stringify({
            reviewedCommit: f.snapshot.commit,
            round: 1,
            evidence: [
              {
                id: "http",
                kind: "http",
                summary: "POST /api/sum returns 3",
                reviewedCommit: f.snapshot.commit,
              },
            ],
            criteria: ["prd-1", "issue-a-1"].map((id) => ({
              id,
              status: "pass",
              coverage: ["http"],
              evidenceRefs: ["http"],
            })),
          }),
        );
      const result = await f.router.reviewFunctional(f.snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
        surfaces: { ui: false, http: true },
        tools: { http: "http" },
        environment: {
          revision: 1,
          async prepare() {
            return { url: "http://localhost:1234", evidenceRefs: [] };
          },
          async dispose() {
            return {
              status: mode === "cleanup" ? "denied" : "completed",
              evidenceRefs: ["cleanup-log"],
              reason: "Fixture cleanup denied",
            };
          },
        },
      });
      expect(result.outcome).toBe("unverified");
      expect(result.attempts).toHaveLength(mode === "cleanup" ? 1 : 3);
      expect(result.error?.code).toBe(
        mode === "cleanup" ? "unsupported" : "missing-output",
      );
      expect(result.evidenceRefs).toContain("cleanup-log");
    } finally {
      await f.project.cleanup();
    }
  }
});

test("command-only functional review uses approved check logs without requiring a web server", async () => {
  const f = await fixture();
  try {
    f.fake.respond(
      JSON.stringify({
        reviewedCommit: f.snapshot.commit,
        round: 1,
        evidence: [
          {
            id: "checks",
            kind: "log",
            summary:
              "Approved behavior checks pass for the exact feature commit",
            reviewedCommit: f.snapshot.commit,
          },
        ],
        criteria: ["prd-1", "issue-a-1"].map((id) => ({
          id,
          status: "pass",
          coverage: ["log"],
          evidenceRefs: ["checks"],
        })),
      }),
    );
    const result = await f.router.reviewFunctional(f.snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      environment: {
        revision: 1,
        async prepare() {
          return { url: "", evidenceRefs: ["approved-checks"] };
        },
        async dispose() {
          return { status: "completed", evidenceRefs: [] };
        },
      },
      surfaces: { ui: false, http: false },
      tools: {},
    });
    expect(result.outcome).toBe("passed");
    expect(
      result.criteria.every((c) => c.coverage.includes("log" as never)),
    ).toBe(true);
  } finally {
    await f.project.cleanup();
  }
});
