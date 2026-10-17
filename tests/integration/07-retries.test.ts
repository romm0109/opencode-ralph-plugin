import { expect, setDefaultTimeout, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { validateCandidate } from "../../src/execution/validation.js";
import { controllableClock, eventually } from "../helpers/clock.js";
import { required, singleIssueFixture } from "../helpers/single-issue.js";

setDefaultTimeout(30000);

test("two failed candidates repair with real logs and integrate attempt three", async () => {
  const f = await singleIssueFixture();
  try {
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    const prompts: string[] = [];
    f.adapter.dispatchJob = async (job) => {
      if (job.role === "executor") {
        prompts.push(job.prompt);
        f.setMode("success");
      } else f.setMode(job.attempt < 3 ? "validation" : "success");
      return dispatch(job);
    };
    const router = createCommandRouter(f.store, f.adapter);
    const result = await router.executeIssue(f.runId, "A");
    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(3);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("expect(received)");
    expect(prompts[2]).toContain("submittedCommit");
    const status = JSON.parse(await router.status(f.runId));
    expect(status.issueAttempts.A.attempt).toBe(3);
  } finally {
    await f.project.cleanup();
  }
});

test("three executor setup failures exhaust once, concurrent and repeated calls cannot dispatch a fourth", async () => {
  const f = await singleIssueFixture();
  try {
    let dispatched = 0;
    f.adapter.dispatchJob = async () => {
      dispatched++;
      throw new Error("fixture SDK setup failure");
    };
    const router = createCommandRouter(f.store, f.adapter);
    await Promise.allSettled([
      router.executeIssue(f.runId, "A"),
      router.executeIssue(f.runId, "A"),
    ]);
    const result = await router.executeIssue(f.runId, "A");
    expect(result.status).toBe("exhausted");
    expect(result.attempt).toBe(3);
    expect(dispatched).toBe(3);
    expect(result.history).toHaveLength(2);
    expect(result.error?.message).toContain("fixture SDK setup failure");
    expect((await router.executeIssue(f.runId, "A")).attempt).toBe(3);
    expect(dispatched).toBe(3);
  } finally {
    await f.project.cleanup();
  }
});

test("missing approved command configuration blocks native execution before spending an issue attempt", async () => {
  const f = await singleIssueFixture();
  try {
    await rm(join(f.project.directory, ".ralph/commands.json"));
    const router = createCommandRouter(f.store, f.adapter);
    await expect(router.executeIssue(f.runId, "A")).rejects.toThrow(
      "Check .ralph/project.json and commands.json",
    );
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A).toBeUndefined();
    expect(f.fake.requests).toHaveLength(0);
  } finally {
    await f.project.cleanup();
  }
});

test("stuck executor is cancelled before repair and late output cannot advance active attempt", async () => {
  const f = await singleIssueFixture();
  const time = controllableClock();
  try {
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    let release: (() => void) | undefined;
    let held: Promise<unknown> | undefined;
    let repairs = 0;
    let releaseLate: (() => void) | undefined;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const cancel = f.adapter.cancelJob.bind(f.adapter);
    f.adapter.cancelJob = async (job) => {
      const result = await cancel(job);
      f.fake.release();
      return result;
    };
    f.adapter.dispatchJob = async (job) => {
      if (job.role === "executor" && job.attempt === 1) {
        f.fake.hold();
        held = dispatch(job);
        await eventually(() =>
          f.fake.requests.some((r) => r.path.endsWith("/wait")),
        );
        release = () => releaseLate?.();
        return held.then(async (result) => {
          await late;
          return result;
        }) as ReturnType<typeof dispatch>;
      }
      if (job.role === "executor") {
        repairs++;
        expect(f.fake.requests.some((r) => r.path.endsWith("/interrupt"))).toBe(
          true,
        );
      }
      return dispatch(job);
    };
    const router = createCommandRouter(f.store, f.adapter);
    const running = router.executeIssue(f.runId, "A", { clock: time.clock });
    await eventually(() => !!release);
    time.advance(30000);
    const result = await running;
    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(2);
    expect(result.history?.[0]?.error?.code).toBe("agent-timeout");
    release?.();
    await held;
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.operationId).toBe(
      result.operationId,
    );
    expect(repairs).toBe(1);
  } finally {
    await f.project.cleanup();
  }
});

test("denied executor permission waits without fabricating a repair", async () => {
  const f = await singleIssueFixture();
  try {
    f.fake.denyTool();
    const result = await createCommandRouter(f.store, f.adapter).executeIssue(
      f.runId,
      "A",
    );
    expect(result.status).toBe("waiting");
    expect(result.attempt).toBe(1);
    expect(
      f.fake.requests.filter((r) => r.path === "/api/session"),
    ).toHaveLength(1);
  } finally {
    await f.project.cleanup();
  }
});

