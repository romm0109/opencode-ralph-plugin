import { expect, test } from "bun:test";
import { access, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAdapterClient,
  createOpenCodeAdapter,
} from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createModelFixture } from "../helpers/model-fixture.js";
import { createTestProject, git } from "../helpers/project.js";

const smoke = process.env.OPENCODE_SMOKE === "1" ? test : test.skip;
smoke(
  "a fresh checkout installs from its lockfile without a prebuilt plugin archive",
  async () => {
    const project = await createTestProject();
    try {
      for (const file of ["package.json", "bun.lock"])
        await copyFile(
          new URL(`../../${file}`, import.meta.url),
          join(project.directory, file),
        );
      const install = Bun.spawn(
        [
          process.execPath,
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--cache-dir",
          join(project.directory, "cache"),
        ],
        {
          cwd: project.directory,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, output, error] = await Promise.all([
        install.exited,
        new Response(install.stdout).text(),
        new Response(install.stderr).text(),
      ]);
      expect({ code, error: code ? `${output}\n${error}` : "" }).toEqual({
        code: 0,
        error: "",
      });
    } finally {
      await project.cleanup();
    }
  },
  120_000,
);

smoke(
  "installed package: real OpenCode session, command, denied tool, events, restart",
  async () => {
    const project = await createTestProject();
    const model = createModelFixture();
    let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    const eventAbort = new AbortController();
    async function stopServer() {
      if (!server) return;
      server.kill();
      const deadline = setTimeout(() => server?.kill("SIGKILL"), 2_000);
      try {
        await server.exited;
      } finally {
        clearTimeout(deadline);
      }
      server = undefined;
    }
    const root = resolve(import.meta.dir, "../..");
    const binary = join(
      root,
      "node_modules",
      "@opencode/cli",
      "bin",
      "opencode.exe",
    );
    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
      const [code, output, error] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (code)
        throw new Error(
          `Fixture command failed (${code}): ${output}\n${error}`,
        );
      return output;
    };
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(project.directory, "config"),
      XDG_DATA_HOME: join(project.directory, "data"),
      XDG_CACHE_HOME: join(project.directory, "cache"),
      OPENCODE_CONFIG: join(project.directory, "opencode.json"),
      OPENCODE_CONFIG_DIR: join(project.directory, "config"),
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_SERVER_PASSWORD: "ralph-test-only",
    };
    let installedAdapter: typeof import("../../src/opencode/adapter.js");
    async function start() {
      const proc = Bun.spawn(
        [binary, "serve", "--hostname=127.0.0.1", "--port=0"],
        {
          cwd: project.directory,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      server = proc;
      const reader = proc.stdout.getReader();
      let output = "";
      const timeout = setTimeout(() => proc.kill(), 30_000);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(
            `OpenCode startup failed: ${output}\n${await new Response(proc.stderr).text()}`,
          );
        output += new TextDecoder().decode(chunk.value);
        const match = output.match(/server listening on (https?:\/\/\S+)/);
        if (match?.[1]) {
          clearTimeout(timeout);
          reader.releaseLock();
          return installedAdapter.createAdapterClient(
            match[1],
            (request) =>
              fetch(request, {
                signal: AbortSignal.any([
                  request.signal,
                  AbortSignal.timeout(20_000),
                ]),
              }),
            { Authorization: `Basic ${btoa("opencode:ralph-test-only")}` },
          );
        }
      }
    }
    try {
      await run([process.execPath, "run", "build"], root);
      await run(
        [
          process.execPath,
          "pm",
          "pack",
          "--destination",
          project.directory,
          "--quiet",
        ],
        root,
      );
      await writeFile(
        join(project.directory, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: {
            "opencode-ralph-plugin": `file:${join(project.directory, "opencode-ralph-plugin-0.2.0.tgz")}`,
          },
        }),
      );
      await run([process.execPath, "install"], project.directory);
      await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
      await writeFile(
        join(project.directory, "opencode.json"),
        JSON.stringify({
          plugins: [
            await realpath(
              join(project.directory, "node_modules/opencode-ralph-plugin"),
            ),
          ],
          snapshots: false,
          compaction: { auto: false },
          model: "fixture/fixture",

          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "echo bypass*", effect: "deny" },
            { action: "edit", resource: "*", effect: "deny" },
          ],
          providers: {
            fixture: {
              package: "@ai-sdk/openai-compatible",
              name: "Fixture",
              settings: { baseURL: model.url, apiKey: "fixture" },
              models: {
                fixture: {
                  name: "Fixture",
                  limit: { context: 200000, output: 4096 },
                },
              },
            },
          },
        }),
      );
      const installedRoot = join(
        project.directory,
        "node_modules/opencode-ralph-plugin/dist",
      );
      installedAdapter = await import(
        pathToFileURL(join(installedRoot, "opencode/adapter.js")).href
      );
      const { createOpenCodeAdapter } = installedAdapter;
      const { createCommandRouter } = (await import(
        pathToFileURL(join(installedRoot, "commands/router.js")).href
      )) as typeof import("../../src/commands/router.js");
      const { openRunStore } = (await import(
        pathToFileURL(join(installedRoot, "state/run-store.js")).href
      )) as typeof import("../../src/state/run-store.js");
      const client = await start();
      // Finish lazy plugin initialization before recording any external job intent.
      // Recovery must not encounter a fixture job while the server itself is booting.
      let loaded = await client.command.list({
        location: { directory: project.directory },
      });
      const activationDeadline = Date.now() + 20_000;
      while (
        !loaded.data.some((command) => command.name === "ralph-status") &&
        Date.now() < activationDeadline
      ) {
        await Bun.sleep(100);
        loaded = await client.command.list({
          location: { directory: project.directory },
        });
      }
      if (!loaded.data.some((command) => command.name === "ralph-status")) {
        console.error(
          "V2 plugin diagnostics",
          await client.plugin.list({
            location: { directory: project.directory },
          }),
          await client.plugin.check({
            location: { directory: project.directory },
          }),
          JSON.stringify(
            await client.config.get({
              location: { directory: project.directory },
            }),
          ),
        );
      }
      expect(
        loaded.data.some((command) => command.name === "ralph-status"),
      ).toBe(true);
      let pluginInfo = await client.plugin.list({
        location: { directory: project.directory },
      });
      // Command transforms can be visible before plugin activation is published.
      const inventoryDeadline = Date.now() + 20_000;
      while (
        !pluginInfo.data.some(
          (plugin) => plugin.id === "ralph" && plugin.state.status === "active",
        ) &&
        Date.now() < inventoryDeadline
      ) {
        await Bun.sleep(100);
        pluginInfo = await client.plugin.list({
          location: { directory: project.directory },
        });
      }
      expect(
        pluginInfo.data.find((plugin) => plugin.id === "ralph")?.features.tui,
      ).toBe(true);
      const events = await client.event.subscribe({
        signal: eventAbort.signal,
      });
      const observed: string[] = [];
      const reading = (async () => {
        for await (const event of events) {
          observed.push(event.type);
          if (event.type === "session.step.ended") break;
        }
      })();
      const store = await openRunStore(project.directory);
      await store.createRun("smoke-run");
      const adapter = createOpenCodeAdapter(client, store);
      const job = {
        runId: "smoke-run",
        jobId: "smoke-job",
        attempt: 1,
        role: "executor",
        workspace: project.directory,
        inputRevisions: {},
        baseCommit: project.commit,
        prompt: "Say hello",
        model: { providerID: "fixture", modelID: "fixture" },
      };
      const result = await createCommandRouter(store, adapter).runJob(job);
      expect(result).toMatchObject({
        outcome: "completed",
        text: "actual response",
      });
      expect(result.sessionId).toBeString();
      const linked = join(project.directory, "linked-review");
      await git("git", [
        "-C",
        project.directory,
        "worktree",
        "add",
        "-b",
        "v2-review",
        linked,
      ]);
      // Native Plugin.Context cannot prepare tools in another location through
      // location-scoped RPC. Each linked location must bootstrap its own aliases.
      const nativeStyleAdapter = createOpenCodeAdapter(
        { ...client, prepareReview: async () => {} },
        store,
      );
      const reviewed = await nativeStyleAdapter.dispatchJob({
        ...job,
        jobId: "review-job",
        role: "probe",
        workspace: linked,
        readOnly: true,
        prompt: "RALPH_REVIEW",
      });
      expect(reviewed).toMatchObject({ outcome: "completed" });
      const offered = model.reviewTools().at(-1) ?? [];
      expect(offered).toContain("ralph_review_read");
      expect(offered.every((name) => name.startsWith("ralph_review_"))).toBe(
        true,
      );
      const rejectedReview = await adapter.dispatchJob({
        ...job,
        jobId: "review-mutation",
        role: "probe",
        workspace: linked,
        readOnly: true,
        prompt: "RALPH_REVIEW_MUTATION",
      });
      expect(rejectedReview.outcome).not.toBe("completed");
      await expect(access(join(linked, "denied-sentinel"))).rejects.toThrow();
      let eventDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reading,
          new Promise<never>((_, reject) => {
            eventDeadline = setTimeout(
              () => reject(new Error("No message event from installed server")),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(eventDeadline);
        eventAbort.abort();
      }
      expect(observed).toContain("session.step.ended");
      const commands = await client.command.list({
        location: { directory: project.directory },
      });
      expect(commands.data?.some((c) => c.name === "ralph-status")).toBe(true);
      const before = await createCommandRouter(store).status("smoke-run");
      const callsBeforeStatus = model.calls();
      await client.session.command({
        sessionID: result.sessionId as string,
        name: "ralph-status",
        text: "smoke-run",
      });
      const status = await client.session.inbox.list({
        sessionID: result.sessionId as string,
      });
      expect(
        status.some(
          (message) =>
            message.type === "synthetic" &&
            message.payload.text.includes("review-mutation"),
        ),
      ).toBe(true);
      expect(model.calls()).toBe(callsBeforeStatus);
      // The normal assistant searches, asks in chat, then saves after a user reply.
      const runsBeforeSetup = (await store.listRuns()).map((run) => run.runId);
      const setupSession = await client.session.create({
        location: { directory: project.directory },
        title: "Native Ralph setup",
        model: { providerID: "fixture", id: "fixture" },
      });
      await client.session.command({
        sessionID: setupSession.id,
        name: "ralph-commands",
        text: "",
      });
      await client.session.wait({ sessionID: setupSession.id });
      const proposalHistory = await client.session.context({
        sessionID: setupSession.id,
      });
      expect(JSON.stringify(proposalHistory)).toContain("Do you approve?");
      expect(
        proposalHistory.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some(
              (part) =>
                part.type === "tool" &&
                part.name === "glob" &&
                part.state.status === "completed",
            ),
        ),
      ).toBe(true);
      expect(
        await Bun.file(
          join(project.directory, ".ralph/commands.json"),
        ).exists(),
      ).toBe(false);
      expect((await store.listRuns()).map((run) => run.runId)).toEqual(
        runsBeforeSetup,
      );
      await client.session.prompt({
        sessionID: setupSession.id,
        text: "Approve the proposed commands",
      });
      await client.session.wait({ sessionID: setupSession.id });
      const saved = await Bun.file(
        join(project.directory, ".ralph/commands.json"),
      ).json();
      expect(saved.commands[0].args).toEqual(["test"]);
      expect(
        await Bun.file(
          join(project.directory, ".ralph/verification.json"),
        ).exists(),
      ).toBe(false);
      expect((await store.listRuns()).map((run) => run.runId)).toEqual(
        runsBeforeSetup,
      );
      expect(
        await client.permission.list({ sessionID: setupSession.id }),
      ).toHaveLength(0);
      const savedHistory = await client.session.context({
        sessionID: setupSession.id,
      });
      expect(
        savedHistory.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some(
              (part) =>
                part.type === "tool" &&
                part.name === "ralph_save_commands" &&
                part.state.status === "completed",
            ),
        ),
      ).toBe(true);
      let foregroundDone = false;
      const foreground = adapter
        .dispatchJob({
          ...job,
          jobId: "foreground",
          prompt: "RALPH_FOREGROUND",
        })
        .finally(() => {
          foregroundDone = true;
        });
      const foregroundDeadline = Date.now() + 15000;
      while (!foregroundDone && Date.now() < foregroundDeadline) {
        const sessionID = (await store.getRun("smoke-run"))?.jobs.foreground
          ?.envelope.sessionId;
        if (sessionID)
          for (const permission of await client.permission.list({ sessionID }))
            await client.permission.reply({
              sessionID,
              requestID: permission.id,
              decision: "once",
            });
        await Bun.sleep(25);
      }
      expect(foregroundDone).toBe(true);
      const foregroundResult = await foreground;
      expect(foregroundResult.outcome).toBe("completed");
      const foregroundHistory = await client.session.context({
        sessionID: foregroundResult.sessionId as string,
      });
      const shellCall = foregroundHistory
        .flatMap((message) =>
          message.type === "assistant" ? message.content : [],
        )
        .find((part) => part.type === "tool" && part.name === "shell");
      expect(
        shellCall?.type === "tool" &&
          shellCall.state.status === "completed" &&
          shellCall.state.metadata?.status,
      ).toBe("completed");
      const denied = await adapter.dispatchJob({
        ...job,
        jobId: "denied-job",
        prompt: "RALPH_DENIAL",
      });
      expect(denied.outcome).toBe("denied");
      await expect(
        access(join(project.directory, "denied-sentinel")),
      ).rejects.toThrow();
      expect(
        await adapter.cancelJob({ ...job, jobId: "denied-job" }),
      ).toMatchObject({ ok: true });
      await stopServer();
      const reopened = await openRunStore(project.directory);
      expect(
        (await reopened.getRun("smoke-run"))?.jobs["smoke-job"]?.result,
      ).toEqual(result);
      expect(before).toContain("review-mutation");
      const restarted = await start();
      await restarted.session.command({
        sessionID: result.sessionId as string,
        name: "ralph-status",
        text: "smoke-run",
      });
      const again = await restarted.session.inbox.list({
        sessionID: result.sessionId as string,
      });
      expect(
        again.some(
          (message) =>
            message.type === "synthetic" &&
            message.payload.text.includes("denied-job"),
        ),
      ).toBe(true);
      expect(model.calls()).toBeGreaterThan(0);
      const restartAdapter = createOpenCodeAdapter(restarted, reopened);
      await createCommandRouter(reopened, restartAdapter).dispatch(
        "ralph-resume",
        "smoke-run",
      );
      const heldJob = { ...job, jobId: "abort-job", prompt: "RALPH_HOLD" };
      const held = restartAdapter.dispatchJob(heldJob);
      const deadline = Date.now() + 15_000;
      while (!model.holding() && Date.now() < deadline) await Bun.sleep(20);
      expect(model.holding()).toBe(true);
      expect(await restartAdapter.cancelJob(heldJob)).toEqual({ ok: true });
      model.release();
      expect((await held).outcome).toBe("cancelled");
      expect(
        Object.values(
          (await reopened.getRun("smoke-run"))?.operations ?? {},
        ).some(
          (op) => op.kind === "session.abort" && op.status === "completed",
        ),
      ).toBe(true);
      expect(
        await restartAdapter.publishStatus(
          result.sessionId as string,
          project.directory,
          "Probe complete",
        ),
      ).toEqual({ ok: true });
      const history = await restarted.session.context({
        sessionID: result.sessionId as string,
      });
      expect(
        history.some(
          (message) => message.type === "user" && message.text === "Say hello",
        ),
      ).toBe(true);
      expect(
        await restartAdapter.requestUserInput({
          runId: "smoke-run",
          requestId: "q",
          revision: 1,
          sessionId: result.sessionId as string,
          workspace: project.directory,
          question: "approve?",
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      // Direct startup creates a fresh owner and a native opening form.
      expect(
        await restartAdapter.discoverTools?.(project.directory),
      ).not.toContain("ralph_workflow");
      const workflowSession = await restarted.session.create({
        location: { directory: project.directory },
        title: "Ralph native startup",
        model: { providerID: "fixture", id: "fixture" },
      });
      const startup = restarted.session
        .command({
          sessionID: workflowSession.id,
          name: "ralph-orchestrator",
          text: "Add reset",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const startupDeadline = Date.now() + 15000;
      let feature: Awaited<ReturnType<typeof store.getRun>>;
      while (Date.now() < startupDeadline) {
        feature = (await store.listRuns()).find(
          (run) => run.planning?.protocol === "native-interview-v1",
        );
        if (feature?.planning?.pending) break;
        await Bun.sleep(25);
      }
      if (!feature?.planning) throw new Error("No native workflow owner");
      expect(feature.planning.sessionId).not.toBe(workflowSession.id);
      expect(feature.planning.pending?.kind).toBe("feature");
      expect(feature.planning.pending?.question).toContain("Add reset");
      let forms = await restarted.session.form.list({
        sessionID: feature.planning.sessionId,
      });
      while (!forms.length && Date.now() < startupDeadline) {
        await Bun.sleep(25);
        forms = await restarted.session.form.list({
          sessionID: feature.planning.sessionId,
        });
      }
      const form = forms[0];
      if (!form) {
        const permissions = await restarted.permission.list({
          sessionID: feature.planning.sessionId,
        });
        throw new Error(
          `No native opening form for ${feature.planning.sessionId}; pending permissions: ${permissions.length}`,
        );
      }
      const openingField = form.fields[0];
      if (!openingField) throw new Error("Opening form has no field");
      await restarted.session.form.reply({
        sessionID: feature.planning.sessionId,
        formID: form.id,
        answer: { [openingField.key]: "Add reset" },
      });
      const interviewId = feature.planning.sessionId;
      const approvalDeadline = Date.now() + 15000;
      let approvalForms = await restarted.session.form.list({
        sessionID: interviewId,
      });
      while (!approvalForms.length && Date.now() < approvalDeadline) {
        await Bun.sleep(25);
        approvalForms = await restarted.session.form.list({
          sessionID: interviewId,
        });
      }
      const approvalForm = approvalForms[0];
      if (!approvalForm)
        throw new Error("Completion tool did not open a native scope approval");
      const approvalField = approvalForm.fields[0];
      if (
        !approvalField ||
        approvalField.type !== "string" ||
        !approvalField.options?.[0]
      )
        throw new Error("Scope approval has no affirmative option");
      expect(JSON.stringify(approvalForm)).toContain("implementation");
      expect(JSON.stringify(approvalForm)).toContain(
        (await store.getRun(feature.runId))?.planning?.proposalContext?.sha ??
          "missing pinned commit",
      );
      await restarted.session.form.reply({
        sessionID: interviewId,
        formID: approvalForm.id,
        answer: { [approvalField.key]: approvalField.options[0].value },
      });
      const startupError = await startup;
      if (startupError) throw startupError;
      const prdDeadline = Date.now() + 15000;
      let approved = await store.getRun(feature.runId);
      while (
        approved?.planning?.owner?.stage !== "prd" &&
        Date.now() < prdDeadline
      ) {
        await Bun.sleep(25);
        approved = await store.getRun(feature.runId);
      }
      expect(approved?.planning?.sessionId).toBe(interviewId);
      expect(approved?.planning?.owner?.stage).toBe("prd");
      expect(approved?.planning?.approval?.messageId).toStartWith("question:");
      await restarted.session.command({
        sessionID: workflowSession.id,
        name: "ralph-stop",
        text: feature.runId,
      });
      // Preview and approve project removal in a normal OpenCode conversation.
      const removeSession = await restarted.session.create({
        location: { directory: project.directory },
        title: "Remove Ralph",
        model: { providerID: "fixture", id: "fixture" },
      });
      await restarted.session.command({
        sessionID: removeSession.id,
        name: "ralph-remove",
        text: "",
      });
      await restarted.session.wait({ sessionID: removeSession.id });
      expect(
        await Bun.file(
          join(project.directory, ".ralph/commands.json"),
        ).exists(),
      ).toBe(true);
      expect(
        JSON.stringify(
          await restarted.session.context({ sessionID: removeSession.id }),
        ),
      ).toContain("planId");
      await restarted.session.prompt({
        sessionID: removeSession.id,
        text: "yes",
      });
      await restarted.session.wait({ sessionID: removeSession.id });
      expect(
        await Bun.file(
          join(project.directory, ".ralph/commands.json"),
        ).exists(),
      ).toBe(false);
      expect(await reopened.listRuns()).toHaveLength(0);
      expect(
        await Bun.file(join(project.directory, "README.md")).exists(),
      ).toBe(true);
    } catch (cause) {
      const diagnosticStore = await openRunStore(project.directory);
      console.error(
        "Native smoke state",
        (await diagnosticStore.listRuns())
          .filter((run) => run.planning)
          .map((run) => ({
            runId: run.runId,
            phase: run.planning?.phase,
            error: run.planning?.error,
            pending: run.planning?.pending?.kind,
            owner: run.planning?.owner,
          })),
        "model calls",
        model.calls(),
      );
      throw cause;
    } finally {
      eventAbort.abort();
      await stopServer();
      model.release();
      model.close();
      await project.cleanup();
    }
  },
  120_000,
);

const live =
  process.env.OPENCODE_LIVE_SMOKE === "1" &&
  process.env.OPENCODE_SMOKE_URL &&
  process.env.OPENCODE_SMOKE_MODEL
    ? test
    : test.skip;
live(
  "credentialed live model response through an existing OpenCode instance",
  async () => {
    const project = await createTestProject();
    try {
      const store = await openRunStore(project.directory);
      await store.createRun("live");
      const [providerID, modelID] = (
        process.env.OPENCODE_SMOKE_MODEL as string
      ).split("/");
      if (!providerID || !modelID)
        throw new Error("Set OPENCODE_SMOKE_MODEL=provider/model");
      const result = await createOpenCodeAdapter(
        createAdapterClient(
          process.env.OPENCODE_SMOKE_URL as string,
          undefined,
          process.env.OPENCODE_SMOKE_PASSWORD
            ? {
                Authorization: `Basic ${btoa(`opencode:${process.env.OPENCODE_SMOKE_PASSWORD}`)}`,
              }
            : undefined,
        ),
        store,
      ).dispatchJob({
        runId: "live",
        jobId: "live",
        attempt: 1,
        role: "probe",
        workspace: project.directory,
        inputRevisions: {},
        baseCommit: project.commit,
        prompt: "Reply with hello.",
        model: { providerID, modelID },
      });
      expect(result.outcome).toBe("completed");
      expect(result.evidence.length).toBeGreaterThan(0);
    } finally {
      await project.cleanup();
    }
  },
  60_000,
);
