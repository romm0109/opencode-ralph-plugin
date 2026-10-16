import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { projectRunSnapshot } from "../../src/dashboard/projections.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { createReviewSnapshot } from "../../src/review/snapshot.js";
import { openRunStore } from "../../src/state/run-store.js";
import { diamondFixture } from "../helpers/diamond.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject, git } from "../helpers/project.js";

test("changed approved requirements block automatic review without a green verification result", async () => {
  const f = await diamondFixture();
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  f.adapter.dispatchJob = async (job) => {
    const result = await dispatch(job);
    if (job.role === "merger" && job.issueId === "D")
      await writeFile(
        join(
          f.project.directory,
          (await f.store.getRun(f.runId))?.planning?.prd?.artifactPath ??
            "missing",
        ),
        "Unapproved replacement",
      );
    return result;
  };
  try {
    await expect(f.router.scheduleIssues(f.runId)).rejects.toThrow(
      "Managed planning artifact changed",
    );
    const run = await f.store.getRun(f.runId);
    expect(run?.review).toBeUndefined();
    expect(run?.execution?.verification).toBe("incomplete");
    expect(f.jobs.some((job) => job.role === "code-review")).toBe(false);
  } finally {
    await f.project.cleanup();
  }
}, 30000);

test("the scheduler starts one independent code review after all planned integrations", async () => {
  const f = await diamondFixture();
  const planned = await f.store.getRun(f.runId);
  if (!planned?.planning) throw new Error("Missing planning");
  planned.planning.settings.models["code-review"] = {
    providerID: "review-provider",
    modelID: "review-model",
  };
  await f.store.recordPlanning(f.runId, planned.revision, planned.planning);
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  const reviewJobs: import("../../src/core/types.js").JobEnvelope[] = [];
  f.adapter.dispatchJob = async (job) => {
    if (job.role !== "code-review") return dispatch(job);
    reviewJobs.push(job);
    const run = await f.store.getRun(f.runId);
    expect(run?.execution?.issues.every((i) => i.status === "integrated")).toBe(
      true,
    );
    const fake = createFakeOpenCode({ sessionPrefix: "review-independent" });
    fake.respond(
      JSON.stringify({
        role: "code-review",
        reviewedCommit: job.baseCommit,
        round: 1,
        outcome: "passed",
        findings: [],
        evidenceRefs: ["A.ts:1"],
      }),
    );
    return createOpenCodeAdapter(fake.client, f.store).dispatchJob(job);
  };
  try {
    const run = await f.router.scheduleIssues(f.runId);
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]?.model).toEqual({
      providerID: "review-provider",
      modelID: "review-model",
    });
    expect(reviewJobs[0]?.readOnly).toBe(true);
    expect(run?.review?.result?.outcome).toBe("passed");
    expect(run?.review?.snapshot.commit).toBe(reviewJobs[0]?.baseCommit);
    expect(run?.review?.inputs.prd).toBe("Add one");
    expect(JSON.parse(run?.review?.inputs.graph ?? "{}").issues).toHaveLength(
      5,
    );
    expect(run?.execution?.verification).toBe("incomplete");
    await f.router.scheduleIssues(f.runId);
    expect(reviewJobs).toHaveLength(1);
  } finally {
    await f.project.cleanup();
  }
}, 30000);

test("review cannot start until every planned issue has integrated", async () => {
  const project = await createTestProject();
  try {
    const store = await openRunStore(project.directory);
    await store.createRun("r");
    const graph = { revision: "graph-1", issues: [{ id: "a" }, { id: "b" }] };
    for (const status of [
      "pending",
      "ready",
      "running",
      "failed",
      "blocked",
      "integration_queued",
    ] as const) {
      const run = await store.getRun("r");
      if (!run) throw new Error("Missing run");
      await store.recordExecution("r", run.revision, {
        issues: [
          {
            id: "a",
            title: "A",
            dependencies: [],
            status: "integrated",
            blockers: [],
          },
          { id: "b", title: "B", dependencies: [], status, blockers: [] },
        ],
        integrationQueue: [],
        checks: [],
      });
      await expect(
        createReviewSnapshot({
          store,
          directory: project.directory,
          runId: "r",
          round: 1,
          commit: project.commit,
          baseCommit: project.commit,
          prdRevision: "prd-1",
          graph,
          evidenceRefs: ["execution-1"],
        }),
      ).rejects.toThrow("integrated");
    }
    expect((await store.getRun("r"))?.jobs).toEqual({});
  } finally {
    await project.cleanup();
  }
});

