import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandConfigHash,
  parseCommandConfig,
} from "../../src/config/commands.js";
import { controllableClock } from "../helpers/clock.js";
import { diamondFixture as fixture, gate, until } from "../helpers/diamond.js";
import { required } from "../helpers/single-issue.js";

async function diagnostic(
  f: Awaited<ReturnType<typeof fixture>>,
  cause: unknown,
): Promise<never> {
  const run = await f.store.getRun(f.runId);
  throw new Error(
    `${String(cause)}: ${JSON.stringify(Object.values(run?.issueAttempts ?? {}).map((a) => ({ issueId: a.issueId, attempt: a.attempt, status: a.status, error: a.error, history: a.history?.map((h) => h.error) })))}`,
  );
}

test("diamond execution overlaps within two slots; only integrated parents unlock D", async () => {
  const f = await fixture();
  const b = gate(),
    c = gate(),
    e = gate();
  f.holds.set("B", b);
  f.holds.set("C", c);
  f.holds.set("E", e);
  const pending = f.router.scheduleIssues(f.runId);
  try {
    await until(() =>
      f.jobs.some((j) => j.issueId === "B" && j.role === "executor"),
    ).catch((cause) => diagnostic(f, cause));
    expect(
      f.jobs
        .filter((j) => j.role === "executor")
        .slice(0, 2)
        .map((j) => j.issueId)
        .sort(),
    ).toEqual(["A", "E"]);
    expect(
      f.jobs
        .filter((j) => j.role === "executor")
        .map((j) => j.issueId)
        .slice(2),
    ).toEqual(["B"]);
    e.release();
    await until(() =>
      f.jobs.some((j) => j.issueId === "C" && j.role === "executor"),
    );
    const duplicate = f.router.scheduleIssues(f.runId);
    b.release();
    await until(
      async () =>
        (await f.store.getRun(f.runId))?.issueAttempts?.B?.status ===
        "integrated",
    );
    expect(f.jobs.some((j) => j.issueId === "D")).toBe(false);
    c.release();
    await pending;
    await duplicate;
    const run = required(await f.store.getRun(f.runId));
    expect(run.execution?.issues.every((i) => i.status === "integrated")).toBe(
      true,
    );
    expect(f.jobs.filter((j) => j.role === "executor")).toHaveLength(5);
    const mergers = f.jobs.filter((j) => j.role === "merger");
    for (const [index, merger] of mergers.entries()) {
      expect(merger.baseCommit).toBe(
        index === 0
          ? f.project.commit
          : required(
              run.issueAttempts?.[required(mergers[index - 1]?.issueId)]
                ?.integratedCommit,
            ),
      );
    }
    const events = await f.store.events(f.runId);
    expect(
      events.some((event) =>
        event.snapshot.execution?.issues.some(
          (i) => i.status === "integration_queued",
        ),
      ),
    ).toBe(true);
  } finally {
    b.release();
    c.release();
    e.release();
    await pending;
    await f.project.cleanup();
  }
}, 90000);

test("exhausted B blocks D while C and independent E continue", async () => {
  const f = await fixture();
  f.failures.add("B");
  try {
    const run = required(await f.router.scheduleIssues(f.runId));
    expect(
      f.jobs.filter((j) => j.role === "executor" && j.issueId === "B"),
    ).toHaveLength(3);
    expect(run.execution?.issues.find((i) => i.id === "D")?.status).toBe(
      "blocked",
    );
    expect(run.execution?.issues.find((i) => i.id === "E")?.status).toBe(
      "integrated",
    );
    expect(run.execution?.issues.find((i) => i.id === "C")?.status).toBe(
      "integrated",
    );
    await f.router.scheduleIssues(f.runId);
    expect(
      f.jobs.filter((j) => j.role === "executor" && j.issueId === "B"),
    ).toHaveLength(3);
  } finally {
    await f.project.cleanup();
  }
}, 90000);

async function approveCommands(
  f: Awaited<ReturnType<typeof fixture>>,
  config: ReturnType<typeof parseCommandConfig>,
) {
  await writeFile(
    join(f.project.directory, ".ralph/commands.json"),
    JSON.stringify(config),
  );
  let run = required(await f.store.getRun(f.runId));
  const planning = required(run.planning);
  planning.commandHash = commandConfigHash(config);
  required(planning.approval).commandHash = planning.commandHash;
  required(planning.approval).commandRevision = config.revision;
  required(planning.proposalContext).commandHash = planning.commandHash;
  required(planning.proposalContext).commandRevision = config.revision;
  required(planning.executionEligibility).commandHash = planning.commandHash;
  required(planning.executionEligibility).commandRevision = config.revision;
  await f.store.recordPlanning(f.runId, run.revision, planning);
  run = required(await f.store.getRun(f.runId));
  const baseline = required(run.baseline);
  baseline.commandHash = planning.commandHash;
  await f.store.recordBaseline(f.runId, run.revision, baseline, []);
  f.adapter.authorizeCommand = async () => ({ ok: true });
}

