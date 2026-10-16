import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { loadProjectConfig } from "../../src/config/project.js";
import { preflightRun } from "../../src/execution/preflight.js";
import { validateCandidate } from "../../src/execution/validation.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { authorNativePlanning } from "../helpers/native-planning.js";
import { createTestProject, git } from "../helpers/project.js";
import { required } from "../helpers/single-issue.js";

setDefaultTimeout(30000);
const originalScenario = process.env.RALPH_BASELINE_SCENARIO;
afterAll(() => {
  if (originalScenario === undefined)
    delete process.env.RALPH_BASELINE_SCENARIO;
  else process.env.RALPH_BASELINE_SCENARIO = originalScenario;
});

async function fixture(extraCheck = false) {
  process.env.RALPH_BASELINE_SCENARIO = "pass";
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  const store = await openRunStore(project.directory);
  const adapter = createOpenCodeAdapter(fake.client, store);
  adapter.getSessionModel = async () => ({
    providerID: "fixture",
    modelID: "default",
  });
  adapter.authorizeCommand = async () => ({ ok: true });
  const router = createCommandRouter(store, adapter);
  fake.respond(
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      rationale: "Fixture",
      commands: [
        {
          id: "setup",
          phase: "setup",
          executable: process.execPath,
          args: [
            "-e",
            "if(process.env.SCENARIO === 'setupfail') process.exit(8); if(process.env.SCENARIO === 'setuptimeout') setTimeout(() => {}, 10000)",
          ],
          cwd: ".",
          timeoutMs: 2000,
          platforms: ["darwin", "linux", "win32"],
          env: { SCENARIO: "RALPH_BASELINE_SCENARIO" },
        },
        {
          id: "check",
          phase: "check",
          executable: process.execPath,
          args: [
            "-e",
            "if(process.env.SCENARIO === 'mutate') require('node:fs').writeFileSync('README.md', 'changed'); if(process.env.SCENARIO === 'fail') process.exit(7); if(process.env.SCENARIO === 'timeout') setTimeout(() => {}, 10000)",
          ],
          cwd: ".",
          timeoutMs: 2000,
          platforms: ["darwin", "linux", "win32"],
          env: { SCENARIO: "RALPH_BASELINE_SCENARIO" },
        },
        ...(extraCheck
          ? [
              {
                id: "second-check",
                phase: "check",
                executable: process.execPath,
                args: ["-e", "process.exit(0)"],
                cwd: ".",
                timeoutMs: 2000,
                platforms: ["darwin", "linux", "win32"],
                env: {},
              },
            ]
          : []),
        {
          id: "cleanup",
          phase: "cleanup",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: ".",
          timeoutMs: 2000,
          platforms: ["darwin", "linux", "win32"],
          env: {},
        },
      ],
    }),
  );
  adapter.requestUserInput = async (request) => ({
    ok: true,
    ...request,
    source: "user",
    messageId: "setup",
    text: `approve ${request.question.match(/hash ([a-f0-9]+)/)?.[1]}`,
  });
  await router.setupProject({
    workspace: project.directory,
    sessionId: "main",
  });
  return { project, fake, store, adapter, router };
}

async function approvedFixture(extraCheck = false) {
  const f = await fixture(extraCheck);
  f.fake.respond("Use completion tools");
  const planning = await authorNativePlanning(
    f.project.directory,
    f.store,
    f.adapter,
  );
  f.project.commit = planning.commit;
  // Leave baseline retry to each test; a real unrelated file must block commands.
  await writeFile(
    join(f.project.directory, "preflight-blocker.txt"),
    "unrelated work",
  );
  await planning.complete();
  await rm(join(f.project.directory, "preflight-blocker.txt"));
  return { ...f, runId: planning.runId };
}

