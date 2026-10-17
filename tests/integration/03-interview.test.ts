import { expect, test } from "bun:test";
import { createCommandRouter } from "../../src/commands/router.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";

async function readyProject() {
  const project = await createTestProject();
  const fake = createFakeOpenCode();
  const store = await openRunStore(project.directory);
  const adapter = createOpenCodeAdapter(fake.client, store);
  adapter.getSessionModel = async () => ({
    providerID: "fixture",
    modelID: "default",
  });
  const router = createCommandRouter(
    store,
    adapter,
    undefined,
    project.directory,
  );
  fake.respond(
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      rationale: "Fixture",
      commands: [
        {
          id: "check",
          phase: "check",
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
  adapter.authorizeCommand = async () => ({ ok: true });
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
  return {
    project,
    fake,
    store,
    adapter,
    router,
    context: { workspace: project.directory, sessionId: "main" },
  };
}

test("native slash command preserves host location spelling, confirms supplied text and reuses its session", async () => {
  const { project, fake, store } = await readyProject();
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { RalphPlugin } = await import("../../src/plugin.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  await writeFile(
    join(project.directory, ".ralph/project.json"),
    JSON.stringify({
      models: { interview: { providerID: "fixture", modelID: "chosen" } },
    }),
  );
  fake.respond(
    JSON.stringify({
      kind: "question",
      question: "Token expiry?",
      recommendation: "15 minutes",
    }),
  );
  const host = createFakePluginContext(`${project.directory}/.`, fake.client);
  const questions: {
    sessionID: string;
    input: { questions: { question: string; options: { label: string }[] }[] };
  }[] = [];
  host.tools.set("question", {
    id: "question",
    name: "question",
    description: "Native input",
    input: {} as never,
    async execute(input, context) {
      questions.push({
        sessionID: context.sessionID,
        input: input as (typeof questions)[number]["input"],
      });
      const run = (await store.listRuns()).find((run) => run.planning);
      expect(run?.planning?.pending?.sessionId).toBe(context.sessionID);
      return {
        content: "",
        metadata:
          questions.length <= 2
            ? {
                answers: [
                  [questions.length === 1 ? "Build reset" : "15 minutes"],
                ],
              }
            : {},
      };
    },
  });
  const dispose = await RalphPlugin.setup(host.context);
  try {
    const before = fake.requests.length;
    await host.commands.get("ralph-orchestrator")?.execute({
      sessionID: "main",
      prompt: { text: "Suggested reset" },
      delivery: "steer",
    } as never);
    const run = (await store.listRuns()).find((run) => run.planning);
    expect(questions).toHaveLength(3);
    expect(
      fake.requests.slice(before).find((r) => r.path === "/api/session")?.body
        .location,
    ).toEqual({ directory: host.context.location.directory });
    expect(host.stageSessions).toEqual([
      {
        revision: expect.any(Number),
        runId: run?.runId,
        stage: "interview",
        sessionId: run?.planning?.sessionId,
        attempt: 1,
      },
    ]);
    expect(questions[0]?.input.questions[0]?.question).toContain(
      "What feature",
    );
    expect(questions[0]?.input.questions[0]?.question).toContain(
      "Suggested reset",
    );
    expect(questions[0]?.input.questions[0]?.options[0]?.label).toBe(
      "Suggested reset",
    );
    expect(questions[0]?.sessionID).not.toBe("main");
    expect(questions[1]?.sessionID).toBe(questions[0]?.sessionID);
    expect(questions[2]?.sessionID).toBe(questions[0]?.sessionID);
    expect(questions[1]?.input.questions[0]?.options[0]?.label).toBe(
      "15 minutes",
    );
    expect(run?.planning?.feature).toBe("Build reset");
    const tools = {
      read: {},
      glob: {},
      grep: {},
      question: {},
      shell: {},
      write: {},
      ralph_workflow: {},
    };
    const context = { sessionID: run?.planning?.sessionId, tools, system: [] };
    await host.hooks.get("session.context")?.(context);
    expect(Object.keys(tools)).toEqual(["read", "glob", "grep", "question"]);
    await expect(
      host.hooks.get("tool.execute.before")?.({
        sessionID: context.sessionID,
        tool: "read",
      }),
    ).resolves.toBeUndefined();
    await expect(
      host.hooks.get("tool.execute.before")?.({
        sessionID: context.sessionID,
        tool: "shell",
      }),
    ).rejects.toThrow("interview");
    const { handleInterviewResponse } = await import(
      "../../src/planning/interview.js"
    );
    const pending = run?.planning?.pending;
    if (!pending || !run) throw new Error("No pending question");
    expect(
      await handleInterviewResponse(store, run.runId, {
        ok: true,
        ...pending,
        sessionId: "main",
        source: "user",
        messageId: "unsolicited",
        text: "15 minutes",
      }),
    ).toBe(false);
    if (!run.planning?.owner) throw new Error("Missing interview owner");
    const changed = structuredClone(run.planning);
    if (!changed.owner) throw new Error("Missing interview owner");
    changed.owner.sessionId = "wrong";
    await expect(
      store.recordPlanning(run.runId, run.revision, changed),
    ).rejects.toThrow("ownership");
    expect(run?.planning?.transcript[0]?.messageId).toStartWith("question:");
    expect(run?.planning?.phase).toBe("interview");
    const allPrompts = fake.requests
      .slice(before)
      .filter((r) => r.path.endsWith("/prompt"));
    const relayed = allPrompts.filter((r) =>
      String(r.body.text).startsWith("Ralph needs a human answer"),
    );
    // Questions after the opening form are relayed through the interviewer's
    // own question tool call in the same session.
    expect(relayed).toHaveLength(2);
    expect(
      relayed.every((r) => r.path.includes(`/${run?.planning?.sessionId}/`)),
    ).toBe(true);
    const prompts = allPrompts.filter((r) => !relayed.includes(r));
    expect(prompts).toHaveLength(2);
    expect(prompts.every((r) => !r.path.includes("/main/"))).toBe(true);
    expect(prompts[0]?.body.text).toContain("Walk down each branch");
    expect(prompts[0]?.body.text).toContain("ASD-STE100");
    expect(prompts[0]?.body.text).not.toContain("create-prd");
    expect(
      fake.requests.slice(before).filter((r) => r.path === "/api/session"),
    ).toHaveLength(1);
  } finally {
    if (typeof dispose === "function") await dispose();
    await project.cleanup();
  }
});

test("native startup without feature text persists the opening question and waits without an agent attempt", async () => {
  const { project, adapter, store, context } = await readyProject();
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  try {
    adapter.discoverTools = async () => ["question", "read"];
    adapter.requestUserInput = async (request) => {
      expect(request.kind).toBe("feature");
      expect(request.options).toEqual([]);
      expect(request.question).toContain("What feature");
      expect(request.question).not.toContain("Suggested feature");
      expect(request.sessionId).not.toBe(context.sessionId);
      expect((await store.getRun(request.runId))?.planning?.pending).toEqual(
        request,
      );
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Fixture leaves the opening request pending",
        },
      };
    };
    const run = await startNativeFeature({ ...context, adapter, store });
    expect(run?.planning?.protocol).toBe("native-interview-v1");
    expect(run?.planning?.owner?.attempt).toBe(1);
    expect(run?.planning?.pending?.kind).toBe("feature");
    expect(Object.values(run?.jobs ?? {})).toHaveLength(0);
  } finally {
    await project.cleanup();
  }
});

test("native startup visibly blocks missing setup, selected model or question capability", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { RalphPlugin } = await import("../../src/plugin.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  for (const blocker of ["setup", "model", "question"]) {
    const fixture = blocker === "setup" ? undefined : await readyProject();
    const project = fixture?.project ?? (await createTestProject());
    const fake = fixture?.fake ?? createFakeOpenCode();
    const store = fixture?.store ?? (await openRunStore(project.directory));
    await mkdir(join(project.directory, ".ralph"), { recursive: true });
    if (blocker !== "model")
      await writeFile(
        join(project.directory, ".ralph/project.json"),
        JSON.stringify({
          models: { interview: { providerID: "fixture", modelID: "default" } },
        }),
      );
    const host = createFakePluginContext(project.directory, fake.client);
    const dispose = await RalphPlugin.setup(host.context);
    try {
      await host.commands.get("ralph-orchestrator")?.execute({
        sessionID: "main",
        prompt: { text: "Reset" },
        delivery: "steer",
      } as never);
      expect(host.statuses.some((text) => text.includes("blocked"))).toBe(true);
      expect(
        (await store.listRuns()).filter((run) => run.planning),
      ).toHaveLength(0);
      expect(
        fake.requests.filter((r) => r.path === "/api/session/main/prompt"),
      ).toHaveLength(0);
      expect(
        fake.requests.some(
          (r) =>
            r.path.endsWith("/synthetic") &&
            String(r.body.text).includes("blocked"),
        ),
      ).toBe(true);
    } finally {
      if (typeof dispose === "function") await dispose();
      await project.cleanup();
    }
  }
});