test("denied validation permission waits and never becomes a timeout skip or repair", async () => {
  const f = await singleIssueFixture();
  try {
    f.adapter.authorizeCommand = async () => ({
      ok: false,
      error: { code: "permission-denied", message: "Denied fixture check" },
    });
    const result = await createCommandRouter(f.store, f.adapter).executeIssue(
      f.runId,
      "A",
    );
    expect(result.status).toBe("waiting");
    expect(result.attempt).toBe(1);
    expect((await f.store.getRun(f.runId))?.validationSkips).toEqual([]);
  } finally {
    await f.project.cleanup();
  }
});

function hungCheck(id = "hung") {
  return {
    id,
    phase: "check" as const,
    executable: process.execPath,
    args: [
      "-e",
      'require("fs").writeFileSync("hung-ready", "ready"); setInterval(()=>{},1000)',
    ],
    cwd: ".",
    timeoutMs: 5000,
    platforms: ["darwin", "linux", "win32"] as ("darwin" | "linux" | "win32")[],
    env: {},
  };
}
test("all hung checks are omitted with incomplete status, immutable config and fresh-run retry", async () => {
  const f = await singleIssueFixture({
    commands: [
      hungCheck(),
      {
        ...hungCheck("cleanup"),
        phase: "cleanup",
        args: ["-e", 'require("fs").rmSync("hung-ready",{force:true})'],
      },
    ],
  });
  const time = controllableClock();
  try {
    const configPath = join(f.project.directory, ".ralph/commands.json");
    const original = await readFile(configPath, "utf8");
    const router = createCommandRouter(f.store, f.adapter);
    const running = router.executeIssue(f.runId, "A", { clock: time.clock });
    await eventually(async () => {
      const attempt = (await f.store.getRun(f.runId))?.issueAttempts?.A;
      return (
        !!attempt?.candidate &&
        !!(await Bun.file(
          join(attempt.candidate.job.workspace, "hung-ready"),
        ).exists())
      );
    });
    const scheduled = time.pending;
    expect(scheduled).toBeGreaterThan(0);
    time.advance(5000);
    expect(time.pending).toBeLessThan(scheduled);
    // The injected deadline must fire now; Git integration and owned cleanup
    // still use real I/O and finish under this test's unchanged outer deadline.
    const result = await running;
    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(1);
    expect(result.validation?.status).toBe("passed_with_omissions");
    expect(result.validation?.checks[0]?.status).toBe("skipped");
    expect((await f.store.getRun(f.runId))?.validationSkips).toEqual(["hung"]);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(
      JSON.parse(await router.status(f.runId)).issueAttempts.A.validation
        .status,
    ).toBe("passed_with_omissions");
    const next = await f.store.createRun("feature-next");
    expect(next.validationSkips ?? []).toEqual([]);
    const run = required(await f.store.getRun(f.runId));
    await f.store.recordPlanning(
      next.runId,
      next.revision,
      required(run.planning),
    );
    const nextRun = required(await f.store.getRun(next.runId));
    await f.store.recordBaseline(
      next.runId,
      nextRun.revision,
      required(run.baseline),
      [],
    );
    const validationJob = {
      ...required(result.candidate).job,
      workspace: f.workspace,
      baseCommit: required(result.integratedCommit),
      sessionId: required(result.mergerSessionId),
      jobId: "later-validation",
    };
    const sameRun = await validateCandidate({
      store: f.store,
      adapter: f.adapter,
      job: validationJob,
      config: f.config,
      sourceWorkspace: f.project.directory,
      clock: time.clock,
    });
    expect(sameRun.checks[0]?.result).toBeUndefined();
    expect(sameRun.status).toBe("passed_with_omissions");
    const retried = validateCandidate({
      store: f.store,
      adapter: f.adapter,
      job: { ...validationJob, runId: next.runId },
      config: f.config,
      sourceWorkspace: f.project.directory,
      clock: time.clock,
    });
    await eventually(() => Bun.file(join(f.workspace, "hung-ready")).exists());
    time.advance(5000);
    const nextValidation = await retried;
    expect(nextValidation.checks[0]?.result?.status).toBe("timed_out");
    expect(await readFile(configPath, "utf8")).toBe(original);
  } finally {
    await f.project.cleanup();
  }
}, 15000);