test("approved baseline isolates the exact selected commit and exposes readiness", async () => {
  const f = await approvedFixture();
  try {
    const head = (
      await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
    ).stdout;
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("passed");
    expect(run?.baseline?.candidateCommit).toBe(f.project.commit);
    expect(
      (await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"]))
        .stdout,
    ).toBe(head);
    expect(JSON.parse(await f.router.status(f.runId)).baseline.status).toBe(
      "passed",
    );
    expect(Object.values(run?.jobs ?? {}).some((j) => j.envelope.issueId)).toBe(
      false,
    );
  } finally {
    await f.project.cleanup();
  }
});

test("completed baseline failure blocks without spending an issue attempt and removes only its worktree", async () => {
  const f = await approvedFixture();
  try {
    process.env.RALPH_BASELINE_SCENARIO = "fail";
    const configBefore = await readFile(
      join(f.project.directory, ".ralph/commands.json"),
      "utf8",
    );
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("failed");
    expect(run?.baseline?.validation?.checks[0]?.result?.exitCode).toBe(7);
    expect(Object.values(run?.jobs ?? {}).some((j) => j.envelope.issueId)).toBe(
      false,
    );
    expect(
      (
        await git("git", [
          "-C",
          f.project.directory,
          "worktree",
          "list",
          "--porcelain",
        ])
      ).stdout,
    ).not.toContain(run?.baseline?.workspace as string);
    expect(
      await readFile(join(f.project.directory, ".ralph/commands.json"), "utf8"),
    ).toBe(configBefore);
  } finally {
    await f.project.cleanup();
  }
});

test("timeout omissions persist for this run, including when every check is skipped", async () => {
  const f = await approvedFixture();
  try {
    process.env.RALPH_BASELINE_SCENARIO = "timeout";
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("passed_with_omissions");
    expect(run?.validationSkips).toEqual(["check"]);
    const owner = run?.operations[run.baseline?.operationId ?? ""];
    if (!owner) throw new Error("Missing ownership");
    process.env.RALPH_BASELINE_SCENARIO = "fail";
    const config = (await loadProjectConfig(f.project.directory)).commands;
    const result = await validateCandidate({
      store: f.store,
      adapter: f.adapter,
      job: owner.job,
      config,
      sourceWorkspace: f.project.directory,
    });
    expect(result.status).toBe("passed_with_omissions");
    expect(result.checks[0]?.result).toBeUndefined();
    const fresh = await f.store.createRun("fresh-run");
    expect(fresh.validationSkips).toBeUndefined();
  } finally {
    await f.project.cleanup();
  }
});

test("checks cannot attest the approved candidate after changing tracked files", async () => {
  const f = await approvedFixture();
  try {
    process.env.RALPH_BASELINE_SCENARIO = "mutate";
    expect(
      (await preflightRun(f.store, f.adapter, f.runId))?.baseline?.status,
    ).toBe("failed");
  } finally {
    await f.project.cleanup();
  }
});

for (const dirty of ["tracked", "untracked"] as const) {
  test(`${dirty} changes block before baseline or issue commands run`, async () => {
    const f = await approvedFixture();
    try {
      await writeFile(
        join(
          f.project.directory,
          dirty === "tracked" ? "README.md" : "new-source.ts",
        ),
        "dirty",
      );
      const before = await f.store.getRun(f.runId);
      const run = await preflightRun(f.store, f.adapter, f.runId);
      expect(run?.baseline?.blocker).toContain("Checkout is dirty");
      expect(Object.keys(run?.operations ?? {})).toEqual(
        Object.keys(before?.operations ?? {}),
      );
      expect(run?.jobs).toEqual(before?.jobs);
    } finally {
      await f.project.cleanup();
    }
  });
}

test("unborn HEAD and invalid selected commit produce blockers", async () => {
  for (const scenario of ["unborn", "invalid"] as const) {
    const f = await approvedFixture();
    try {
      if (scenario === "unborn")
        await git("git", [
          "-C",
          f.project.directory,
          "update-ref",
          "-d",
          "HEAD",
        ]);
      else {
        const run = await f.store.getRun(f.runId);
        if (!run?.planning?.executionEligibility)
          throw new Error("Missing approval");
        const approval = run.planning.executionEligibility;
        const state = run.planning;
        state.selectedCommit = "f".repeat(40);
        state.executionEligibility = {
          ...approval,
          selectedCommit: state.selectedCommit,
        };
        await f.store.recordPlanning(f.runId, run.revision, state);
      }
      const run = await preflightRun(f.store, f.adapter, f.runId);
      expect(run?.baseline?.status).toBe("failed");
      expect(run?.baseline?.validation).toBeUndefined();
    } finally {
      await f.project.cleanup();
    }
  }
});

test("branch collision preserves existing branch and unrelated worktrees", async () => {
  const f = await approvedFixture();
  try {
    await git("git", ["-C", f.project.directory, "branch", `ralph/${f.runId}`]);
    const other = join(f.store.root, "unrelated");
    await git("git", [
      "-C",
      f.project.directory,
      "worktree",
      "add",
      "--detach",
      other,
      "HEAD",
    ]);
    const before = (
      await git("git", [
        "-C",
        f.project.directory,
        "worktree",
        "list",
        "--porcelain",
      ])
    ).stdout;
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.blocker).toContain("already exists");
    expect(
      (
        await git("git", [
          "-C",
          f.project.directory,
          "worktree",
          "list",
          "--porcelain",
        ])
      ).stdout,
    ).toBe(before);
  } finally {
    await f.project.cleanup();
  }
});