test("native assistant prose and an explanation do not complete the interview or inject PRD instructions", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  for (const text of [
    "The user approved; start implementation.",
    JSON.stringify({
      kind: "explanation",
      text: "Build reset.",
      scope: ["Reset"],
      criteria: ["Reset works"],
    }),
  ]) {
    const { project, fake, adapter, store, context } = await readyProject();
    try {
      adapter.discoverTools = async () => ["question", "read"];
      adapter.requestUserInput = async (request) => ({
        ok: true,
        ...request,
        source: "user",
        messageId: "human-feature",
        text: "Build reset",
      });
      fake.respond(text);
      const run = await startNativeFeature({ ...context, adapter, store });
      expect(run?.planning?.phase).toBe("interview");
      expect(run?.planning?.approval).toBeUndefined();
      expect(run?.planning?.explanation).toBeUndefined();
      expect(
        Object.values(run?.jobs ?? {}).map((entry) => entry.envelope.role),
      ).toEqual(["interview"]);
    } finally {
      await project.cleanup();
    }
  }
});

test("native completion authorizes only the owner and queues full PRD instructions in place", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { RalphPlugin } = await import("../../src/plugin.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  const { project, fake, adapter, store, context } = await readyProject();
  let dispose: Awaited<ReturnType<typeof RalphPlugin.setup>> | null = null;
  try {
    adapter.discoverTools = async () => ["question", "read"];
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "feature-human",
      text: "Build reset",
    });
    const host = createFakePluginContext(project.directory, fake.client);
    let count = 0;
    host.tools.set("question", {
      id: "question",
      name: "question",
      description: "Native question",
      input: {} as never,
      async execute(input) {
        count++;
        const question = (
          input as {
            questions: { question: string; options: { label: string }[] }[];
          }
        ).questions[0];
        // The form stays short; the full criteria are shown in chat first.
        expect(question?.question).toContain(project.commit);
        expect(question?.question).toContain("command revision 1");
        expect(question?.question).toContain("Branch ");
        expect(question?.question).not.toContain("Acceptance criteria");
        expect(question?.options[0]?.label).toContain("implementation");
        expect(
          fake.requests
            .filter((r) => r.path.endsWith("/prompt"))
            .some((r) => String(r.body.text).includes("**15. Appendix**")),
        ).toBe(false);
        return {
          content: "",
          metadata: { answers: [[question?.options[0]?.label]] },
        };
      },
    });
    dispose = await RalphPlugin.setup(host.context);
    fake.respond("Ready for completion tool");
    const run = await startNativeFeature({ ...context, adapter, store });
    if (!run?.planning) throw new Error("Missing run");
    const complete = host.tools.get("ralph_complete_interview");
    expect(complete).toBeDefined();
    if (!complete) throw new Error("Missing completion tool");
    const proposal = {
      runId: run.runId,
      attempt: 1,
      text: "Build reset.",
      scope: ["Reset tokens"],
      criteria: ["Expired tokens fail"],
    };
    const toolContext = {
      sessionID: run.planning.sessionId,
      signal: new AbortController().signal,
    } as never;
    await expect(
      complete.execute(proposal, {
        ...(toolContext as object),
        sessionID: "foreign",
      } as never),
    ).rejects.toThrow("ownership");
    expect(count).toBe(0);
    await complete.execute(proposal, toolContext);
    const approved = (await store.getRun(run.runId))?.planning;
    expect(approved?.owner?.stage).toBe("prd");
    expect(approved?.approval?.hash).toBe(approved?.explanation?.hash);
    const prompts = fake.requests.filter(
      (r) =>
        r.path.endsWith("/prompt") &&
        String(r.body.text).includes("**15. Appendix**"),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.path).toContain(`/${run.planning.sessionId}/`);
    expect(prompts[0]?.body.delivery).toBe("queue");
    expect(prompts[0]?.body.text).toContain("ralph_complete_prd");
    await complete.execute(proposal, toolContext);
    expect(count).toBe(1);
    const writer = host.tools.get("ralph_write_planning_file");
    if (!writer) throw new Error("Missing writer");
    await expect(
      writer.execute(
        {
          runId: "feature-foreign",
          attempt: 1,
          path: "PRD.md",
          content: "bad",
        },
        toolContext,
      ),
    ).rejects.toThrow("ownership");
    await expect(
      writer.execute(
        { runId: run.runId, attempt: 2, path: "PRD.md", content: "bad" },
        toolContext,
      ),
    ).rejects.toThrow("ownership");
    for (let section = 1; section <= 15; section++)
      expect(prompts[0]?.body.text).toContain(`**${section}.`);
    await writer.execute(
      {
        runId: run.runId,
        attempt: 1,
        path: "PRD.md",
        content: "# Feature draft",
      },
      toolContext,
    );
    const { readFile, symlink, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const draft = join(
      project.directory,
      ".ralph/features",
      run.runId,
      "prd-draft-1/PRD.md",
    );
    expect(await readFile(draft, "utf8")).toBe("# Feature draft");
    for (const path of [
      "../PRD.md",
      "/tmp/PRD.md",
      "src/plugin.ts",
      `.ralph/features/feature-other/PRD.md`,
      "a/../PRD.md",
      "C:\\PRD.md",
    ]) {
      await expect(
        writer.execute(
          { runId: run.runId, attempt: 1, path, content: "bad" },
          toolContext,
        ),
      ).rejects.toThrow();
    }
    await rm(draft);
    await symlink(join(project.directory, "README.md"), draft);
    await expect(
      writer.execute(
        { runId: run.runId, attempt: 1, path: "PRD.md", content: "bad" },
        toolContext,
      ),
    ).rejects.toThrow("symlink");
    expect(await readFile(join(project.directory, "README.md"), "utf8")).toBe(
      "Fixture\n",
    );
    for (const tool of [
      "shell",
      "write",
      "edit",
      "task",
      "codemode",
      "ralph_review_read",
    ]) {
      await expect(
        host.hooks.get("tool.execute.before")?.({
          sessionID: run.planning.sessionId,
          tool,
        }),
      ).rejects.toThrow("Permission denied");
    }
    const tools = {
      read: {},
      question: {},
      ralph_complete_interview: {},
      ralph_write_planning_file: {},
      shell: {},
      write: {},
    };
    await host.hooks.get("session.context")?.({
      sessionID: run.planning.sessionId,
      tools,
    });
    expect(Object.keys(tools)).toEqual([
      "read",
      "question",
      "ralph_complete_interview",
      "ralph_write_planning_file",
    ]);
  } finally {
    if (typeof dispose === "function") await dispose();
    await project.cleanup();
  }
});

