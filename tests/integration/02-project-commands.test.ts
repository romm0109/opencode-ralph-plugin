import { expect, test } from "bun:test";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";

test("command discovery inherits the invoking session model", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    const store = await openRunStore(project.directory);
    const adapter = createOpenCodeAdapter(fake.client, store);
    const model = { providerID: "openai", modelID: "selected-model" };
    let requestedSession: string | undefined;
    adapter.getSessionModel = async (sessionId) => {
      requestedSession = sessionId;
      return model;
    };
    await createCommandRouter(store, adapter).setupProject({
      workspace: project.directory,
      sessionId: "invoking-session",
    });
    expect(requestedSession).toBe("invoking-session");
    const creation = fake.requests.find((call) => call.path === "/api/session");
    expect(creation?.body.model).toEqual({
      providerID: model.providerID,
      id: model.modelID,
    });
  } finally {
    await project.cleanup();
  }
});

test("rejected proposal never saves executable configuration", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    fake.respond(
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        commands: [
          {
            id: "check",
            phase: "check",
            executable: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: ".",
            timeoutMs: 1000,
            platforms: ["darwin", "linux", "win32"],
            env: {},
          },
        ],
        rationale: "Only a check exists in this fixture.",
      }),
    );
    const store = await openRunStore(project.directory);
    const adapter = createOpenCodeAdapter(fake.client, store);
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      messageId: "human-1",
      source: "user",
      text: "reject",
    });
    const router = createCommandRouter(store, adapter);
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("rejected");
    expect(
      await access(join(project.directory, ".ralph/commands.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await project.cleanup();
  }
});

test("approved exact revision is saved and verified through the command boundary", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    fake.respond(
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        commands: [
          {
            id: "check",
            phase: "check",
            executable: process.execPath,
            args: ["-e", "console.log('passed')"],
            cwd: ".",
            timeoutMs: 2000,
            platforms: ["darwin", "linux", "win32"],
            env: {},
          },
        ],
        rationale: "Fixture check.",
      }),
    );
    const store = await openRunStore(project.directory);
    const adapter = createOpenCodeAdapter(fake.client, store);
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      messageId: "human-1",
      source: "user",
      text: `approve ${request.question.match(/hash ([a-f0-9]+)/)?.[1]}`,
    });
    adapter.authorizeCommand = async () => ({ ok: true });
    const router = createCommandRouter(store, adapter);
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("verified");
    expect(await router.projectStatus(project.directory)).toMatchObject({
      status: "verified",
      hash: result.hash,
    });
    const archive = await Bun.file(
      join(store.root, "command-revisions", `${result.hash}.json`),
    ).json();
    const saved = await Bun.file(
      join(project.directory, ".ralph/commands.json"),
    ).json();
    expect(archive).toEqual(saved);
  } finally {
    await project.cleanup();
  }
});

test("lifecycle preserves argv and environment, verifies HTTP readiness and cleans the child tree", async () => {
  const project = await createTestProject("ralph command spaces ");
  const record = join(project.directory, "argv.json");
  const service = join(project.directory, "service.json");
  const cleaned = join(project.directory, "cleanup.txt");
  const previous = process.env.RALPH_FIXTURE_SECRET;
  process.env.RALPH_FIXTURE_SECRET = "fixture-sensitive-value";
  try {
    const fake = createFakeOpenCode();
    const fixture = join(import.meta.dir, "../fixtures/process-child.ts");
    const command = (id: string, phase: string, args: string[], env = {}) => ({
      id,
      phase,
      executable: process.execPath,
      args: [fixture, ...args],
      cwd: ".",
      timeoutMs: 4000,
      platforms: ["darwin", "linux", "win32"],
      env,
    });
    fake.respond(
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        rationale: "Portable fixture lifecycle.",
        commands: [
          command(
            "setup",
            "setup",
            ["record", record, "argument with spaces", "$(literal)"],
            { FIXTURE_VALUE: "RALPH_FIXTURE_SECRET" },
          ),
          command(
            "check",
            "check",
            ["record", record, "argument with spaces", "$(literal)"],
            { FIXTURE_VALUE: "RALPH_FIXTURE_SECRET" },
          ),
          command("app", "start", ["service", service]),
          command("ready", "readiness", ["readiness", service]),
          command("cleanup", "cleanup", ["cleanup", cleaned]),
        ],
      }),
    );
    const store = await openRunStore(project.directory);
    const adapter = createOpenCodeAdapter(fake.client, store);
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "human",
      text: `approve ${request.question.match(/hash ([a-f0-9]+)/)?.[1]}`,
    });
    adapter.authorizeCommand = async () => ({ ok: true });
    const result = JSON.parse(
      await createCommandRouter(store, adapter).dispatch("ralph-commands", "", {
        workspace: project.directory,
        sessionId: "main",
      }),
    );
    expect(result.status).toBe("verified");
    expect(await Bun.file(record).json()).toEqual({
      argv: ["argument with spaces", "$(literal)"],
      cwd: await realpath(project.directory),
      env: "fixture-sensitive-value",
    });
    expect(await Bun.file(cleaned).text()).toBe("cleaned");
    expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
    const saved = await Bun.file(
      join(project.directory, ".ralph/commands.json"),
    ).text();
    expect(saved).not.toContain("fixture-sensitive-value");
    expect(saved).toContain("RALPH_FIXTURE_SECRET");
    const info = await Bun.file(service).json();
    for (const pid of [info.pid, info.descendant]) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    if (previous === undefined) delete process.env.RALPH_FIXTURE_SECRET;
    else process.env.RALPH_FIXTURE_SECRET = previous;
    await project.cleanup();
  }
}, 30000);