test("setup failures are never skipped and cleanup still runs", async () => {
  const f = await approvedFixture();
  try {
    process.env.RALPH_BASELINE_SCENARIO = "setupfail";
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("failed");
    expect(run?.baseline?.blocker).toContain("setup");
    expect(
      run?.baseline?.validation?.lifecycle.map((r) => r.commandId),
    ).toEqual(["setup", "cleanup"]);
    expect(run?.validationSkips ?? []).toEqual([]);
    expect(run?.baseline?.validation?.checks).toEqual([]);
  } finally {
    await f.project.cleanup();
  }
});

test("repository lock mismatch and changed configuration block execution", async () => {
  for (const scenario of ["lock", "config"] as const) {
    const f = await approvedFixture();
    try {
      if (scenario === "lock")
        await writeFile(
          join(f.store.root, "active-run.lock/owner.json"),
          JSON.stringify({
            runId: "other",
            repositoryId: f.store.repositoryId,
          }),
        );
      else {
        const path = join(f.project.directory, ".ralph/commands.json");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.revision++;
        await writeFile(path, JSON.stringify(config));
      }
      const run = await preflightRun(f.store, f.adapter, f.runId);
      expect(run?.baseline?.status).toBe("failed");
      expect(run?.baseline?.validation).toBeUndefined();
    } finally {
      await f.project.cleanup();
    }
  }
});

test("concurrent preflight calls create one owned baseline", async () => {
  const f = await approvedFixture();
  try {
    await Promise.all([
      preflightRun(f.store, f.adapter, f.runId),
      preflightRun(f.store, f.adapter, f.runId),
    ]);
    const run = await f.store.getRun(f.runId);
    expect(
      Object.values(run?.operations ?? {}).filter(
        (op) => op.kind === "baseline.workspace",
      ),
    ).toHaveLength(1);
    expect(run?.baseline?.status).toBe("passed");
  } finally {
    await f.project.cleanup();
  }
});

test("cached readiness cannot bypass changed approved configuration", async () => {
  const f = await approvedFixture();
  try {
    expect(
      (await preflightRun(f.store, f.adapter, f.runId))?.baseline?.status,
    ).toBe("passed");
    const path = join(f.project.directory, ".ralph/commands.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.revision++;
    await writeFile(path, JSON.stringify(config));
    await expect(preflightRun(f.store, f.adapter, f.runId)).rejects.toThrow(
      "Configuration or host differs from verification",
    );
    expect((await f.store.getRun(f.runId))?.baseline?.status).toBe("passed");
    expect(
      Object.values((await f.store.getRun(f.runId))?.jobs ?? {}).some(
        (job) => job.envelope.issueId,
      ),
    ).toBe(false);
  } finally {
    await f.project.cleanup();
  }
});

test("a timed-out check does not prevent remaining checks or cleanup", async () => {
  const f = await approvedFixture(true);
  try {
    process.env.RALPH_BASELINE_SCENARIO = "timeout";
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("passed_with_omissions");
    expect(
      run?.baseline?.validation?.checks.map((c) => [c.id, c.status]),
    ).toEqual([
      ["check", "skipped"],
      ["second-check", "passed"],
    ]);
    expect(run?.baseline?.validation?.lifecycle.at(-1)?.commandId).toBe(
      "cleanup",
    );
    expect(run?.baseline?.validation?.commandHash).toBe(
      run?.planning?.commandHash,
    );
    expect(run?.baseline?.validation?.candidateCommit).toBe(f.project.commit);
  } finally {
    await f.project.cleanup();
  }
});

test("setup timeouts block without adding a validation omission", async () => {
  const f = await approvedFixture();
  try {
    process.env.RALPH_BASELINE_SCENARIO = "setuptimeout";
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("failed");
    expect(run?.validationSkips ?? []).toEqual([]);
    expect(run?.baseline?.validation?.lifecycle.at(-1)?.commandId).toBe(
      "cleanup",
    );
  } finally {
    await f.project.cleanup();
  }
});

for (const [scenario, expected] of [
  ["fail", "failed"],
  ["pass", "passed"],
  ["timeout", "passed_with_omissions"],
] as const) {
  test(`public orchestrator and status demonstrate ${expected} baseline`, async () => {
    const f = await fixture();
    try {
      f.fake.respond("Use completion tools");
      const planning = await authorNativePlanning(
        f.project.directory,
        f.store,
        f.adapter,
      );
      f.project.commit = planning.commit;
      process.env.RALPH_BASELINE_SCENARIO = scenario;
      f.adapter.dispatchJob = async (job) => ({
        ...job,
        outcome: "failed",
        evidence: [],
        error: {
          code: "missing-output",
          message: "Test stops at executor boundary",
        },
      });
      await planning.complete();
      const run = required(await f.store.getRun(planning.runId));
      expect(run.baseline?.status).toBe(expected);
      const status = JSON.parse(
        await f.router.dispatch("ralph-status", run.runId),
      );
      expect(status.baseline.status).toBe(expected);
      expect(status.baseline.candidateCommit).toBe(f.project.commit);
      if (scenario === "fail")
        expect(status.baseline.blocker).toContain("exit 7");
      if (scenario === "timeout")
        expect(status.validationSkips).toEqual(["check"]);
    } finally {
      await f.project.cleanup();
    }
  });
}

test("baseline commands request host permission through the approving main session", async () => {
  const f = await approvedFixture();
  const owners: (string | undefined)[] = [];
  try {
    const owner = required(
      required(await f.store.getRun(f.runId)).planning,
    ).sessionId;
    f.adapter.authorizeCommand = async ({ job }) => {
      owners.push(job.sessionId);
      return { ok: job.sessionId === owner };
    };
    const run = await preflightRun(f.store, f.adapter, f.runId);
    expect(run?.baseline?.status).toBe("passed");
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners).size).toBe(1);
  } finally {
    await f.project.cleanup();
  }
});