test("native explanation rejection requires a new displayed revision and scope changes revoke the writer", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { completeInterview } = await import(
    "../../src/planning/completion.js"
  );
  const { writePlanningFile } = await import(
    "../../src/planning/artifact-writer.js"
  );
  const { project, fake, adapter, store, context } = await readyProject();
  try {
    adapter.discoverTools = async () => ["question"];
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "feature",
      text: "Reset",
    });
    fake.respond("Ready");
    const run = await startNativeFeature({ ...context, adapter, store });
    if (!run?.planning) throw new Error("Missing run");
    const session = run.planning.sessionId;
    const proposal = {
      runId: run.runId,
      attempt: 1,
      text: "Build reset",
      scope: ["Reset"],
      criteria: ["Expired tokens fail"],
    };
    let approvals = 0;
    adapter.requestUserInput = async (request) => {
      approvals++;
      expect(request.revision).toBe(approvals);
      return {
        ok: true,
        ...request,
        source: "user",
        messageId: `human-${approvals}`,
        text:
          approvals === 2
            ? (request.options?.[0]?.label ?? "")
            : "Use shorter expiry",
      };
    };
    await expect(
      completeInterview(store, adapter, { ...proposal, attempt: 2 }, session),
    ).rejects.toThrow("ownership");
    await expect(
      completeInterview(
        store,
        adapter,
        { ...proposal, answer: "approve" } as never,
        session,
      ),
    ).rejects.toThrow();
    expect(
      (await completeInterview(store, adapter, proposal, session)).outcome,
    ).toBe("correctable-invalid");
    expect((await store.getRun(run.runId))?.planning?.phase).toBe("interview");
    expect(
      fake.requests.some((r) =>
        String(r.body.text).includes("**15. Appendix**"),
      ),
    ).toBe(false);
    expect(
      (
        await completeInterview(
          store,
          adapter,
          { ...proposal, criteria: ["Tokens expire after ten minutes"] },
          session,
        )
      ).outcome,
    ).toBe("accepted");
    const approved = (await store.getRun(run.runId))?.planning;
    expect(approved?.approval?.revision).toBe(2);
    expect(approved?.approval?.sha).toBe(project.commit);
    expect(approved?.approval?.commandRevision).toBe(1);
    const { mkdir, symlink, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const feature = join(project.directory, ".ralph/features", run.runId);
    await mkdir(feature, { recursive: true });
    await symlink(project.directory, join(feature, "prd-draft-1"));
    await expect(
      writePlanningFile(
        store,
        { runId: run.runId, attempt: 1, path: "PRD.md", content: "# Draft" },
        session,
      ),
    ).rejects.toThrow("symlink");
    await expect(readFile(join(project.directory, "PRD.md"))).rejects.toThrow();
    // New scope is displayed and rejected. It must revoke the old scope immediately.
    expect(
      (
        await completeInterview(
          store,
          adapter,
          { ...proposal, scope: ["Reset", "Email delivery"] },
          session,
        )
      ).outcome,
    ).toBe("correctable-invalid");
    const revised = (await store.getRun(run.runId))?.planning;
    expect(revised?.approval).toBeUndefined();
    expect(revised?.prdDelivery).toBeUndefined();
    expect(revised?.owner?.stage).toBe("interview");
    await expect(
      writePlanningFile(
        store,
        { runId: run.runId, attempt: 1, path: "PRD.md", content: "# Draft" },
        session,
      ),
    ).rejects.toThrow("authorized");
  } finally {
    await project.cleanup();
  }
});