async function workflow(
  project: Awaited<ReturnType<typeof createTestProject>>,
  commands: unknown[],
  revision = 1,
) {
  const fake = createFakeOpenCode();
  fake.respond(
    JSON.stringify({
      schemaVersion: 1,
      revision,
      commands,
      rationale: "Fixture commands; no other scripts exist.",
    }),
  );
  const store = await openRunStore(project.directory);
  const adapter = createOpenCodeAdapter(fake.client, store);
  adapter.requestUserInput = async (request) => ({
    ok: true,
    ...request,
    source: "user",
    messageId: "human",
    text: `approve ${request.question.match(/hash ([a-f0-9]+)/)?.[1]}`,
  });
  adapter.authorizeCommand = async () => ({ ok: true });
  return { router: createCommandRouter(store, adapter), adapter, store };
}
function fixtureCommand(
  id: string,
  phase: string,
  mode: string,
  args: string[] = [],
  timeoutMs = 2000,
) {
  return {
    id,
    phase,
    executable: process.execPath,
    args: [
      join(import.meta.dir, "../fixtures/process-child.ts"),
      mode,
      ...args,
    ],
    cwd: ".",
    timeoutMs,
    platforms: ["darwin", "linux", "win32"],
    env: {},
  };
}

test("failed check blocks readiness and still attempts cleanup", async () => {
  const project = await createTestProject();
  try {
    const cleaned = join(project.directory, "cleaned");
    const { router } = await workflow(project, [
      fixtureCommand("check", "check", "fail"),
      fixtureCommand("cleanup", "cleanup", "cleanup", [cleaned]),
    ]);
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result).toMatchObject({ status: "not-ready" });
    expect(result.reason).toContain("check:");
    expect(result.results?.[0]?.exitCode).toBe(7);
    expect(await Bun.file(cleaned).text()).toBe("cleaned");
    expect(await router.projectStatus(project.directory)).toMatchObject({
      status: "not-ready",
    });
  } finally {
    await project.cleanup();
  }
});

for (const phase of ["setup", "check"] as const) {
  test(`hung ${phase} is timed out, never skipped during initial verification`, async () => {
    const project = await createTestProject();
    try {
      const commands = [fixtureCommand("hung", phase, "hang", [], 100)];
      if (phase === "setup")
        commands.push(fixtureCommand("check", "check", "fail"));
      const { router } = await workflow(project, commands);
      const result = await router.setupProject({
        workspace: project.directory,
        sessionId: "main",
      });
      expect(result.status).toBe("not-ready");
      expect(result.reason).toContain(`${phase}:`);
      expect(result.results?.[0]?.status).toBe("timed_out");
    } finally {
      await project.cleanup();
    }
  });
}

test("denied execution is never bypassed, even after configuration approval", async () => {
  const project = await createTestProject();
  try {
    const record = join(project.directory, "must-not-exist");
    const { router, adapter } = await workflow(project, [
      fixtureCommand("check", "check", "record", [record]),
    ]);
    adapter.authorizeCommand = async () => ({
      ok: false,
      error: { code: "permission-denied", message: "Host denied" },
    });
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.results?.[0]?.status).toBe("permission_denied");
    expect(
      await access(record).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await project.cleanup();
  }
});