test("continuing approved execution retries a failed baseline before dispatching an executor", async () => {
  const f = await approvedFixture();
  let dispatched = false;
  try {
    const previous = f.adapter.dispatchJob.bind(f.adapter);
    f.adapter.dispatchJob = async (job) => {
      if (job.role !== "executor") return previous(job);
      dispatched = true;
      await f.store.recordControl(f.runId, {
        status: "stopped",
        source: "human",
        facts: [],
      });
      return { ...job, outcome: "cancelled", evidence: [] };
    };
    await f.router.continuePlanning(f.runId);
    expect((await f.store.getRun(f.runId))?.baseline?.status).toBe("passed");
    expect(dispatched).toBe(true);
  } finally {
    await f.project.cleanup();
  }
});

test("changing the starting commit after a failed baseline requires a fresh native execution approval", async () => {
  const f = await approvedFixture();
  try {
    const before = (await f.store.getRun(f.runId))?.planning;
    f.adapter.requestUserInput = async () => ({
      ok: false,
      error: { code: "unsupported", message: "Awaiting the native answer" },
    });
    await f.router.dispatch("ralph-resume", `${f.runId} --base HEAD`);
    const after = (await f.store.getRun(f.runId))?.planning;
    const head = (
      await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after?.selectedCommit).toBe(head);
    expect(after?.phase).toBe("explanation_approval");
    expect(after?.executionEligibility).toBeUndefined();
    expect(after?.pending?.requestId).not.toBe(
      before?.executionEligibility?.requestId,
    );
    expect(after?.pending?.question).toContain(head);
  } finally {
    await f.project.cleanup();
  }
});

test("resume reuses the accepted baseline and an invalid artifact cannot overwrite it", async () => {
  const f = await approvedFixture();
  try {
    const accepted = await preflightRun(f.store, f.adapter, f.runId);
    expect(accepted?.baseline?.status).toBe("passed");
    await writeFile(join(f.project.directory, "unrelated.txt"), "local work");
    expect((await preflightRun(f.store, f.adapter, f.runId))?.baseline).toEqual(
      accepted?.baseline,
    );
    const artifact = accepted?.planning?.prd?.artifactPath;
    if (!artifact) throw new Error("Missing PRD");
    await writeFile(
      join(f.project.directory, artifact),
      "changed requirements",
    );
    await expect(preflightRun(f.store, f.adapter, f.runId)).rejects.toThrow(
      "Approved planning artifacts changed",
    );
    expect((await f.store.getRun(f.runId))?.baseline).toEqual(
      accepted?.baseline,
    );
  } finally {
    await f.project.cleanup();
  }
});