test("native approval rejects stale results and repeated completion reports the recorded request", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { completeInterview } = await import(
    "../../src/planning/completion.js"
  );
  const { handleInterviewResponse } = await import(
    "../../src/planning/interview.js"
  );
  const { project, fake, adapter, store, context } = await readyProject();
  try {
    adapter.discoverTools = async () => ["question"];
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "feature",
      text: "Reset",
    });
    fake.respond("Ready");
    const run = await startNativeFeature({ ...context, adapter, store });
    if (!run?.planning) throw new Error("Missing run");
    const proposal = {
      runId: run.runId,
      attempt: 1,
      text: "Reset",
      scope: ["Reset"],
      criteria: ["Works"],
    };
    let count = 0;
    adapter.requestUserInput = async (request) => {
      count++;
      return {
        ok: true,
        ...request,
        sessionId: "foreign",
        source: "user",
        messageId: "wrong-session",
        text: request.options?.[0]?.label ?? "",
      };
    };
    expect(
      (
        await completeInterview(
          store,
          adapter,
          proposal,
          run.planning.sessionId,
        )
      ).outcome,
    ).toBe("stale");
    const pending = (await store.getRun(run.runId))?.planning?.pending;
    if (!pending) throw new Error("Missing request");
    for (const patch of [
      { source: "assistant" },
      { revision: pending.revision + 1 },
      { requestId: "other" },
    ]) {
      expect(
        await handleInterviewResponse(store, run.runId, {
          ok: true,
          ...pending,
          source: "user",
          messageId: "fabricated",
          text: pending.options?.[0]?.label ?? "",
          ...patch,
        } as never),
      ).toBe(false);
    }
    expect(
      (
        await completeInterview(
          store,
          adapter,
          proposal,
          run.planning.sessionId,
        )
      ).outcome,
    ).toBe("stale");
    // The same recorded request was shown again; no new revision was opened.
    expect(count).toBe(2);
    expect((await store.getRun(run.runId))?.planning?.pending?.requestId).toBe(
      pending.requestId,
    );
    expect((await store.getRun(run.runId))?.planning?.approval).toBeUndefined();
    expect(
      fake.requests.some((r) =>
        String(r.body.text).includes("**15. Appendix**"),
      ),
    ).toBe(false);
  } finally {
    await project.cleanup();
  }
});