test("a dispatch exception cancels a still-owned session and reconciles saved workspace before retry", async () => {
  const f = await singleIssueFixture();
  try {
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    const cancel = f.adapter.cancelJob.bind(f.adapter);
    let cancelled = false;
    let abandoned: Promise<unknown> | undefined;
    f.adapter.cancelJob = async (job) => {
      const result = await cancel(job);
      cancelled = true;
      f.fake.release();
      return result;
    };
    f.adapter.dispatchJob = async (job) => {
      if (job.role === "executor" && job.attempt === 1) {
        f.fake.hold();
        abandoned = dispatch(job);
        await eventually(() =>
          f.fake.requests.some((r) => r.path.endsWith("/wait")),
        );
        throw new Error("Lost response while agent remains active");
      }
      if (job.role === "executor") {
        expect(cancelled).toBe(true);
        expect(job.prompt).toContain("reconciledWork");
      }
      return dispatch(job);
    };
    const result = await createCommandRouter(f.store, f.adapter).executeIssue(
      f.runId,
      "A",
    );
    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(2);
    await abandoned;
  } finally {
    f.fake.release();
    await f.project.cleanup();
  }
});

for (const role of ["executor", "merger"]) {
  test(`three stuck ${role} jobs exhaust the shared budget without a fourth`, async () => {
    const f = await singleIssueFixture();
    const time = controllableClock();
    try {
      const dispatch = f.adapter.dispatchJob.bind(f.adapter);
      const cancel = f.adapter.cancelJob.bind(f.adapter);
      const held: Promise<unknown>[] = [];
      let stuck = 0;
      f.adapter.cancelJob = async (job) => {
        const result = await cancel(job);
        f.fake.release();
        return result;
      };
      f.adapter.dispatchJob = async (job) => {
        if (job.role === role) {
          f.fake.hold();
          const result = dispatch(job);
          held.push(result);
          stuck++;
          return result;
        }
        return dispatch(job);
      };
      const router = createCommandRouter(f.store, f.adapter);
      const running = router.executeIssue(f.runId, "A", { clock: time.clock });
      for (let attempt = 1; attempt <= 3; attempt++) {
        await eventually(async () => {
          const run = await f.store.getRun(f.runId);
          const jobs = Object.values(run?.jobs ?? {}).filter(
            (j) => j.envelope.role === role && j.envelope.attempt === attempt,
          );
          return (
            stuck === attempt &&
            jobs.some((j) => !!j.envelope.sessionId) &&
            f.fake.requests.filter((r) => r.path.endsWith("/wait")).length >=
              attempt * (role === "merger" ? 2 : 1)
          );
        });
        time.advance(30000);
      }
      const result = await running;
      expect(result.status).toBe("exhausted");
      expect(result.attempt).toBe(3);
      expect(stuck).toBe(3);
      expect(result.error?.code).toBe("agent-timeout");
      await Promise.all(held);
      await router.executeIssue(f.runId, "A", { clock: time.clock });
      expect(stuck).toBe(3);
      expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.status).toBe(
        "exhausted",
      );
    } finally {
      f.fake.release();
      await f.project.cleanup();
    }
  }, 15000);
}

test("timed-out check is skipped on repair while ordinary failed checks return logs and run again", async () => {
  const check = {
    ...hungCheck("behavior"),
    args: ["test", "behavior.test.ts"],
  };
  const f = await singleIssueFixture({ commands: [hungCheck(), check] });
  const time = controllableClock();
  try {
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    f.adapter.dispatchJob = async (job) => {
      f.setMode(
        job.role === "merger" && job.attempt === 1 ? "validation" : "success",
      );
      return dispatch(job);
    };
    const running = createCommandRouter(f.store, f.adapter).executeIssue(
      f.runId,
      "A",
      { clock: time.clock },
    );
    await eventually(async () => {
      const attempt = (await f.store.getRun(f.runId))?.issueAttempts?.A;
      return (
        !!attempt?.candidate &&
        !!(await Bun.file(
          join(attempt.candidate.job.workspace, "hung-ready"),
        ).exists())
      );
    });
    time.advance(5000);
    const result = await running;
    expect(result.status).toBe("integrated");
    expect(result.attempt).toBe(2);
    expect(result.validation?.status).toBe("passed_with_omissions");
    expect(
      result.history?.[0]?.validation?.checks.map((c) => c.status),
    ).toEqual(["skipped", "failed"]);
    expect(result.validation?.checks.map((c) => c.status)).toEqual([
      "skipped",
      "passed",
    ]);
    expect(result.validation?.checks[0]?.result).toBeUndefined();
    expect(result.job.prompt).toContain("expect(received)");
    expect((await f.store.getRun(f.runId))?.validationSkips).toEqual(["hung"]);
  } finally {
    await f.project.cleanup();
  }
}, 15000);