test("modified, stale and rejected replacement approvals preserve the verified configuration", async () => {
  const project = await createTestProject();
  try {
    const check = fixtureCommand("check", "check", "cleanup", [
      join(project.directory, "check"),
    ]);
    const first = await workflow(project, [check]);
    expect(
      (
        await first.router.setupProject({
          workspace: project.directory,
          sessionId: "main",
        })
      ).status,
    ).toBe("verified");
    const saved = await Bun.file(
      join(project.directory, ".ralph/commands.json"),
    ).text();
    for (const change of ["reject", "modified", "stale"]) {
      const next = await workflow(project, [check], 2);
      const approve = next.adapter.requestUserInput;
      next.adapter.requestUserInput = async (request) => {
        const result = await approve(request);
        if (!result.ok) return result;
        return {
          ...result,
          ...(change === "stale"
            ? { revision: 1 }
            : {
                text:
                  change === "reject" ? "reject" : `${result.text} modified`,
              }),
        };
      };
      expect(
        (
          await next.router.setupProject({
            workspace: project.directory,
            sessionId: "main",
          })
        ).status,
      ).toBe("rejected");
      expect(
        await Bun.file(join(project.directory, ".ralph/commands.json")).text(),
      ).toBe(saved);
      expect((await next.router.projectStatus(project.directory)).status).toBe(
        "verified",
      );
    }
  } finally {
    await project.cleanup();
  }
}, 10000);

test("overlapping setup cannot replace a pending approval", async () => {
  const project = await createTestProject();
  try {
    const first = await workflow(project, [
      fixtureCommand("check", "check", "cleanup", [
        join(project.directory, "check"),
      ]),
    ]);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    first.adapter.requestUserInput = async () => {
      entered();
      await gate;
      return {
        ok: false,
        error: { code: "cancelled", message: "Fixture rejected" },
      };
    };
    const pending = first.router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    await ready;
    try {
      const second = await workflow(project, [
        fixtureCommand("check", "check", "fail"),
      ]);
      const result = await second.router.setupProject({
        workspace: project.directory,
        sessionId: "other",
      });
      expect(result.status).toBe("not-ready");
      expect(result.reason).toContain("already active");
    } finally {
      release();
      await pending;
    }
  } finally {
    await project.cleanup();
  }
});

test("missing executable reports its cause and cleanup still runs", async () => {
  const project = await createTestProject();
  try {
    const check = {
      ...fixtureCommand("check", "check", "fail"),
      executable: "ralph-no-such-executable-928374",
    };
    const { router } = await workflow(project, [
      check,
      fixtureCommand("cleanup", "cleanup", "cleanup", [
        join(project.directory, "cleaned"),
      ]),
    ]);
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("not-ready");
    expect(result.results?.[0]?.cause?.code).toBe("ENOENT");
    expect(await Bun.file(join(project.directory, "cleaned")).text()).toBe(
      "cleaned",
    );
  } finally {
    await project.cleanup();
  }
});

test("readiness deadline blocks setup and disposes the partially started service", async () => {
  const project = await createTestProject();
  try {
    const service = join(project.directory, "service.json");
    const { router } = await workflow(project, [
      fixtureCommand("check", "check", "cleanup", [
        join(project.directory, "checked"),
      ]),
      fixtureCommand("app", "start", "service", [service]),
      fixtureCommand("ready", "readiness", "fail", [], 100),
    ]);
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("not-ready");
    expect(result.reason).toContain("readiness:");
    expect(result.results?.at(-1)?.status).toBe("timed_out");
    const info = await Bun.file(service).json();
    expect(() => process.kill(info.pid, 0)).toThrow();
    expect(() => process.kill(info.descendant, 0)).toThrow();
  } finally {
    await project.cleanup();
  }
}, 10000);