test("native approved prompt delivery retains intent on denial and retries without reapproving", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { completeInterview } = await import(
    "../../src/planning/completion.js"
  );
  const { project, fake, adapter, store, context } = await readyProject();
  try {
    adapter.discoverTools = async () => ["question"];
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "feature",
      text: "Reset",
    });
    fake.respond("Ready");
    const run = await startNativeFeature({ ...context, adapter, store });
    if (!run?.planning) throw new Error("Missing run");
    let approvals = 0;
    adapter.requestUserInput = async (request) => {
      approvals++;
      return {
        ok: true,
        ...request,
        source: "user",
        messageId: "approval",
        text: request.options?.[0]?.label ?? "",
      };
    };
    const queue = adapter.queueStagePrompt;
    if (!queue) throw new Error("Missing stage queue");
    adapter.queueStagePrompt = async () => {
      throw new Error("Permission denied by host");
    };
    const proposal = {
      runId: run.runId,
      attempt: 1,
      text: "Reset",
      scope: ["Reset"],
      criteria: ["Works"],
    };
    await expect(
      completeInterview(store, adapter, proposal, run.planning.sessionId),
    ).rejects.toThrow("Permission denied");
    const intent = (await store.getRun(run.runId))?.planning?.prdDelivery;
    expect(intent?.status).toBe("intent");
    expect(intent?.id).toStartWith("msg_");
    adapter.queueStagePrompt = queue;
    expect(
      (
        await completeInterview(
          store,
          adapter,
          proposal,
          run.planning.sessionId,
        )
      ).outcome,
    ).toBe("already-completed");
    expect(approvals).toBe(1);
    expect((await store.getRun(run.runId))?.planning?.prdDelivery?.status).toBe(
      "queued",
    );
    expect(fake.requests.filter((r) => r.body.id === intent?.id)).toHaveLength(
      1,
    );
  } finally {
    await project.cleanup();
  }
});