test("setup timeouts consume attempts and are never validation skips", async () => {
  const f = await singleIssueFixture({
    commands: [
      { ...hungCheck("setup"), phase: "setup" },
      { ...hungCheck("test"), args: ["test", "behavior.test.ts"] },
    ],
  });
  const time = controllableClock();
  try {
    const running = createCommandRouter(f.store, f.adapter).executeIssue(
      f.runId,
      "A",
      { clock: time.clock },
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      await eventually(async () => {
        const stored = (await f.store.getRun(f.runId))?.issueAttempts?.A;
        return (
          stored?.attempt === attempt &&
          (await Bun.file(join(stored.job.workspace, "hung-ready")).exists())
        );
      });
      time.advance(5000);
    }
    const result = await running;
    expect(result.status).toBe("exhausted");
    expect(result.attempt).toBe(3);
    expect(result.environment?.lifecycle[0]?.status).toBe("timed_out");
    expect(result.validation).toBeUndefined();
    expect(result.candidate).toBeUndefined();
    expect((await f.store.getRun(f.runId))?.validationSkips).toEqual([]);
  } finally {
    await f.project.cleanup();
  }
}, 15000);

test("stop kills an active check without labelling it a timeout or scheduling repairs", async () => {
  const f = await singleIssueFixture({ commands: [hungCheck()] });
  const time = controllableClock();
  try {
    const router = createCommandRouter(f.store, f.adapter);
    const running = router.executeIssue(f.runId, "A", { clock: time.clock });
    await eventually(async () => {
      const stored = (await f.store.getRun(f.runId))?.issueAttempts?.A;
      return (
        !!stored?.candidate &&
        (await Bun.file(
          join(stored.candidate.job.workspace, "hung-ready"),
        ).exists())
      );
    });
    await router.dispatch("ralph-stop", f.runId);
    const result = await running;
    expect(result.attempt).toBe(1);
    expect(result.validation?.checks[0]?.result?.status).toBe("cancelled");
    expect((await f.store.getRun(f.runId))?.validationSkips).toEqual([]);
    expect(
      f.fake.requests.filter((r) => r.path === "/api/session"),
    ).toHaveLength(2);
  } finally {
    await f.project.cleanup();
  }
}, 15000);

for (const kind of ["spawn_error", "setup_failed"] as const) {
  test(`${kind} remains a typed failure and never disables an approved check`, async () => {
    const command = {
      ...hungCheck(),
      executable:
        kind === "spawn_error"
          ? "ralph-nonexistent-fixture-executable"
          : process.execPath,
      env:
        kind === "setup_failed"
          ? { FIXTURE: "RALPH_ABSENT_RETRY_FIXTURE_ENV" }
          : {},
    };
    const f = await singleIssueFixture({ commands: [command] });
    try {
      const result = await createCommandRouter(f.store, f.adapter).executeIssue(
        f.runId,
        "A",
      );
      expect(result.status).toBe("exhausted");
      expect(result.validation?.checks[0]?.result?.status).toBe(kind);
      expect((await f.store.getRun(f.runId))?.validationSkips).toEqual([]);
    } finally {
      await f.project.cleanup();
    }
  });
}

test("issue agents default to a visible thirty-minute deadline", async () => {
  const f = await singleIssueFixture();
  try {
    const run = required(await f.store.getRun(f.runId));
    const planning = required(run.planning);
    delete planning.settings.agentTimeoutMs;
    await f.store.recordPlanning(f.runId, run.revision, planning);
    const router = createCommandRouter(f.store, f.adapter);
    const result = await router.executeIssue(f.runId, "A");
    expect(result.agentTimeoutMs).toBe(1800000);
    expect(
      JSON.parse(await router.status(f.runId)).issueAttempts.A.agentTimeoutMs,
    ).toBe(1800000);
  } finally {
    await f.project.cleanup();
  }
});

test("duplicate agent failure results do not charge additional attempts", async () => {
  const f = await singleIssueFixture();
  try {
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    let calls = 0;
    f.adapter.dispatchJob = async (job) => {
      calls++;
      f.fake.empty();
      const result = await dispatch(job);
      expect(await f.store.recordResult(result)).toBe(false);
      expect(await f.store.recordResult(result)).toBe(false);
      return result;
    };
    const router = createCommandRouter(f.store, f.adapter);
    const result = await router.executeIssue(f.runId, "A");
    expect(result.status).toBe("exhausted");
    expect(calls).toBe(3);
    expect((await f.store.getRun(f.runId))?.phase).toBe("running");
    await router.executeIssue(f.runId, "A");
    expect(calls).toBe(3);
  } finally {
    await f.project.cleanup();
  }
});