async function reviewFixture() {
  const project = await createTestProject();
  const graph = { revision: "graph-1", issues: [{ id: "a" }] };
  await writeFile(
    join(project.directory, "PRD.md"),
    "Approved AC-1: addition returns the sum.\n",
  );
  await writeFile(join(project.directory, "graph.json"), JSON.stringify(graph));
  await writeFile(
    join(project.directory, "add.ts"),
    "export const add = (a: number, b: number) => a - b;\n",
  );
  await git("git", ["-C", project.directory, "add", "."]);
  await git("git", [
    "-C",
    project.directory,
    "commit",
    "-m",
    "feature with planted defect",
  ]);
  const commit = (
    await git("git", ["-C", project.directory, "rev-parse", "HEAD"])
  ).stdout.trim();
  const store = await openRunStore(project.directory);
  const fake = createFakeOpenCode();
  const adapter = createOpenCodeAdapter(fake.client, store);
  const router = createCommandRouter(store, adapter);
  await router.runJob({
    runId: "r",
    jobId: "execute-a",
    attempt: 1,
    role: "executor",
    workspace: project.directory,
    inputRevisions: {},
    baseCommit: commit,
    prompt: "Implement A",
  });
  const run = await store.getRun("r");
  if (!run) throw new Error("Missing run");
  await store.recordExecution("r", run.revision, {
    verification: "passed",
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
    checks: [
      {
        id: "tests",
        status: "passed",
        attempt: 1,
        candidateCommit: commit,
        commandRevision: 1,
      },
    ],
  });
  const options = {
    store,
    directory: project.directory,
    runId: "r",
    round: 1,
    commit,
    baseCommit: project.commit,
    prdRevision: "prd-1",
    graph,
    evidenceRefs: ["execution-1", "tests-1"],
  };
  return { project, store, fake, adapter, router, options, commit };
}

test("independent reviewer sees frozen requirements and diff; only the concrete defect blocks", async () => {
  const f = await reviewFixture();
  try {
    const snapshot = await createReviewSnapshot(f.options);
    f.fake.respond(
      JSON.stringify({
        role: "code-review",
        reviewedCommit: f.commit,
        round: 1,
        outcome: "findings",
        evidenceRefs: ["add.ts:1"],
        findings: [
          {
            id: "defect-1",
            reviewerRole: "code-review",
            reviewedCommit: f.commit,
            category: "correctness",
            blocking: true,
            criterion: "AC-1: addition returns sum",
            evidence: ["add.ts:1 subtracts; add(2,1) returns 1, expected 3"],
            suggestedRepair: "Replace subtraction with addition",
            disposition: "open",
          },
          {
            id: "style-1",
            reviewerRole: "code-review",
            reviewedCommit: f.commit,
            category: "style",
            blocking: true,
            criterion: "Name clarity",
            evidence: ["add.ts:1 uses a/b"],
            suggestedRepair: "Use descriptive parameters",
            disposition: "open",
          },
        ],
      }),
    );
    const result = await f.router.reviewCode(snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
      model: { providerID: "fixture", modelID: "reviewer" },
    });
    expect(result.outcome).toBe("findings");
    expect(
      result.findings
        .filter((finding) => finding.blocking)
        .map((finding) => finding.id),
    ).toEqual(["defect-1"]);
    expect(result.sessionId).toBe("session-2");
    const prompt = f.fake.requests.find(
      (request) =>
        request.path === "/api/session/session-2/prompt" && request.body.text,
    );
    expect(prompt?.directory).not.toBe(f.project.directory);
    const created = f.fake.requests.find(
      (request) =>
        request.path === "/api/session" &&
        request.directory === prompt?.directory,
    );
    expect(created?.body.model).toEqual({
      providerID: "fixture",
      id: "reviewer",
    });
    expect(JSON.stringify(prompt?.body.text)).toContain("Approved AC-1");
    expect(JSON.stringify(prompt?.body.text)).toContain("a - b");
    expect(
      f.fake.requests.find((request) => request.path.endsWith("/prepareReview"))
        ?.body,
    ).toMatchObject({ input: { tools: ["read", "glob", "grep", "list"] } });
    const reopened = await openRunStore(f.project.directory);
    const state = await reopened.getRun("r");
    expect(state?.review?.result).toEqual(result);
    expect(state?.phase).toBe("running");
    expect(await createCommandRouter(reopened).status("r")).toContain(
      "defect-1",
    );
    expect(
      f.fake.requests.some(
        (request) =>
          request.path === "/api/rpc/ralph/publishStatus" &&
          JSON.stringify(request.body).includes("defect-1"),
      ),
    ).toBe(true);
  } finally {
    await f.project.cleanup();
  }
});