test("time waiting for a human answer does not count toward the interview deadline", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { setPlanningQuestionWaiting } = await import(
    "../../src/planning/generation.js"
  );
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { project, fake, adapter, store, context } = await readyProject();
  try {
    await writeFile(
      join(project.directory, ".ralph/project.json"),
      JSON.stringify({ timeoutMs: 300 }),
    );
    adapter.discoverTools = async () => ["question", "read"];
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "human-feature",
      text: "Build reset",
    });
    // The interviewer asks a native question and the human answers slowly.
    fake.respond(async () => {
      const run = (await store.listRuns()).find((r) => r.planning);
      const sessionId = run?.planning?.owner?.sessionId ?? "";
      await setPlanningQuestionWaiting(
        store,
        run?.runId ?? "",
        sessionId,
        "q1",
        true,
      );
      await Bun.sleep(1200);
      await setPlanningQuestionWaiting(
        store,
        run?.runId ?? "",
        sessionId,
        "q1",
        false,
      );
      return "Still exploring.";
    });
    const run = await startNativeFeature({ ...context, adapter, store });
    expect(run?.control?.status ?? "active").toBe("active");
    expect(String(run?.planning?.error?.message)).not.toContain("timed out");
  } finally {
    await project.cleanup();
  }
});

test("scope approval returns to the agent and rides its next question call", async () => {
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { RalphPlugin, relayedStageWork } = await import("../../src/plugin.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  const { project, fake, adapter, store, context } = await readyProject();
  const host = createFakePluginContext(project.directory, fake.client, {
    autoRelay: false,
  });
  const asked: string[] = [];
  host.tools.set("question", {
    id: "question",
    name: "question",
    description: "Native question",
    input: {} as never,
    async execute(input) {
      const q = (
        input as {
          questions: { question: string; options: { label: string }[] }[];
        }
      ).questions[0];
      asked.push(q?.question ?? "");
      return {
        content: "",
        metadata: { answers: [[q?.options[0]?.label ?? ""]] },
      };
    },
  });
  const dispose = await RalphPlugin.setup(host.context);
  try {
    adapter.discoverTools = async () => ["question", "read"];
    adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      source: "user",
      messageId: "feature-human",
      text: "Build reset",
    });
    fake.respond("Ready for completion tool");
    const run = await startNativeFeature({ ...context, adapter, store });
    if (!run?.planning) throw new Error("Missing run");
    const toolContext = {
      sessionID: run.planning.sessionId,
      signal: new AbortController().signal,
    };
    const raw = await host.tools.get("ralph_complete_interview")?.execute(
      {
        runId: run.runId,
        attempt: 1,
        text: "Build reset. Tokens expire.",
        scope: ["Reset tokens"],
        criteria: ["Expired tokens fail"],
      },
      toolContext as never,
    );
    // The tool does not block on the human: the agent shows the full
    // proposal, then its own question call carries the approval form.
    const result = JSON.parse(String(raw?.content));
    expect(result.outcome).toBe("awaiting-human");
    expect(result.show).toContain(
      "Acceptance criteria:\n- Expired tokens fail",
    );
    expect(result.show).toContain(project.commit);
    expect(asked).toEqual([]);
    expect((await store.getRun(run.runId))?.planning?.approval).toBeUndefined();
    await host.answerRelay(run.planning.sessionId);
    await relayedStageWork.get(toolContext);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Approve explanation revision 1");
    const approved = (await store.getRun(run.runId))?.planning;
    expect(approved?.approval?.messageId).toBe("question:call_relay-1");
    expect(approved?.owner?.stage).toBe("prd");
  } finally {
    if (typeof dispose === "function") await dispose();
    await project.cleanup();
  }
});