test("public runner requires host execution permission and reports cancellation", async () => {
  const { runCommand } = await import("../../src/process/runner.js");
  const { parseCommandConfig } = await import("../../src/config/commands.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const project = await createTestProject();
  try {
    const config = parseCommandConfig({
      schemaVersion: 1,
      revision: 1,
      rationale: "Hang fixture",
      commands: [fixtureCommand("check", "check", "hang", [], 2000)],
    });
    const { store, adapter } = await workflow(project, config.commands);
    await mkdir(join(project.directory, ".ralph"));
    await writeFile(
      join(project.directory, ".ralph/commands.json"),
      JSON.stringify(config),
    );
    const job = {
      runId: "runner",
      jobId: "check",
      role: "verification",
      attempt: 1,
      workspace: project.directory,
      baseCommit: project.commit,
      inputRevisions: { commands: 1 },
      prompt: "Check fixture",
    };
    await store.createRun(job.runId);
    await store.recordIntent(job);
    const command = config.commands[0];
    if (!command) throw new Error("Fixture command missing");
    adapter.authorizeCommand = async () => ({ ok: false });
    expect(
      (await runCommand(command, { store, adapter, job, config })).status,
    ).toBe("permission_denied");
    adapter.authorizeCommand = async () => ({ ok: true });
    const result = await runCommand(command, {
      store,
      adapter,
      job,
      config,
      signal: AbortSignal.timeout(100),
    });
    expect(result.status).toBe("cancelled");
    expect(result.ownedProcess).toBeDefined();
    const owned = result.ownedProcess;
    if (!owned) throw new Error("Owned process missing");
    expect(() => process.kill(owned.pid, 0)).toThrow();
  } finally {
    await project.cleanup();
  }
});

test("invalid platform coverage, paths and ordering fail before approval", async () => {
  const project = await createTestProject();
  try {
    const check = fixtureCommand("check", "check", "fail");
    const variants = [
      [{ ...check, platforms: ["linux"] }],
      [{ ...check, cwd: "../outside" }],
      [check, fixtureCommand("late-setup", "setup", "fail")],
    ];
    for (const commands of variants) {
      const { router, adapter } = await workflow(project, commands);
      let approvals = 0;
      adapter.requestUserInput = async () => {
        approvals++;
        return {
          ok: false,
          error: { code: "unsupported", message: "Unexpected approval" },
        };
      };
      expect(
        (
          await router.setupProject({
            workspace: project.directory,
            sessionId: "main",
          })
        ).status,
      ).toBe("not-ready");
      expect(approvals).toBe(0);
    }
  } finally {
    await project.cleanup();
  }
});

test("cleanup errors remain visible and invalidate readiness", async () => {
  const project = await createTestProject();
  try {
    const { router } = await workflow(project, [
      fixtureCommand("check", "check", "cleanup", [
        join(project.directory, "checked"),
      ]),
      fixtureCommand("cleanup", "cleanup", "fail"),
    ]);
    const result = JSON.parse(
      await router.dispatch("ralph-commands", "", {
        workspace: project.directory,
        sessionId: "main",
      }),
    );
    expect(result.status).toBe("not-ready");
    expect(result.cleanupError).toContain("cleanup:");
    const { assertProjectReady } = await import(
      "../../src/commands/project-setup.js"
    );
    await expect(assertProjectReady(project.directory)).rejects.toThrow(
      "cleanup:",
    );
  } finally {
    await project.cleanup();
  }
});

test("command configuration allows an empty or partial unsupported-platform map", async () => {
  const { parseCommandConfig } = await import("../../src/config/commands.js");
  const config = {
    schemaVersion: 1,
    revision: 1,
    rationale: "Portable checks",
    commands: [
      {
        id: "check",
        phase: "check",
        executable: "bun",
        args: ["test"],
        cwd: ".",
        timeoutMs: 1000,
        platforms: ["darwin", "linux", "win32"],
        env: {},
      },
    ],
    unsupportedPlatforms: {},
  };
  expect(parseCommandConfig(config).unsupportedPlatforms).toEqual({});
  expect(
    parseCommandConfig({
      ...config,
      commands: [{ ...config.commands[0], platforms: ["darwin", "linux"] }],
      unsupportedPlatforms: { win32: "Not supported by this project" },
    }).unsupportedPlatforms,
  ).toEqual({ win32: "Not supported by this project" });
});

test("approved commands use Bun wrappers when the host executable is OpenCode", async () => {
  const project = await createTestProject();
  const original = process.execPath;
  try {
    const { router } = await workflow(project, [
      fixtureCommand("check", "check", "cleanup", [
        join(project.directory, "checked"),
      ]),
    ]);
    Object.defineProperty(process, "execPath", {
      value: "/not-a-bun-runtime/opencode",
      configurable: true,
      writable: true,
    });
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("verified");
    expect(
      await access(join(project.directory, "checked")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  } finally {
    Object.defineProperty(process, "execPath", {
      value: original,
      configurable: true,
      writable: true,
    });
    await project.cleanup();
  }
});

test("a non-secret boolean environment reference does not make the proposal contain a secret", async () => {
  const project = await createTestProject();
  const previous = process.env.RALPH_FIXTURE_OPTIN;
  process.env.RALPH_FIXTURE_OPTIN = "1";
  try {
    const command = {
      ...fixtureCommand("check", "check", "cleanup", [
        join(project.directory, "checked"),
      ]),
      env: { ENABLED: "RALPH_FIXTURE_OPTIN" },
    };
    const { router } = await workflow(project, [command]);
    const result = await router.setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("verified");
  } finally {
    if (previous === undefined) delete process.env.RALPH_FIXTURE_OPTIN;
    else process.env.RALPH_FIXTURE_OPTIN = previous;
    await project.cleanup();
  }
});

test("setup status identifies verification as running while an approved command waits for permission", async () => {
  const project = await createTestProject();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const f = await workflow(project, [
    fixtureCommand("check", "check", "cleanup", [
      join(project.directory, "checked"),
    ]),
  ]);
  f.adapter.authorizeCommand = async () => {
    entered();
    await gate;
    return { ok: true };
  };
  const pending = f.router.setupProject({
    workspace: project.directory,
    sessionId: "main",
  });
  try {
    await ready;
    const run = (await f.store.listRuns()).at(-1);
    expect(run?.jobs["command-verification"]).toMatchObject({
      status: "running",
      envelope: { role: "command-verification", sessionId: "main" },
    });
  } finally {
    release();
    await pending;
    await project.cleanup();
  }
});

test("invalid discovery JSON is repaired within three read-only attempts before exact native approval", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    const store = await openRunStore(project.directory);
    const adapter = createOpenCodeAdapter(fake.client, store);
    const config = {
      schemaVersion: 1,
      revision: 1,
      rationale: "Valid narrative",
      commands: [fixtureCommand("check", "check", "cleanup", [])],
    };
    const prompts: string[] = [];
    const dispatch = adapter.dispatchJob.bind(adapter);
    adapter.dispatchJob = async (job) => {
      prompts.push(job.prompt);
      fake.respond(
        JSON.stringify({
          ...config,
          rationale:
            prompts.length === 1 ? ["Invalid array"] : config.rationale,
        }),
      );
      return dispatch(job);
    };
    let approvals = 0;
    adapter.requestUserInput = async (request) => {
      approvals++;
      expect(request.revision).toBe(1);
      expect(request.question).toContain('"rationale": "Valid narrative"');
      return {
        ...request,
        ok: true,
        source: "user",
        messageId: "native-user",
        text: "reject",
      };
    };
    const result = await createCommandRouter(store, adapter).setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("rejected");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("rationale");
    expect(prompts[1]).toContain("previous");
    expect(approvals).toBe(1);
    expect(
      (await store.listRuns())[0]?.jobs["command-discovery"]?.envelope.attempt,
    ).toBe(2);
    await expect(
      access(join(project.directory, ".ralph/commands.json")),
    ).rejects.toThrow();
    expect(
      fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(2);
  } finally {
    await project.cleanup();
  }
});

test("invalid discovery proposals stop after three attempts without approval or command execution", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    fake.respond('{"rationale":[]}');
    const store = await openRunStore(project.directory);
    const adapter = createOpenCodeAdapter(fake.client, store);
    let approvals = 0;
    adapter.requestUserInput = async () => {
      approvals++;
      throw new Error("Unexpected approval");
    };
    const result = await createCommandRouter(store, adapter).setupProject({
      workspace: project.directory,
      sessionId: "main",
    });
    expect(result.status).toBe("not-ready");
    expect(approvals).toBe(0);
    expect(
      fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(3);
    const run = (await store.listRuns())[0];
    expect(run?.jobs["command-discovery"]?.envelope.attempt).toBe(3);
    expect(Object.values(run?.operations ?? {})).toHaveLength(0);
    await expect(
      access(join(project.directory, ".ralph/commands.json")),
    ).rejects.toThrow();
  } finally {
    await project.cleanup();
  }
});

test("interrupting approved setup terminates its running check and still performs cleanup", async () => {
  const project = await createTestProject();
  const controller = new AbortController();
  try {
    const cleaned = join(project.directory, "cleanup.txt");
    const { router, store } = await workflow(project, [
      fixtureCommand("check", "check", "hang", [], 10000),
      fixtureCommand("cleanup", "cleanup", "cleanup", [cleaned]),
    ]);
    const execution = router.setupProject({
      workspace: project.directory,
      sessionId: "main",
      signal: controller.signal,
    });
    let pid: number | undefined;
    for (let i = 0; i < 200 && !pid; i++) {
      for (const run of await store.listRuns())
        for (const operation of Object.values(run.operations))
          if (operation.ownedProcess) pid = operation.ownedProcess.pid;
      if (!pid) await Bun.sleep(10);
    }
    expect(pid).toBeDefined();
    controller.abort();
    const result = await execution;
    expect(result.status).toBe("not-ready");
    expect(result.results?.[0]?.status).toBe("cancelled");
    expect(await Bun.file(cleaned).text()).toBe("cleaned");
    if (pid) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await project.cleanup();
  }
});