test("approved service templates allocate distinct ports, namespaces and owned directories", async () => {
  const f = await fixture();
  const a = gate(),
    e = gate();
  f.holds.set("A", a);
  f.holds.set("E", e);
  const env = {
    PORT: "RALPH_PORT",
    NAMESPACE: "RALPH_NAMESPACE",
    DIRECTORY: "RALPH_DIRECTORY",
  };
  const spec = {
    executable: process.execPath,
    cwd: ".",
    timeoutMs: 5000,
    platforms: ["darwin", "linux", "win32"],
    env,
  };
  const config = parseCommandConfig({
    ...f.config,
    resources: {
      RALPH_PORT: "port",
      RALPH_NAMESPACE: "namespace",
      RALPH_DIRECTORY: "directory",
    },
    commands: [
      {
        ...spec,
        id: "setup",
        phase: "setup",
        args: [
          "-e",
          'require("fs").writeFileSync(require("path").join(process.env.DIRECTORY,"resource.json"),JSON.stringify(process.env))',
        ],
      },
      ...f.config.commands,
      {
        ...spec,
        id: "start",
        phase: "start",
        args: [
          "-e",
          "Bun.serve({port:Number(process.env.PORT),fetch:()=>new Response(process.env.NAMESPACE)});setInterval(()=>{},1000)",
        ],
      },
      {
        ...spec,
        id: "ready",
        phase: "readiness",
        args: [
          "-e",
          'fetch("http://127.0.0.1:"+process.env.PORT).then(r=>r.text()).then(t=>process.exit(t===process.env.NAMESPACE?0:1)).catch(()=>process.exit(1))',
        ],
      },
    ],
  });
  await approveCommands(f, config);
  const pending = f.router.scheduleIssues(f.runId);
  try {
    await until(() => f.jobs.filter((j) => j.role === "executor").length === 2);
    const jobs = f.jobs.filter((j) => j.role === "executor");
    const resources = await Promise.all(
      jobs.map(async (job) => {
        const values = required(job.environment);
        return JSON.parse(
          await readFile(
            join(required(values.RALPH_DIRECTORY), "resource.json"),
            "utf8",
          ),
        );
      }),
    );
    expect(resources[0].PORT).not.toBe(resources[1].PORT);
    expect(resources[0].NAMESPACE).not.toBe(resources[1].NAMESPACE);
    expect(resources[0].DIRECTORY).not.toBe(resources[1].DIRECTORY);
    for (const resource of resources)
      expect(
        await (await fetch(`http://127.0.0.1:${resource.PORT}`)).text(),
      ).toBe(resource.NAMESPACE);
    a.release();
    await until(
      async () =>
        (await f.store.getRun(f.runId))?.issueAttempts?.A?.status ===
        "integrated",
    );
    const remaining = resources[jobs.findIndex((job) => job.issueId === "E")];
    expect(
      await (await fetch(`http://127.0.0.1:${remaining.PORT}`)).text(),
    ).toBe(remaining.NAMESPACE);
    expect(
      await Bun.file(join(remaining.DIRECTORY, "resource.json")).exists(),
    ).toBe(true);
    e.release();
    await pending;
    for (const resource of resources) {
      expect(
        await fetch(`http://127.0.0.1:${resource.PORT}`).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await Bun.file(join(resource.DIRECTORY, "resource.json")).exists(),
      ).toBe(false);
    }
  } finally {
    a.release();
    e.release();
    await pending;
    await f.project.cleanup();
  }
}, 90000);

test("a submitted executor releases its slot while the serial integrator is held", async () => {
  const f = await fixture();
  const run = required(await f.store.getRun(f.runId));
  const planning = required(run.planning);
  planning.settings.concurrency = 1;
  await f.store.recordPlanning(f.runId, run.revision, planning);
  const merger = gate();
  f.holds.set("merge:A", merger);
  const pending = f.router.scheduleIssues(f.runId);
  try {
    await until(() =>
      f.jobs.some((j) => j.role === "merger" && j.issueId === "A"),
    );
    await until(() =>
      f.jobs.some((j) => j.role === "executor" && j.issueId === "E"),
    );
    await until(
      async () =>
        (await f.store.getRun(f.runId))?.issueAttempts?.E?.status ===
        "submitted",
    ).catch((cause) => diagnostic(f, cause));
    expect(
      f.jobs.filter((j) => j.role === "merger").map((j) => j.issueId),
    ).toEqual(["A"]);
    await until(async () =>
      JSON.parse(
        await f.router.status(f.runId),
      ).execution.integrationQueue.includes("E"),
    );
    const status = JSON.parse(await f.router.status(f.runId));
    expect(status.execution.integrationQueue).toEqual(["A", "E"]);
    expect(f.jobs.some((j) => j.issueId === "B")).toBe(false);
    merger.release();
    await pending;
  } finally {
    merger.release();
    await pending;
    await f.project.cleanup();
  }
}, 90000);