function passedReview(commit: string, round = 1) {
  return {
    role: "code-review",
    reviewedCommit: commit,
    round,
    outcome: "passed",
    findings: [],
    evidenceRefs: ["add.ts:1"],
  };
}

test("malformed review output is unverified and retains correlated failure evidence", async () => {
  const f = await reviewFixture();
  try {
    const snapshot = await createReviewSnapshot(f.options);
    f.fake.respond("passed");
    const result = await f.router.reviewCode(snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
    });
    expect(result.outcome).toBe("unverified");
    expect(result.error?.code).toBe("invalid-review");
    expect(result.evidenceRefs).toContain("message-1");
    expect((await f.store.getRun("r"))?.review?.result?.outcome).toBe(
      "unverified",
    );
  } finally {
    await f.project.cleanup();
  }
});

test("wrong commit or round, missing evidence and contradictory verdicts cannot pass", async () => {
  for (const mutation of [
    { reviewedCommit: "a".repeat(40) },
    { round: 2 },
    { evidenceRefs: [] },
    {
      findings: [
        {
          id: "contradiction",
          reviewerRole: "code-review",
          reviewedCommit: "COMMIT",
          category: "correctness",
          blocking: true,
          criterion: "AC-1",
          evidence: ["add.ts:1 subtracts instead of adding"],
          suggestedRepair: "Add",
          disposition: "open",
        },
      ],
    },
    {
      outcome: "findings",
      findings: [
        {
          id: "vague",
          reviewerRole: "code-review",
          reviewedCommit: "COMMIT",
          category: "correctness",
          blocking: true,
          criterion: "AC-1",
          evidence: ["It seems wrong"],
          suggestedRepair: "Fix it",
          disposition: "open",
        },
      ],
    },
    {
      findings: [
        {
          id: "f",
          reviewerRole: "code-review",
          reviewedCommit: "invalid",
          category: "correctness",
          blocking: true,
        },
      ],
    },
  ]) {
    const f = await reviewFixture();
    try {
      const snapshot = await createReviewSnapshot(f.options);
      f.fake.respond(
        JSON.stringify({ ...passedReview(f.commit), ...mutation }),
      );
      const result = await f.router.reviewCode(snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
      });
      expect(result.outcome).toBe("unverified");
      expect(result.error?.code).toBe("invalid-review");
    } finally {
      await f.project.cleanup();
    }
  }
});

test("execution updates invalidate a snapshot and cannot reuse its round", async () => {
  const f = await reviewFixture();
  try {
    await createReviewSnapshot(f.options);
    const run = await f.store.getRun("r");
    if (!run?.execution) throw new Error("Missing execution");
    await f.store.recordExecution("r", run.revision, run.execution);
    await expect(createReviewSnapshot(f.options)).rejects.toThrow("Superseded");
  } finally {
    await f.project.cleanup();
  }
});

test("a superseded in-flight reviewer cannot publish or replace the newer round", async () => {
  const f = await reviewFixture();
  try {
    const snapshot = await createReviewSnapshot(f.options);
    f.fake.respond(JSON.stringify(passedReview(f.commit)));
    f.fake.hold();
    const pending = f.router.reviewCode(snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
    });
    const settled = pending.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    while (
      !f.fake.requests.some(
        (request) =>
          request.path === "/api/session/session-2/prompt" && request.body.text,
      )
    )
      await Bun.sleep(5);
    const second = await createReviewSnapshot({ ...f.options, round: 2 });
    f.fake.release();
    expect(await settled).toContain("Superseded");
    expect((await f.store.getRun("r"))?.review?.snapshot).toEqual(second);
    expect((await f.store.getRun("r"))?.review?.result).toBeUndefined();
    expect(
      f.fake.requests.filter(
        (request) => request.path === "/api/rpc/ralph/publishStatus",
      ),
    ).toHaveLength(0);
  } finally {
    await f.project.cleanup();
  }
});