test("shared approved resources serialize use and release only the owned lease", async () => {
  const f = await fixture();
  await approveCommands(
    f,
    parseCommandConfig({
      ...f.config,
      resources: { RALPH_DIRECTORY: "directory" },
      exclusiveResources: ["fixture-shared-service"],
    }),
  );
  const a = gate(),
    e = gate();
  f.holds.set("A", a);
  f.holds.set("E", e);
  const pending = f.router.scheduleIssues(f.runId);
  try {
    await until(() => f.jobs.some((j) => j.role === "executor"));
    const first = required(f.jobs.find((j) => j.role === "executor"));
    const firstId = required(first.issueId);
    const secondId = firstId === "A" ? "E" : "A";
    await until(async () =>
      Object.values((await f.store.getRun(f.runId))?.operations ?? {}).some(
        (op) =>
          op.kind === "execution.environment" &&
          op.job.issueId === secondId &&
          op.status === "intent",
      ),
    );
    expect(f.jobs.some((j) => j.issueId === secondId)).toBe(false);
    expect(
      JSON.parse(await f.router.status(f.runId)).execution.issues.find(
        (i: { id: string }) => i.id === firstId,
      ).status,
    ).toBe("running");
    required(f.holds.get(firstId)).release();
    await until(() => f.jobs.some((j) => j.issueId === secondId));
    const second = required(f.jobs.find((j) => j.issueId === secondId));
    const { stat } = await import("node:fs/promises");
    expect(
      await stat(required(first.environment?.RALPH_DIRECTORY)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      (await stat(required(second.environment?.RALPH_DIRECTORY))).isDirectory(),
    ).toBe(true);
    required(f.holds.get(secondId)).release();
    await pending;
  } finally {
    a.release();
    e.release();
    await pending;
    await f.project.cleanup();
  }
}, 90000);

test("invalid executor concurrency blocks before dispatch", async () => {
  const f = await fixture();
  try {
    for (const concurrency of [0, -1, 1.5]) {
      const run = required(await f.store.getRun(f.runId));
      const planning = required(run.planning);
      planning.settings.concurrency = concurrency;
      await f.store.recordPlanning(f.runId, run.revision, planning);
      await expect(f.router.scheduleIssues(f.runId)).rejects.toThrow(
        "positive integer",
      );
    }
    expect(f.jobs).toHaveLength(0);
  } finally {
    await f.project.cleanup();
  }
});

test("integration with run-local omissions unlocks dependents and preserves verification debt", async () => {
  const f = await fixture();
  try {
    const initial = required(await f.store.getRun(f.runId));
    await f.store.recordBaseline(
      f.runId,
      initial.revision,
      { ...required(initial.baseline), status: "passed_with_omissions" },
      ["test"],
    );
    const run = required(await f.router.scheduleIssues(f.runId));
    expect(run.execution?.issues.find((i) => i.id === "D")?.status).toBe(
      "integrated",
    );
    expect(run.execution?.verification).toBe("incomplete");
    expect(run.execution?.checks.every((c) => c.status === "skipped")).toBe(
      true,
    );
    expect(run.validationSkips).toEqual(["test"]);
    expect(
      await readFile(join(f.project.directory, ".ralph/commands.json"), "utf8"),
    ).toBe(JSON.stringify(f.config));
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("an unrelated journal update cannot turn a timed-out check into an issue repair", async () => {
  const f = await fixture();
  const time = controllableClock();
  await approveCommands(
    f,
    parseCommandConfig({
      ...f.config,
      commands: [
        {
          ...required(f.config.commands[0]),
          id: "hung",
          args: [
            "-e",
            'require("fs").writeFileSync("hung-ready","ready");setInterval(()=>{},1000)',
          ],
        },
        {
          ...required(f.config.commands[0]),
          id: "cleanup",
          phase: "cleanup",
          args: ["-e", 'require("fs").rmSync("hung-ready",{force:true})'],
        },
      ],
    }),
  );
  const e = gate();
  f.holds.set("E", e);
  const record = f.store.recordBaseline.bind(f.store);
  let raced = false;
  f.store.recordBaseline = async (...args) => {
    if (!raced) {
      raced = true;
      await f.store.recordControl(f.runId, {
        status: "active",
        source: "human",
      });
    }
    return record(...args);
  };
  const pending = f.router.scheduleIssues(f.runId, { clock: time.clock });
  try {
    await until(async () => {
      const candidate = (await f.store.getRun(f.runId))?.issueAttempts?.A
        ?.candidate;
      return (
        !!candidate &&
        (await Bun.file(join(candidate.job.workspace, "hung-ready")).exists())
      );
    });
    time.advance(5000);
    await until(async () => {
      const attempt = (await f.store.getRun(f.runId))?.issueAttempts?.A;
      return (
        !!attempt && (attempt.attempt !== 1 || attempt.status === "integrated")
      );
    });
    const attempt = required((await f.store.getRun(f.runId))?.issueAttempts?.A);
    expect(attempt.history?.[0]?.error).toBeUndefined();
    expect(attempt.status).toBe("integrated");
    expect(attempt.attempt).toBe(1);
    e.release();
    const run = required(await pending);
    expect(run.validationSkips).toEqual(["hung"]);
    expect(run.execution?.issues.every((i) => i.status === "integrated")).toBe(
      true,
    );
    expect(run.execution?.verification).toBe("incomplete");
  } finally {
    e.release();
    time.advance(5000);
    await f.router.dispatch("ralph-stop", f.runId);
    await pending;
    await f.project.cleanup();
  }
}, 90000);

test("single-issue calls share the configured executor cap", async () => {
  const f = await fixture();
  const initial = required(await f.store.getRun(f.runId));
  const planning = required(initial.planning);
  planning.settings.concurrency = 1;
  await f.store.recordPlanning(f.runId, initial.revision, planning);
  const a = gate(),
    e = gate();
  f.holds.set("A", a);
  f.holds.set("E", e);
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  let active = 0,
    maximum = 0;
  f.adapter.dispatchJob = async (job) => {
    if (job.role !== "executor") return dispatch(job);
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await dispatch(job);
    } finally {
      active--;
    }
  };
  const first = f.router.executeIssue(f.runId, "A");
  await until(() => f.jobs.some((j) => j.issueId === "A"));
  const second = f.router.executeIssue(f.runId, "E");
  try {
    await Bun.sleep(500);
    a.release();
    await until(() => f.jobs.some((j) => j.issueId === "E"));
    e.release();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect((await f.store.getRun(f.runId))?.issueAttempts?.E?.status).toBe(
      "integrated",
    );
  } finally {
    a.release();
    e.release();
    await Promise.all([first, second]);
    await f.project.cleanup();
  }
}, 90000);

test("integrated execution hands the exact frozen commit to the host's final review coordinator", async () => {
  const f = await fixture();
  try {
    let reviewed: string | undefined;
    f.adapter.finalizeExecution = async (snapshot) => {
      reviewed = snapshot.commit;
    };
    await f.router.scheduleIssues(f.runId);
    const run = required(await f.store.getRun(f.runId));
    expect(reviewed).toBe(run.review?.snapshot.commit);
    expect(reviewed).toMatch(/^[a-f0-9]{40}$/);
    expect(f.jobs.some((j) => j.role === "code-review")).toBe(false);
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("executor admission preserves graph order when the first state read is delayed", async () => {
  const f = await fixture();
  const firstRead = gate(),
    readEntered = gate(),
    bHeld = gate(),
    cHeld = gate();
  let b: Promise<unknown> | undefined, c: Promise<unknown> | undefined;
  const read = f.store.getRun.bind(f.store);
  try {
    const run = required(await read(f.runId));
    const planning = required(run.planning);
    planning.settings.concurrency = 1;
    await f.store.recordPlanning(f.runId, run.revision, planning);
    await f.router.executeIssue(f.runId, "A");
    const snapshot = required(await read(f.runId));
    let reads = 0;
    f.store.getRun = async (id) => {
      const current = ++reads;
      if (current === 1) {
        readEntered.release();
        await firstRead.promise;
        return structuredClone(snapshot);
      }
      if (current === 2) return structuredClone(snapshot);
      return read(id);
    };
    f.holds.set("B", bHeld);
    f.holds.set("C", cHeld);
    const { executeIssue } = await import(
      "../../src/execution/execute-issue.js"
    );
    b = executeIssue(f.store, f.adapter, f.runId, "B");
    await readEntered.promise;
    c = executeIssue(f.store, f.adapter, f.runId, "C");
    await Bun.sleep(0); // Drain C's immediately resolved read while B remains held.
    firstRead.release();
    await until(() =>
      f.jobs.some(
        (j) => j.role === "executor" && ["B", "C"].includes(j.issueId ?? ""),
      ),
    );
    expect(
      f.jobs
        .filter(
          (j) => j.role === "executor" && ["B", "C"].includes(j.issueId ?? ""),
        )
        .map((j) => j.issueId),
    ).toEqual(["B"]);
  } finally {
    firstRead.release();
    bHeld.release();
    cHeld.release();
    await Promise.allSettled([b, c]);
    f.store.getRun = read;
    await f.project.cleanup();
  }
}, 90000);