test("workspace edits are rejected without touching the source branch", async () => {
  const f = await reviewFixture();
  try {
    const snapshot = await createReviewSnapshot(f.options);
    f.fake.respond(JSON.stringify(passedReview(f.commit)));
    f.fake.hold();
    const pending = f.router.reviewCode(snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
    });
    while (
      !f.fake.requests.some(
        (request) =>
          request.path === "/api/session/session-2/prompt" && request.body.text,
      )
    )
      await Bun.sleep(5);
    const workspace = f.fake.requests.find(
      (request) =>
        request.path === "/api/session/session-2/prompt" && request.body.text,
    )?.directory;
    if (!workspace) throw new Error("Missing reviewer workspace");
    await writeFile(join(workspace, "add.ts"), "reviewer tried to repair\n");
    f.fake.release();
    const result = await pending;
    expect(result.outcome).toBe("unverified");
    expect(result.error?.message).toContain("workspace changed");
    expect(
      (
        await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
      ).stdout.trim(),
    ).toBe(f.commit);
  } finally {
    await f.project.cleanup();
  }
});

test("optional-only review passes code review but never completes or verifies the feature", async () => {
  const f = await reviewFixture();
  try {
    const snapshot = await createReviewSnapshot(f.options);
    // Advance the source branch after freezing; reviewer still sees the pinned SHA.
    await writeFile(
      join(f.project.directory, "later.txt"),
      "later branch work\n",
    );
    await git("git", ["-C", f.project.directory, "add", "later.txt"]);
    await git("git", ["-C", f.project.directory, "commit", "-m", "later"]);
    f.fake.respond(
      JSON.stringify({
        ...passedReview(f.commit),
        outcome: "findings",
        findings: [
          {
            id: "style",
            reviewerRole: "code-review",
            reviewedCommit: f.commit,
            category: "refactor",
            blocking: true,
            criterion: "Clearer parameter names",
            evidence: ["add.ts:1"],
            suggestedRepair: "Rename parameters",
            disposition: "open",
          },
        ],
      }),
    );
    const result = await f.router.reviewCode(snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
    });
    expect(result.outcome).toBe("passed");
    expect(result.findings[0]?.blocking).toBe(false);
    const run = await f.store.getRun("r");
    expect(run?.phase).toBe("running");
    if (!run) throw new Error("Missing run");
    expect(projectRunSnapshot(run).verification).toBe("incomplete");
    expect(run?.review?.snapshot.commit).toBe(f.commit);
    const requestsBefore = f.fake.requests.length;
    expect(
      await f.router.reviewCode(snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
      }),
    ).toEqual(result);
    expect(f.fake.requests).toHaveLength(requestsBefore);
  } finally {
    await f.project.cleanup();
  }
});

test("blocking claims with nonexistent source evidence remain unverified", async () => {
  const f = await reviewFixture();
  try {
    const snapshot = await createReviewSnapshot(f.options);
    f.fake.respond(
      JSON.stringify({
        ...passedReview(f.commit),
        outcome: "findings",
        findings: [
          {
            id: "fiction",
            reviewerRole: "code-review",
            reviewedCommit: f.commit,
            category: "security",
            blocking: true,
            criterion: "No credential exposure",
            evidence: ["missing.ts:99 exposes credentials"],
            suggestedRepair: "Remove credentials",
            disposition: "open",
          },
        ],
      }),
    );
    const result = await f.router.reviewCode(snapshot, {
      directory: f.project.directory,
      parentSessionId: "parent",
    });
    expect(result.outcome).toBe("unverified");
    expect(result.error?.code).toBe("invalid-review");
  } finally {
    await f.project.cleanup();
  }
});

test("missing output and permission denial preserve typed causes and remain unverified", async () => {
  for (const mode of ["empty", "deny"] as const) {
    const f = await reviewFixture();
    try {
      const snapshot = await createReviewSnapshot(f.options);
      f.fake[mode]();
      const result = await f.router.reviewCode(snapshot, {
        directory: f.project.directory,
        parentSessionId: "parent",
      });
      expect(result.outcome).toBe("unverified");
      expect(result.error?.code).toBe(
        mode === "deny" ? "permission-denied" : "missing-output",
      );
      expect((await f.store.getRun("r"))?.review?.result?.outcome).toBe(
        "unverified",
      );
    } finally {
      await f.project.cleanup();
    }
  }
});
