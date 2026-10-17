import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandRouter } from "../../src/commands/router.js";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";
import { required } from "../helpers/single-issue.js";

async function fixture() {
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

async function nativePrdFixture() {
  const f = await fixture();
  const { git } = await import("../helpers/project.js");
  await git("git", ["-C", f.project.directory, "add", ".ralph"]);
  await git("git", [
    "-C",
    f.project.directory,
    "commit",
    "-m",
    "verified command setup",
  ]);
  f.project.commit = (
    await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
  ).stdout.trim();
  const { startNativeFeature } = await import(
    "../../src/commands/orchestrator.js"
  );
  const { RalphPlugin } = await import("../../src/plugin.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  f.adapter.discoverTools = async () => ["question", "read"];
  f.adapter.requestUserInput = async (request) => ({
    ok: true,
    ...request,
    source: "user",
    messageId: request.requestId,
    text: "Diamond",
  });
  const host = createFakePluginContext(f.project.directory, f.fake.client);
  const questionCalls: {
    messageID?: string;
    id?: string;
    question?: string | undefined;
  }[] = [];
  host.tools.set("question", {
    id: "question",
    name: "question",
    description: "Native input",
    input: {} as never,
    async execute(input, toolContext) {
      questionCalls.push({
        messageID: toolContext.messageID,
        id: toolContext.id,
        question: (input as { questions: { question: string }[] }).questions[0]
          ?.question,
      });
      const q = (input as { questions: { options: { label: string }[] }[] })
        .questions[0];
      return { content: "", metadata: { answers: [[q?.options[0]?.label]] } };
    },
  });
  const dispose = await RalphPlugin.setup(host.context);
  f.fake.respond("Use stage completion");
  const run = await startNativeFeature({
    workspace: f.project.directory,
    sessionId: "main",
    store: f.store,
    adapter: f.adapter,
  });
  if (!run?.planning) throw new Error("Missing native run");
  const context = {
    sessionID: run.planning.sessionId,
    messageID: "msg_complete-interview",
    id: "call_complete-interview",
    signal: new AbortController().signal,
  } as never;
  await host.tools.get("ralph_complete_interview")?.execute(
    {
      runId: run.runId,
      attempt: 1,
      text: "Build diamond",
      scope: ["Diamond"],
      criteria: ["D works"],
    },
    context,
  );
  const state = (await f.store.getRun(run.runId))?.planning;
  const headings = [
    "Executive Summary",
    "Mission",
    "Target Users",
    "MVP Scope",
    "User Stories",
    "Core Architecture & Patterns",
    "Tools/Features",
    "Technology Stack",
    "Security & Configuration",
    "Success Criteria",
    "Implementation Phases",
    "Future Considerations",
    "Risks & Mitigations",
  ];
  const text =
    headings
      .map((h, i) => `## ${i + 1}. ${h}\nConcrete diamond requirements.`)
      .join("\n") +
    `\nApproved explanation: revision ${state?.explanation?.revision}, hash ${state?.explanation?.hash}\n`;
  const input = { runId: run.runId, attempt: 1, path: "PRD.md" };
  const write = async (content: string) =>
    host.tools
      .get("ralph_write_planning_file")
      ?.execute({ ...input, content }, context);
  const complete = async (args = input, ctx = context) => {
    const tool = host.tools.get("ralph_complete_prd");
    if (!tool) throw new Error("Missing PRD completion tool");
    return JSON.parse(String((await tool.execute(args, ctx)).content));
  };
  return {
    ...f,
    host,
    dispose,
    run,
    context,
    text,
    input,
    write,
    complete,
    questionCalls,
  };
}

test("native PRD completion accepts exact bytes and opens one restricted fresh planner", async () => {
  const f = await nativePrdFixture();
  try {
    // OpenCode does not show forms Ralph creates from a tool call, so the scope
    // approval is relayed through the interviewer's own question tool call.
    // The agent called it with empty input; Ralph supplied the exact question.
    expect(f.questionCalls).toEqual([
      {
        messageID: "msg_relay-1",
        id: "call_relay-1",
        question: expect.stringContaining(
          "Approve explanation revision 1 shown above in this chat?",
        ),
      },
    ]);
    await f.write(f.text);
    const [result, duplicate] = await Promise.all([f.complete(), f.complete()]);
    expect(duplicate).toEqual(result);
    expect(result).toMatchObject({ outcome: "accepted" });
    const state = (await f.store.getRun(f.run.runId))?.planning;
    expect(state?.owner?.stage).toBe("issues");
    expect(state?.sessionId).not.toBe(f.run.planning?.sessionId);
    expect(
      await readFile(
        join(f.project.directory, state?.prd?.artifactPath ?? ""),
        "utf8",
      ),
    ).toBe(f.text);
    const prompts = f.fake.requests.filter(
      (r) =>
        r.path.endsWith("/prompt") &&
        String(r.body.text).includes("# To Issues"),
    );
    expect(prompts).toHaveLength(1);
    for (const value of [
      f.text,
      state?.prd?.hash,
      f.project.commit,
      f.project.directory,
      "Approved commands:",
      "Step-by-step tasks",
      "ralph_complete_issues",
    ])
      expect(String(prompts[0]?.body.text)).toContain(value as string);
    expect(String(prompts[0]?.body.text)).not.toContain(
      "/setup-matt-pocock-skills",
    );
    const before = f.fake.requests.length;
    expect(await f.complete()).toEqual(result);
    expect(f.fake.requests).toHaveLength(before);
    const writer = f.host.tools.get("ralph_write_planning_file");
    const planner = {
      ...(f.context as object),
      sessionID: state?.sessionId,
    } as never;
    for (const path of ["graph.json", "issues/1-foundation.md"])
      expect(
        (await writer?.execute({ ...f.input, path, content: "{}" }, planner))
          ?.content,
      ).toContain("accepted");
    for (const path of [
      "PRD.md",
      "src/plugin.ts",
      "../graph.json",
      "issues/../../escape.md",
      "issues/A.md",
    ])
      await expect(
        writer?.execute({ ...f.input, path, content: "bad" }, planner),
      ).rejects.toThrow();
    await expect(f.write("replace accepted")).rejects.toThrow();
    expect(
      f.fake.requests.filter(
        (r) => r.path === `/api/session/${state?.sessionId}/wait`,
      ),
    ).toHaveLength(0);
    expect(state?.executionEligibility).toBeUndefined();
    expect(f.host.stageSessions).toHaveLength(1);
  } finally {
    if (typeof f.dispose === "function")
      if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

test("native PRD completion rejects foreign ownership, stale attempts and malformed drafts without creating a planner", async () => {
  const f = await nativePrdFixture();
  try {
    const count = () =>
      f.fake.requests.filter((r) => r.path === "/api/session").length;
    const before = count();
    await f.write(f.text);
    await expect(
      f.complete(f.input, {
        ...(f.context as object),
        sessionID: "foreign",
      } as never),
    ).rejects.toThrow("ownership");
    await expect(f.complete({ ...f.input, attempt: 2 })).rejects.toThrow(
      "ownership",
    );
    await expect(
      f.complete({ ...f.input, path: "../PRD.md" }),
    ).rejects.toThrow();
    for (const text of [
      " ",
      "# Incomplete",
      f.text.replace(/hash [a-f0-9]{64}/, `hash ${"0".repeat(64)}`),
      f.text.replace("Concrete diamond requirements.", ""),
    ]) {
      // Empty drafts can also arrive from interrupted disk writes.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(
          f.project.directory,
          ".ralph/features",
          f.run.runId,
          "prd-draft-1/PRD.md",
        ),
        text,
      );
      expect((await f.complete()).outcome).toBe("correctable-invalid");
    }
    expect(count()).toBe(before);
    expect((await f.store.getRun(f.run.runId))?.planning?.prd).toBeUndefined();
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

for (const effect of ["creation", "prompt", "focus"] as const) {
  test(`native PRD handoff reconciles a lost ${effect} receipt without another child`, async () => {
    const f = await nativePrdFixture();
    try {
      await f.write(f.text);
      if (effect === "creation") f.fake.loseCreationReceipt();
      if (effect === "prompt") f.fake.losePromptReceipt();
      if (effect === "focus") {
        // The event is delivered but its acknowledgement is lost.
        // setup already captured the emitter; replace its observable sink instead.
        const push = f.host.stageSessions.push.bind(f.host.stageSessions);
        let failed = false;
        f.host.stageSessions.push = (...values) => {
          const size = push(...values);
          if (!failed) {
            failed = true;
            throw new Error("Lost focus receipt");
          }
          return size;
        };
      }
      expect((await f.complete()).outcome).toBe("blocked");
      const accepted = (await f.store.getRun(f.run.runId))?.planning?.prd;
      expect(accepted).toBeDefined();
      // Recovery uses accepted bytes, regardless of a now changed source draft.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(
          f.project.directory,
          ".ralph/features",
          f.run.runId,
          "prd-draft-1/PRD.md",
        ),
        "changed draft",
      );
      const result = await f.complete();
      expect(result.outcome).toBe("accepted");
      const creations = f.fake.requests.filter(
        (r) =>
          r.path === "/api/session" &&
          (
            r.body.metadata as { ralph?: { jobId?: string } }
          )?.ralph?.jobId?.startsWith("issues-prd-"),
      );
      expect(creations).toHaveLength(1);
      expect(result.prd).toEqual(accepted);
      const handoff = (await f.store.getRun(f.run.runId))?.planning
        ?.issueHandoff;
      expect(handoff?.queued).toBe(true);
      expect(handoff?.focused).toBe(true);
      expect(
        (await f.store.getRun(f.run.runId))?.control?.status ?? "active",
      ).toBe("active");
      expect(await f.complete()).toEqual(result);
    } finally {
      if (typeof f.dispose === "function") await f.dispose();
      await f.project.cleanup();
    }
  });
}

test("native planner denies indirect writes and symlinks and denies administrative tools", async () => {
  const f = await nativePrdFixture();
  try {
    await f.write(f.text);
    await f.complete();
    const state = (await f.store.getRun(f.run.runId))?.planning;
    const sessionID = state?.sessionId;
    for (const tool of [
      "write",
      "edit",
      "shell",
      "task",
      "codemode",
      "ralph_workflow",
    ]) {
      await expect(
        f.host.hooks.get("tool.execute.before")?.({ sessionID, tool }),
      ).rejects.toThrow("Permission denied");
    }
    const tools = {
      read: {},
      question: {},
      ralph_write_planning_file: {},
      shell: {},
      write: {},
      codemode: {},
    };
    await f.host.hooks.get("session.context")?.({ sessionID, tools });
    expect(Object.keys(tools)).toEqual([
      "read",
      "question",
      "ralph_write_planning_file",
    ]);
    const { mkdir, symlink } = await import("node:fs/promises");
    const draft = join(
      f.project.directory,
      ".ralph/features",
      f.run.runId,
      "issues-draft-1",
    );
    await mkdir(draft);
    await symlink(f.project.directory, join(draft, "issues"));
    await expect(
      f.host.tools.get("ralph_write_planning_file")?.execute(
        {
          ...f.input,
          path: "issues/1-escape.md",
          content: "bad",
        },
        { ...(f.context as object), sessionID } as never,
      ),
    ).rejects.toThrow("symlink");
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

test("native PRD acceptance refuses a symlink source without opening issue planning", async () => {
  const f = await nativePrdFixture();
  try {
    await f.write(f.text);
    const { rm, symlink } = await import("node:fs/promises");
    const path = join(
      f.project.directory,
      ".ralph/features",
      f.run.runId,
      "prd-draft-1/PRD.md",
    );
    await rm(path);
    await symlink(join(f.project.directory, "README.md"), path);
    const result = await f.complete();
    expect(result.outcome).toBe("correctable-invalid");
    expect(result.message).toContain("symlink");
    expect(
      (await f.store.getRun(f.run.runId))?.planning?.issueHandoff,
    ).toBeUndefined();
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

test("native issue completion accepts one immutable bundle and starts baseline without another question", async () => {
  const f = await nativePrdFixture();
  try {
    await f.write(f.text);
    await f.complete();
    const state = (await f.store.getRun(f.run.runId))?.planning;
    const planner = {
      sessionID: state?.sessionId,
      signal: new AbortController().signal,
    } as never;
    const issuePath = "issues/1-foundation.md";
    const text =
      "# Foundation\n## What to build\nBuild diamond\n## Context: files to read before implementing\nREADME.md\n## Patterns to follow\nExisting tests\n## Step-by-step tasks\nAdd behavior and tests\n## Acceptance criteria\nD works\n## Validation commands\nApproved checks\n## Blocked by\nNone";
    const graph = {
      schemaVersion: 1,
      prdRevision: state?.prd,
      issues: [
        {
          id: "A",
          title: "Foundation",
          artifactPath: issuePath,
          dependencies: [],
          acceptanceCriteria: ["D works"],
          testableBehaviors: ["D works"],
        },
      ],
    };
    const writer = f.host.tools.get("ralph_write_planning_file");
    for (const [path, content] of [
      [issuePath, text],
      ["graph.json", JSON.stringify(graph)],
    ])
      await writer?.execute(
        { runId: f.run.runId, attempt: 1, path, content },
        planner,
      );
    const tool = f.host.tools.get("ralph_complete_issues");
    expect(tool).toBeDefined();
    // A denied command must be a persisted baseline blocker, never a new approval.
    f.host.tools.set("question", {
      ...required(f.host.tools.get("question")),
      async execute() {
        throw new Error("Unexpected second question");
      },
    });
    const result = JSON.parse(
      String(
        (
          await tool?.execute(
            { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
            planner,
          )
        )?.content,
      ),
    );
    expect(result.outcome).toBe("accepted");
    const accepted = await f.store.getRun(f.run.runId);
    expect(accepted?.planning?.graph?.hash).toBeDefined();
    expect(accepted?.planning?.executionEligibility?.requestId).toBe(
      state?.approval?.requestId,
    );
    expect(accepted?.planning && "executionApproval" in accepted.planning).toBe(
      false,
    );
    expect(accepted?.baseline).toBeDefined();
    expect(accepted?.baseline?.blocker ?? "").not.toContain(
      "Checkout is dirty",
    );
    const events = (await f.store.events(f.run.runId)).length;
    expect(
      JSON.parse(
        String(
          (
            await tool?.execute(
              { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
              planner,
            )
          )?.content,
        ),
      ),
    ).toEqual(result);
    expect((await f.store.events(f.run.runId)).length).toBe(events);
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

async function nativeIssueFixture() {
  const f = await nativePrdFixture();
  await f.write(f.text);
  await f.complete();
  const state = required(required(await f.store.getRun(f.run.runId)).planning);
  const planner = {
    sessionID: state.sessionId,
    signal: new AbortController().signal,
  } as never;
  const text =
    "# Foundation\n## What to build\nBuild diamond\n## Context: files to read before implementing\nREADME.md\n## Patterns to follow\nExisting tests\n## Step-by-step tasks\nAdd behavior and tests\n## Acceptance criteria\nD works\n## Validation commands\nApproved checks\n## Blocked by\nNone";
  const graph = {
    schemaVersion: 1,
    prdRevision: state.prd,
    issues: [
      {
        id: "A",
        title: "Foundation",
        artifactPath: "issues/1-foundation.md",
        dependencies: [] as string[],
        acceptanceCriteria: ["D works"],
        testableBehaviors: ["D works"],
      },
    ],
  };
  const write = async (path: string, content: string) =>
    required(f.host.tools.get("ralph_write_planning_file")).execute(
      { runId: f.run.runId, attempt: 1, path, content },
      planner,
    );
  await write(required(graph.issues[0]).artifactPath, text);
  await write("graph.json", JSON.stringify(graph));
  const complete = async (ctx = planner, attempt = 1) =>
    JSON.parse(
      String(
        (
          await required(f.host.tools.get("ralph_complete_issues")).execute(
            { runId: f.run.runId, attempt, graphPath: "graph.json" },
            ctx,
          )
        ).content,
      ),
    );
  const cleanup = async () => {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  };
  return {
    ...f,
    state,
    planner,
    graph,
    writeIssue: write,
    completeIssues: complete,
    cleanup,
  };
}

for (const invalid of [
  "duplicate",
  "cycle",
  "unknown",
  "missing",
  "foreign",
  "wrong-prd",
  "old-template",
  "empty-section",
  "symlink",
] as const) {
  test(`native issue completion rejects ${invalid} before baseline`, async () => {
    const f = await nativeIssueFixture();
    try {
      const { rm, symlink } = await import("node:fs/promises");
      const first = required(f.graph.issues[0]);
      if (invalid === "duplicate") f.graph.issues.push(first);
      if (invalid === "cycle") first.dependencies = ["A"];
      if (invalid === "unknown") first.dependencies = ["missing"];
      if (invalid === "missing") first.artifactPath = "issues/2-missing.md";
      if (invalid === "foreign") first.artifactPath = "../foreign.md";
      if (invalid === "wrong-prd")
        f.graph.prdRevision = {
          ...required(f.graph.prdRevision),
          revision: 99,
        };
      if (invalid === "old-template")
        await f.writeIssue(
          first.artifactPath,
          "# Issue\n## Context\nOld\n## Implementation\nOld\n## Tests\nOld\n## Acceptance criteria\nOld\n## Dependencies\nNone",
        );
      if (invalid === "empty-section")
        await f.writeIssue(
          first.artifactPath,
          "# Issue\n## Context: files to read before implementing\nREADME.md\n## What to build\n\n## Patterns to follow\nTests\n## Step-by-step tasks\nAdd behavior\n## Validation commands\nApproved checks\n## Acceptance criteria\nWorks\n## Blocked by\nNone",
        );
      if (invalid === "symlink") {
        const path = join(
          f.project.directory,
          `.ralph/features/${f.run.runId}/issues-draft-1/issues/1-foundation.md`,
        );
        await rm(path);
        await symlink(join(f.project.directory, "README.md"), path);
      }
      await f.writeIssue("graph.json", JSON.stringify(f.graph));
      expect((await f.completeIssues()).outcome).toBe("correctable-invalid");
      const run = await f.store.getRun(f.run.runId);
      expect(run?.baseline).toBeUndefined();
      expect(run?.planning?.executionEligibility).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
}

test("native issue completion rejects stale owners and attempts", async () => {
  const f = await nativeIssueFixture();
  try {
    await expect(
      f.completeIssues({
        sessionID: "foreign",
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow("ownership");
    await expect(f.completeIssues(f.planner, 2)).rejects.toThrow("ownership");
    expect((await f.store.getRun(f.run.runId))?.baseline).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

for (const change of [
  "HEAD",
  "commands",
  "artifact",
  "tracked",
  "untracked",
  "foreign-output",
] as const) {
  test(`native issue completion blocks changed ${change} before commands or workers`, async () => {
    const f = await nativeIssueFixture();
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { git } = await import("../helpers/project.js");
      if (change === "HEAD")
        await git("git", [
          "-C",
          f.project.directory,
          "commit",
          "--allow-empty",
          "-m",
          "changed HEAD",
        ]);
      if (change === "commands") {
        const path = join(f.project.directory, ".ralph/commands.json");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.revision++;
        await writeFile(path, JSON.stringify(config));
      }
      if (change === "artifact")
        await writeFile(
          join(f.project.directory, required(f.state.prd).artifactPath),
          "Changed PRD",
        );
      if (change === "tracked")
        await writeFile(join(f.project.directory, "README.md"), "User changes");
      if (change === "untracked")
        await writeFile(join(f.project.directory, "user.txt"), "User changes");
      if (change === "foreign-output") {
        const dir = join(
          f.project.directory,
          `.ralph/features/${f.run.runId}/issues-draft-1`,
        );
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "user.md"), "Unrecorded work");
      }
      const result = await f.completeIssues();
      const run = await f.store.getRun(f.run.runId);
      if (["HEAD", "commands"].includes(change)) {
        expect(result.outcome).toBe("blocked");
        expect(run?.planning?.error?.code).toBe("baseline-blocked");
      } else if (change === "artifact") {
        expect(result.outcome).toBe("blocked");
        expect(run?.planning?.error?.code).toBe("baseline-blocked");
      } else expect(run?.baseline?.blocker).toContain("Checkout is dirty");
      expect(
        Object.values(run?.operations ?? {}).some(
          (op) => op.kind === "baseline.workspace",
        ),
      ).toBe(false);
      expect(
        Object.values(run?.jobs ?? {}).some(
          (job) => job.envelope.role === "executor",
        ),
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
}

test("native accepted issues run real Git workers and both independent reviewers from the pinned commit", async () => {
  const f = await nativeIssueFixture();
  try {
    const { completeIssues } = await import("../../src/planning/completion.js");
    const { attachSingleIssueEngine } = await import(
      "../helpers/single-issue.js"
    );
    const { runAutomaticReview } = await import(
      "../../src/review/automatic.js"
    );
    const { createFakeOpenCode } = await import("../helpers/fake-opencode.js");
    attachSingleIssueEngine(f.adapter, f.fake);
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    f.adapter.dispatchJob = async (job) => {
      if (!["code-review", "functional-review"].includes(job.role))
        return dispatch(job);
      const fake = createFakeOpenCode({ sessionPrefix: job.jobId });
      fake.respond(
        JSON.stringify({
          role: job.role,
          reviewedCommit: job.baseCommit,
          round: 1,
          outcome: "passed",
          findings: [],
          evidenceRefs: ["observed"],
          criteria: [
            {
              id: "issue-A-1",
              status: "pass",
              coverage: ["log"],
              evidenceRefs: ["observed"],
            },
          ],
          evidence: [
            {
              id: "observed",
              kind: "log",
              summary: "Real Git fixture checks",
              reviewedCommit: job.baseCommit,
            },
          ],
        }),
      );
      return createOpenCodeAdapter(fake.client, f.store).dispatchJob(job);
    };
    f.adapter.finalizeExecution = (snapshot) =>
      runAutomaticReview(f.store, f.adapter, snapshot);
    f.adapter.requestUserInput = async () => {
      throw new Error("Unexpected second approval");
    };
    const args = {
      runId: f.run.runId,
      attempt: 1,
      graphPath: "graph.json" as const,
    };
    const [result, duplicate] = await Promise.all([
      completeIssues(f.store, f.adapter, args, f.state.sessionId),
      completeIssues(f.store, f.adapter, args, f.state.sessionId),
    ]);
    expect(duplicate).toEqual(result);
    expect(result).toMatchObject({ outcome: "accepted" });
    const run = await f.store.getRun(f.run.runId);
    expect(run?.baseline?.status).toBe("passed");
    expect(run?.issueAttempts?.A?.status).toBe("integrated");
    expect(run?.reviewWorkflow?.status).toBe("terminal");
    expect(run?.reviewWorkflow?.report?.outcome).toBe("verified");
    // Plugin-owned observation survives the stage tool and uses the issue chat.
    const deadline = Date.now() + 5000;
    while (
      !f.fake.requests.some(
        (r) =>
          r.path.endsWith("/synthetic") &&
          String(r.body.text).startsWith("Ralph finished: verified"),
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const progress = f.fake.requests.filter(
      (r) =>
        r.path.endsWith("/synthetic") &&
        String(r.body.id).startsWith("msg_ralph-progress-"),
    );
    expect(
      progress.some(
        (r) =>
          r.path === `/api/session/${f.state.sessionId}/synthetic` &&
          String(r.body.text).startsWith("Ralph finished: verified"),
      ),
    ).toBe(true);
    expect(progress.every((r) => r.body.resume === false)).toBe(true);
    expect(progress.some((r) => String(r.body.text).includes("selected"))).toBe(
      true,
    );
    expect(progress.some((r) => String(r.body.text).includes("executor"))).toBe(
      true,
    );
    expect(
      progress.some((r) => String(r.body.text).includes("code-review")),
    ).toBe(true);
    expect(
      progress.some((r) => String(r.body.text).includes("functional-review")),
    ).toBe(true);

    const jobs = Object.values(run?.jobs ?? {}).map((job) => job.envelope);
    const sessions = jobs
      .filter((job) =>
        ["executor", "code-review", "functional-review"].includes(job.role),
      )
      .map((job) => job.sessionId);
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions).size).toBe(3);
    expect(sessions).not.toContain(f.state.sessionId);
    expect(run?.planning?.executionEligibility).toMatchObject({
      requestId: f.state.approval?.requestId,
      messageId: f.state.approval?.messageId,
      selectedCommit: f.project.commit,
    });
    const { git } = await import("../helpers/project.js");
    expect(
      (
        await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
      ).stdout.trim(),
    ).toBe(f.project.commit);
    expect(
      (
        await git("git", [
          "-C",
          f.project.directory,
          "show-ref",
          `refs/heads/${run?.baseline?.branch}`,
        ])
      ).stdout,
    ).toContain(required(run?.review?.snapshot.commit));
  } finally {
    await f.cleanup();
  }
});

test("native issue publication reconciles a lost acceptance write using the same immutable bundle", async () => {
  const f = await nativeIssueFixture();
  const { completeIssues } = await import("../../src/planning/completion.js");
  const complete = () =>
    completeIssues(
      f.store,
      f.adapter,
      { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
      f.state.sessionId,
    );
  const record = f.store.recordPlanning.bind(f.store);
  let loseReceipt = true;
  f.store.recordPlanning = async (runId, revision, planning) => {
    if (loseReceipt && planning.graph && planning.executionEligibility) {
      loseReceipt = false;
      return false;
    }
    return record(runId, revision, planning);
  };
  try {
    await expect(complete()).rejects.toThrow("Stale planning transition");
    const interrupted = await f.store.getRun(f.run.runId);
    expect(interrupted?.planning?.issueAcceptance?.graph.hash).toBeDefined();
    expect(interrupted?.planning?.graph).toBeUndefined();
    expect(interrupted?.baseline).toBeUndefined();
    const path = join(
      f.project.directory,
      `.ralph/features/${f.run.runId}/graph-1/graph.json`,
    );
    const bytes = await readFile(path, "utf8");
    const result = await complete();
    expect(result.outcome).toBe("accepted");
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await f.store.getRun(f.run.runId))?.planning?.graph?.hash).toBe(
      interrupted?.planning?.issueAcceptance?.graph.hash,
    );
    await expect(f.writeIssue("graph.json", "{}")).rejects.toThrow();
    expect(await complete()).toEqual(result);
  } finally {
    await f.cleanup();
  }
});

for (const stage of ["prd", "issues"] as const) {
  test(`native ${stage} product decision persists a clarification without another approval`, async () => {
    const f = await nativePrdFixture();
    try {
      if (stage === "issues") {
        await f.write(f.text);
        await f.complete();
      }
      const before = required((await f.store.getRun(f.run.runId))?.planning);
      const tool = f.host.tools.get("ralph_request_product_decision");
      expect(tool).toBeDefined();
      const result = JSON.parse(
        String(
          (
            await required(tool).execute(
              {
                runId: f.run.runId,
                attempt: 1,
                question: "Which existing value?",
                recommendation: "Use one",
              },
              {
                sessionID: before.sessionId,
                signal: new AbortController().signal,
              } as never,
            )
          ).content,
        ),
      );
      expect(result.outcome).toBe("answered");
      const after = required((await f.store.getRun(f.run.runId))?.planning);
      expect(after.approval).toEqual(before.approval);
      expect(after.phase).toBe(before.phase);
      expect(after.decisions?.[0]?.answer?.text).toBe("Use one");
      expect(after.decisions?.[0]?.request.question).toContain(stage);
      expect(after.pending).toBeUndefined();
    } finally {
      if (typeof f.dispose === "function") await f.dispose();
      await f.project.cleanup();
    }
  });
}

test("native planner scope revision invalidates accepted artifacts and requires a distinct explanation approval", async () => {
  const f = await nativeIssueFixture();
  try {
    const questions: string[] = [];
    f.host.tools.set("question", {
      ...required(f.host.tools.get("question")),
      async execute(input) {
        const q = (
          input as {
            questions: { question: string; options: { label: string }[] }[];
          }
        ).questions[0];
        questions.push(required(q).question);
        return {
          content: "",
          metadata: { answers: [[required(q).options[0]?.label]] },
        };
      },
    });
    const result = JSON.parse(
      String(
        (
          await required(
            f.host.tools.get("ralph_request_product_decision"),
          ).execute(
            {
              runId: f.run.runId,
              attempt: 1,
              question: "Retain results?",
              recommendation: "Retain one day",
              revisedExplanation: {
                text: "Build diamond with retention",
                scope: ["Diamond", "One day retention"],
                criteria: ["D works", "Expires after one day"],
              },
            },
            f.planner,
          )
        ).content,
      ),
    );
    expect(result.outcome).toBe("accepted");
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain("Approve explanation revision 2");
    // The full revised scope is shown in the planner chat before the form.
    expect(
      f.fake.requests.some(
        (r) =>
          r.path.endsWith("/prompt") &&
          String(r.body.text).includes("Expires after one day"),
      ),
    ).toBe(true);
    const after = required((await f.store.getRun(f.run.runId))?.planning);
    expect(after.approval?.requestId).not.toBe(
      required(f.state.approval?.requestId),
    );
    expect(after.phase).toBe("prd_generation");
    const superseded = required(
      after.attempts?.find((a) => a.stage === "issues"),
    );
    expect(superseded.status).toBe("retired");
    expect(
      (await f.store.getRun(f.run.runId))?.jobs[superseded.job.jobId]?.status,
    ).toBe("terminal");
    expect(after.prd).toBeUndefined();
    expect(after.graph).toBeUndefined();
    expect(after.executionEligibility).toBeUndefined();
    expect(after.history?.[0]?.prd).toEqual(f.state.prd);
    await expect(f.completeIssues()).rejects.toThrow();
    const revised = f.text.replace(
      /Approved explanation: revision .*\n/,
      `Approved explanation: revision ${after.explanation?.revision}, hash ${after.explanation?.hash}\n`,
    );
    await required(f.host.tools.get("ralph_write_planning_file")).execute(
      { ...f.input, content: revised },
      f.planner,
    );
    await required(f.host.tools.get("ralph_complete_prd")).execute(
      f.input,
      f.planner,
    );
    const regenerated = required((await f.store.getRun(f.run.runId))?.planning);
    expect(regenerated.prd?.revision).toBe(2);
    expect(regenerated.prd?.artifactPath).toContain("prd-2/");
    const planner = {
      sessionID: regenerated.sessionId,
      signal: new AbortController().signal,
    } as never;
    const writer = required(f.host.tools.get("ralph_write_planning_file"));
    const graph = { ...f.graph, prdRevision: regenerated.prd };
    const issueText = await readFile(
      join(
        f.project.directory,
        `.ralph/features/${f.run.runId}/issues-draft-1/issues/1-foundation.md`,
      ),
      "utf8",
    );
    for (const [path, content] of [
      ["issues/1-foundation.md", issueText],
      ["graph.json", JSON.stringify(graph)],
    ])
      await writer.execute(
        { runId: f.run.runId, attempt: 1, path, content },
        planner,
      );
    const accepted = JSON.parse(
      String(
        (
          await required(f.host.tools.get("ralph_complete_issues")).execute(
            { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
            planner,
          )
        ).content,
      ),
    );
    expect(accepted.outcome).toBe("accepted");
    const bundle = required((await f.store.getRun(f.run.runId))?.planning);
    expect(bundle.graph?.revision).toBe(1); // No previous graph was accepted in this fixture.
    expect(bundle.executionEligibility?.requestId).toBe(
      after.approval?.requestId,
    );
    expect(bundle.executionEligibility?.explanationHash).toBe(
      after.explanation?.hash,
    );
    expect(questions).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

for (const changed of ["HEAD", "commands"] as const) {
  test(`native resume displays changed ${changed} and rejection keeps execution unauthorized`, async () => {
    const f = await nativeIssueFixture();
    try {
      const { git } = await import("../helpers/project.js");
      if (changed === "HEAD")
        await git("git", [
          "-C",
          f.project.directory,
          "commit",
          "--allow-empty",
          "-m",
          "new starting point",
        ]);
      else {
        const { writeFile } = await import("node:fs/promises");
        const path = join(f.project.directory, ".ralph/commands.json");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.revision++;
        await writeFile(path, JSON.stringify(config));
      }
      const head = (
        await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
      ).stdout.trim();
      const { resumeWorkflow } = await import("../../src/commands/resume.js");
      let shown = "";
      f.adapter.requestUserInput = async (request) => {
        // The short form question plus the full context shown in chat.
        shown = `${request.question}\n${request.details ?? ""}`;
        return {
          ok: true,
          ...request,
          source: "user",
          messageId: request.requestId,
          text: "Request changes",
        };
      };
      await resumeWorkflow(f.store, f.adapter, f.run.runId);
      expect(shown).toContain(head);
      expect(shown).toContain("Build diamond");
      expect(shown).toContain("Command revision:");
      const paused = required((await f.store.getRun(f.run.runId))?.planning);
      expect(paused.approval).toBeUndefined();
      expect(paused.executionEligibility).toBeUndefined();
      expect(paused.prd).toBeUndefined();
      expect(paused.history?.[0]?.approval).toEqual(f.state.approval);
      await expect(f.completeIssues()).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
}

test("pending native decision blocks completion and stale native results retain the request", async () => {
  const f = await nativePrdFixture();
  try {
    await f.write(f.text);
    let settle:
      | ((value: {
          content: string;
          metadata: { answers: string[][] };
        }) => void)
      | undefined;
    f.host.tools.set("question", {
      ...required(f.host.tools.get("question")),
      async execute() {
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });
    const work = required(
      f.host.tools.get("ralph_request_product_decision"),
    ).execute(
      {
        runId: f.run.runId,
        attempt: 1,
        question: "Which value?",
        recommendation: "one",
      },
      f.context,
    );
    const { until } = await import("../helpers/diamond.js");
    await until(() => !!settle);
    expect((await f.complete()).outcome).toBe("blocked");
    const current = required(await f.store.getRun(f.run.runId));
    const next = structuredClone(required(current.planning));
    required(next.pending).requestId = "superseded";
    expect(
      await f.store.recordPlanning(f.run.runId, current.revision, next),
    ).toBe(true);
    settle?.({ content: "", metadata: { answers: [["one"]] } });
    expect(JSON.parse(String((await work).content)).outcome).toBe("stale");
    expect(
      (await f.store.getRun(f.run.runId))?.planning?.pending?.requestId,
    ).toBe("superseded");
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

// Two real Git execution passes need an I/O budget; agent/check deadlines stay injected.
test("native executor scope proposals require explanation approval and regenerated accepted artifacts", async () => {
  const f = await nativeIssueFixture();
  try {
    const { completeIssues } = await import("../../src/planning/completion.js");
    const { attachSingleIssueEngine } = await import(
      "../helpers/single-issue.js"
    );
    const { answerExecutorQuestion } = await import(
      "../../src/execution/questions.js"
    );
    const { continuePlanning } = await import("../../src/core/orchestrator.js");
    const { until } = await import("../helpers/diamond.js");
    attachSingleIssueEngine(f.adapter, f.fake);
    const dispatch = f.adapter.dispatchJob.bind(f.adapter);
    f.adapter.dispatchJob = async (job) => {
      if (job.role !== "executor") return dispatch(job);
      f.fake.respond(
        JSON.stringify({
          kind: "needs_input",
          question: "Retain output?",
          recommendedAnswer: "One day",
          affectedRequirement: "retention",
          revisedExplanation: {
            text: "Build diamond with retention",
            scope: ["Diamond", "Retention"],
            criteria: ["D works", "Expires after a day"],
          },
        }),
      );
      return createOpenCodeAdapter(f.fake.client, f.store).dispatchJob(job);
    };
    let request: import("../../src/core/types.js").UserInputRequest | undefined;
    f.adapter.requestUserInput = async (input) => {
      request = input;
      return {
        ok: false,
        error: { code: "unsupported", message: "pending native UI" },
      };
    };
    await completeIssues(
      f.store,
      f.adapter,
      { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
      f.state.sessionId,
    );
    await until(() => !!request);
    expect(request?.kind).toBe("product");
    expect(request?.sessionId).toBe(f.state.sessionId);
    const answer = {
      ok: true as const,
      ...required(request),
      source: "user" as const,
      messageId: "executor-native-answer",
      text: "One day",
    };
    expect(
      await answerExecutorQuestion(f.store, f.run.runId, "A", answer),
    ).toBe(true);
    expect(
      (await f.store.getRun(f.run.runId))?.planning?.executionEligibility,
    ).toBeUndefined();
    f.adapter.requestUserInput = async (input) => ({
      ok: true,
      ...input,
      source: "user",
      messageId: input.requestId,
      text: required(input.options?.[0]).label,
    });
    await continuePlanning(f.store, f.adapter, f.run.runId);
    const revised = required((await f.store.getRun(f.run.runId))?.planning);
    expect(revised.phase).toBe("prd_generation");
    expect(revised.approval?.requestId).not.toBe(answer.requestId);
    expect(revised.scopeChange?.affectedIssueIds).toEqual(["A"]);
    expect(revised.executionEligibility).toBeUndefined();
    expect(revised.graph).toBeUndefined();
    expect((await f.store.getRun(f.run.runId))?.issueAttempts?.A?.attempt).toBe(
      1,
    );
    expect(
      await answerExecutorQuestion(f.store, f.run.runId, "A", {
        ...answer,
        messageId: "late-answer",
      }),
    ).toBe(false);
    const revisedText = f.text.replace(
      /Approved explanation: revision .*\n/,
      `Approved explanation: revision ${revised.explanation?.revision}, hash ${revised.explanation?.hash}\n`,
    );
    await required(f.host.tools.get("ralph_write_planning_file")).execute(
      { ...f.input, content: revisedText },
      f.planner,
    );
    await required(f.host.tools.get("ralph_complete_prd")).execute(
      f.input,
      f.planner,
    );
    const authored = required((await f.store.getRun(f.run.runId))?.planning);
    const planner = {
      sessionID: authored.sessionId,
      signal: new AbortController().signal,
    } as never;
    const issueText = await readFile(
      join(
        f.project.directory,
        `.ralph/features/${f.run.runId}/issues-draft-1/issues/1-foundation.md`,
      ),
      "utf8",
    );
    for (const [path, content] of [
      ["issues/1-foundation.md", issueText],
      ["graph.json", JSON.stringify({ ...f.graph, prdRevision: authored.prd })],
    ])
      await required(f.host.tools.get("ralph_write_planning_file")).execute(
        { runId: f.run.runId, attempt: 1, path, content },
        planner,
      );
    f.adapter.dispatchJob = dispatch;
    f.adapter.finalizeExecution = async () => {};
    f.adapter.requestUserInput = async () => {
      throw new Error("No second execution approval");
    };
    const completed = await completeIssues(
      f.store,
      f.adapter,
      { runId: f.run.runId, attempt: 1, graphPath: "graph.json" },
      authored.sessionId,
    );
    expect(completed.outcome).toBe("accepted");
    const integrated = required(await f.store.getRun(f.run.runId));
    expect(integrated.issueAttempts?.A?.status).toBe("integrated");
    expect(integrated.issueAttempts?.A?.attempt).toBe(1);
    expect(integrated.planning?.graph?.revision).toBe(2);
    expect(integrated.planning?.executionEligibility?.requestId).toBe(
      revised.approval?.requestId,
    );
  } finally {
    await f.cleanup();
  }
}, 90_000);

test("native revised scope approval recovers its persisted request after unavailable input", async () => {
  const f = await nativePrdFixture();
  try {
    let calls = 0;
    f.host.tools.set("question", {
      ...required(f.host.tools.get("question")),
      async execute(input) {
        calls++;
        if (calls === 2) return { content: "", metadata: {} };
        const q = required(
          (input as { questions: { options: { label: string }[] }[] })
            .questions[0],
        );
        return { content: "", metadata: { answers: [[q.options[0]?.label]] } };
      },
    });
    const tool = required(f.host.tools.get("ralph_request_product_decision"));
    const input = {
      runId: f.run.runId,
      attempt: 1,
      question: "Retention?",
      recommendation: "One day",
      revisedExplanation: {
        text: "Add retention",
        scope: ["Retention"],
        criteria: ["Expires"],
      },
    };
    expect(
      JSON.parse(String((await tool.execute(input, f.context)).content))
        .outcome,
    ).toBe("blocked");
    const pending = required(
      (await f.store.getRun(f.run.runId))?.planning?.pending,
    );
    expect((await f.complete()).outcome).toBe("blocked");
    const result = JSON.parse(
      String((await tool.execute(input, f.context)).content),
    );
    expect(result.outcome).toBe("accepted");
    expect(result.requestId).toBe(pending.requestId);
    expect(calls).toBe(3);
    expect(
      (await f.store.getRun(f.run.runId))?.planning?.decisions,
    ).toHaveLength(1);
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

for (const changed of ["HEAD", "commands"] as const) {
  test(`native resume accepts displayed ${changed} only through renewed authorization`, async () => {
    const f = await nativeIssueFixture();
    try {
      const { git } = await import("../helpers/project.js");
      const { writeFile } = await import("node:fs/promises");
      if (changed === "HEAD")
        await git("git", [
          "-C",
          f.project.directory,
          "commit",
          "--allow-empty",
          "-m",
          "new starting point",
        ]);
      else {
        const path = join(f.project.directory, ".ralph/commands.json");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.revision++;
        await writeFile(path, JSON.stringify(config));
      }
      const { resumeWorkflow } = await import("../../src/commands/resume.js");
      let displayed:
        | import("../../src/core/types.js").UserInputRequest
        | undefined;
      f.adapter.requestUserInput = async (request) => {
        displayed = request;
        return {
          ok: true,
          ...request,
          source: "user",
          messageId: request.requestId,
          text: required(request.options?.[0]).label,
        };
      };
      await resumeWorkflow(f.store, f.adapter, f.run.runId);
      const after = required((await f.store.getRun(f.run.runId))?.planning);
      expect(displayed?.details).toContain("Previous pinned HEAD:");
      expect(displayed?.details).toContain("Revised command configuration:");
      expect(after.approval?.requestId).toBe(required(displayed).requestId);
      expect(after.approval?.requestId).not.toBe(
        required(f.state.approval?.requestId),
      );
      expect(after.approval?.sha).toBe(
        (
          await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
        ).stdout.trim(),
      );
      expect(after.commandHash).toBe(required(after.approval?.commandHash));
      expect(after.phase).toBe("prd_generation");
      expect(after.executionEligibility).toBeUndefined();
      expect(after.prd).toBeUndefined();
      if (changed === "commands")
        expect(after.approval?.commandRevision).toBe(
          required(f.state.approval?.commandRevision) + 1,
        );
    } finally {
      await f.cleanup();
    }
  });
}

test("changed inputs supersede an interrupted scope approval instead of reusing its old pinned context", async () => {
  const f = await nativePrdFixture();
  try {
    let calls = 0;
    f.host.tools.set("question", {
      ...required(f.host.tools.get("question")),
      async execute(input) {
        if (++calls === 2) return { content: "", metadata: {} };
        const q = required(
          (input as { questions: { options: { label: string }[] }[] })
            .questions[0],
        );
        return { content: "", metadata: { answers: [[q.options[0]?.label]] } };
      },
    });
    const tool = required(f.host.tools.get("ralph_request_product_decision"));
    const input = {
      runId: f.run.runId,
      attempt: 1,
      question: "Retention?",
      recommendation: "One day",
      revisedExplanation: {
        text: "Add retention",
        scope: ["Retention"],
        criteria: ["Expires"],
      },
    };
    await tool.execute(input, f.context);
    const previous = required(
      (await f.store.getRun(f.run.runId))?.planning?.pending,
    );
    const { git } = await import("../helpers/project.js");
    await git("git", [
      "-C",
      f.project.directory,
      "commit",
      "--allow-empty",
      "-m",
      "supersede pending commit",
    ]);
    const result = JSON.parse(
      String((await tool.execute(input, f.context)).content),
    );
    expect(result.outcome).toBe("accepted");
    expect(result.requestId).not.toBe(previous.requestId);
    const after = required((await f.store.getRun(f.run.runId))?.planning);
    expect(after.approval?.sha).toBe(
      (
        await git("git", ["-C", f.project.directory, "rev-parse", "HEAD"])
      ).stdout.trim(),
    );
    expect(after.approval?.revision).toBe(previous.revision + 1);
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

for (const stage of ["prd", "issues"] as const) {
  test(`native ${stage} prose consumes three attempts, retains drafts and requires explicit budget reset`, async () => {
    const f =
      stage === "prd" ? await nativePrdFixture() : await nativeIssueFixture();
    try {
      const { supervisePlanning } = await import(
        "../../src/planning/generation.js"
      );
      const { eventually } = await import("../helpers/clock.js");
      f.host.tools.set("question", {
        ...required(f.host.tools.get("question")),
        async execute() {
          return { content: "", metadata: {} };
        },
      });
      if (stage === "prd") await f.write("partial draft");
      f.adapter.inspectPlanningTurn = async () => "settled";
      f.adapter.inspectSession = async () => "idle";
      f.adapter.requestUserInput = async () => ({
        ok: false,
        error: { code: "unsupported", message: "No native input" },
      });
      for (let i = 0; i < 3; i++)
        await eventually(async () => {
          await supervisePlanning(f.store, f.adapter, f.run.runId, i * 100);
          const state = (await f.store.getRun(f.run.runId))?.planning;
          return i === 2
            ? state?.pending?.kind === "planning-recovery"
            : state?.owner?.attempt === i + 2;
        });
      const state = required((await f.store.getRun(f.run.runId))?.planning);
      expect(state.attempts?.filter((a) => a.stage === stage)).toHaveLength(3);
      expect(state.owner?.retired).toBe(true);
      expect(state.pending?.kind).toBe("planning-recovery");
      expect(state.prd?.revision ?? 0).toBe(stage === "prd" ? 0 : 1);
      await expect(
        required(f.host.tools.get("ralph_write_planning_file")).execute(
          {
            runId: f.run.runId,
            attempt: 3,
            path: stage === "prd" ? "PRD.md" : "graph.json",
            content: "late",
          },
          {
            sessionID: state.sessionId,
            signal: new AbortController().signal,
          } as never,
        ),
      ).rejects.toThrow();
      if (stage === "prd")
        expect(
          await readFile(
            join(
              f.project.directory,
              `.ralph/features/${f.run.runId}/prd-draft-1/PRD.md`,
            ),
            "utf8",
          ),
        ).toBe("partial draft");
      await supervisePlanning(f.store, f.adapter, f.run.runId, 400);
      expect(
        (await f.store.getRun(f.run.runId))?.planning?.attempts,
      ).toHaveLength(state.attempts?.length ?? 0);
      f.adapter.requestUserInput = async (request) => {
        f.adapter.inspectSession = async () => "busy";
        return {
          ok: true,
          ...request,
          source: "user",
          messageId: "explicit-reset",
          text: "Reset budget and retry",
        };
      };
      await eventually(async () => {
        await supervisePlanning(f.store, f.adapter, f.run.runId, 500);
        return (
          (await f.store.getRun(f.run.runId))?.planning?.budgetResets?.at(-1)
            ?.answer.messageId === "explicit-reset"
        );
      });
      const waiting = required((await f.store.getRun(f.run.runId))?.planning);
      expect(waiting.owner?.attempt).toBe(3);
      expect(waiting.owner?.retired).toBe(true);
      f.adapter.inspectSession = async () => "idle";
      await eventually(async () => {
        await supervisePlanning(f.store, f.adapter, f.run.runId, 500);
        return (
          (await f.store.getRun(f.run.runId))?.planning?.owner?.attempt === 4
        );
      });
      const reset = required((await f.store.getRun(f.run.runId))?.planning);
      expect(reset.budgetResets?.at(-1)?.answer.messageId).toBe(
        "explicit-reset",
      );
      expect(reset.owner?.attempt).toBe(4);
      expect(reset.owner?.retired).toBeUndefined();
      if (stage === "prd") expect(reset.sessionId).toBe(state.sessionId);
    } finally {
      if ("cleanup" in f && typeof f.cleanup === "function") await f.cleanup();
      else {
        if (typeof f.dispose === "function") await f.dispose();
        await f.project.cleanup();
      }
    }
  });
}

test("native planning deadline suspends for product questions, direct native questions and pause", async () => {
  const f = await nativePrdFixture();
  try {
    const { supervisePlanning, setPlanningQuestionWaiting } = await import(
      "../../src/planning/generation.js"
    );
    const { handleControlCommand } = await import(
      "../../src/commands/control.js"
    );
    f.adapter.inspectPlanningTurn = async () => "running";
    f.adapter.inspectSession = async () => "idle";
    const initial = required(
      (await f.store.getRun(f.run.runId))?.planning?.attempts?.at(-1),
    );
    const { controllableClock } = await import("../helpers/clock.js");
    const timer = controllableClock();
    const now = () =>
      required(initial.observedAt) + required(timer.clock.now)();
    const store = await openRunStore(f.project.directory, { now });
    timer.advance(10);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    const remaining = initial.remainingMs - 110;
    let settle:
      | ((value: import("../../src/core/types.js").UserInputResult) => void)
      | undefined;
    f.adapter.requestUserInput = async () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    const { requestProductDecision } = await import(
      "../../src/planning/questions.js"
    );
    const work = requestProductDecision(
      store,
      f.adapter,
      {
        runId: f.run.runId,
        attempt: 1,
        question: "Which?",
        recommendation: "One",
      },
      required(f.run.planning).sessionId,
    );
    const { eventually } = await import("../helpers/clock.js");
    await eventually(() => !!settle);
    timer.advance(initial.remainingMs * 2);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    const pending = required(
      (await store.getRun(f.run.runId))?.planning?.pending,
    );
    settle?.({
      ok: true,
      ...pending,
      source: "user",
      messageId: "question-wait",
      text: "One",
    });
    await work;
    timer.advance(100);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    await setPlanningQuestionWaiting(
      store,
      f.run.runId,
      required(f.run.planning).sessionId,
      "native",
      true,
    );
    timer.advance(initial.remainingMs * 2);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    await setPlanningQuestionWaiting(
      store,
      f.run.runId,
      required(f.run.planning).sessionId,
      "native",
      false,
    );
    await handleControlCommand("ralph-pause", f.run.runId, store, f.adapter);
    timer.advance(initial.remainingMs * 2);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    await handleControlCommand("ralph-resume", f.run.runId, store, f.adapter);
    timer.advance(100);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    const state = required((await store.getRun(f.run.runId))?.planning);
    expect(state.attempts?.at(-1)?.remainingMs).toBe(remaining);
    expect(state.owner?.attempt).toBe(1);
    timer.advance(remaining + 1);
    await supervisePlanning(store, f.adapter, f.run.runId, now());
    expect((await store.getRun(f.run.runId))?.planning?.owner?.attempt).toBe(2);
    expect(
      (await store.getRun(f.run.runId))?.planning?.attempts?.[0]?.reason?.code,
    ).toBe("agent-timeout");
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

for (const control of [
  "ralph-stop",
  "ralph-pause",
  "stop-resume",
  "busy",
] as const) {
  test(`native retired planning cannot retry across ${control} during cancellation`, async () => {
    const f = await nativePrdFixture();
    try {
      const { supervisePlanning } = await import(
        "../../src/planning/generation.js"
      );
      const { handleControlCommand } = await import(
        "../../src/commands/control.js"
      );
      f.adapter.inspectPlanningTurn = async () => "failed";
      f.adapter.inspectSession = async () =>
        control === "busy" ? "busy" : "idle";
      const cancel = f.adapter.cancelJob.bind(f.adapter);
      let retired = false;
      f.adapter.cancelJob = async (job) => {
        retired = !!(await f.store.getRun(f.run.runId))?.planning?.owner
          ?.retired;
        const result = await cancel(job);
        if (control === "stop-resume") {
          await handleControlCommand(
            "ralph-stop",
            f.run.runId,
            f.store,
            f.adapter,
          );
          await handleControlCommand(
            "ralph-resume",
            f.run.runId,
            f.store,
            f.adapter,
          );
        } else if (control !== "busy")
          await handleControlCommand(control, f.run.runId, f.store, f.adapter);
        return result;
      };
      await supervisePlanning(f.store, f.adapter, f.run.runId);
      expect(retired).toBe(true);
      const state = required((await f.store.getRun(f.run.runId))?.planning);
      expect(state.owner?.attempt).toBe(1);
      expect(state.owner?.retired).toBe(true);
      expect(state.attempts).toHaveLength(1);
      await expect(f.complete()).rejects.toThrow();
      await expect(f.write("late draft")).rejects.toThrow();
    } finally {
      if (typeof f.dispose === "function") await f.dispose();
      await f.project.cleanup();
    }
  });
}

test("native accepted PRD and settled old turn never cancel or duplicate the issue handoff", async () => {
  const f = await nativePrdFixture();
  try {
    const { supervisePlanning } = await import(
      "../../src/planning/generation.js"
    );
    await f.write(f.text);
    const accepted = await f.complete();
    const before = required(await f.store.getRun(f.run.runId));
    const cancelled: string[] = [];
    f.adapter.cancelJob = async (job) => {
      cancelled.push(job.sessionId ?? "");
      return { ok: true };
    };
    f.adapter.inspectPlanningTurn = async (session) =>
      session === f.run.planning?.sessionId ? "settled" : "running";
    await supervisePlanning(f.store, f.adapter, f.run.runId);
    expect(await f.complete()).toEqual(accepted);
    expect(cancelled).toEqual([]);
    const after = required(await f.store.getRun(f.run.runId));
    expect(after.planning?.issueHandoff).toEqual(before.planning?.issueHandoff);
    expect(
      after.planning?.attempts?.filter((a) => a.stage === "issues"),
    ).toHaveLength(1);
    expect(after.planning?.attempts?.[0]?.status).toBe("accepted");
    expect(after.control?.status ?? "active").toBe("active");
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

test("native PRD retry corrects validation in place and completes from its retained interview session", async () => {
  const f = await nativePrdFixture();
  try {
    const { supervisePlanning } = await import(
      "../../src/planning/generation.js"
    );
    f.adapter.inspectPlanningTurn = async () => "failed";
    f.adapter.inspectSession = async () => "idle";
    await supervisePlanning(f.store, f.adapter, f.run.runId);
    const input = { ...f.input, attempt: 2 };
    const writer = required(f.host.tools.get("ralph_write_planning_file"));
    await writer.execute({ ...input, content: "Invalid draft" }, f.context);
    expect((await f.complete(input)).outcome).toBe("correctable-invalid");
    let state = required((await f.store.getRun(f.run.runId))?.planning);
    expect(state.owner?.attempt).toBe(2);
    expect(state.owner?.retired).toBeUndefined();
    expect(state.attempts).toHaveLength(2);
    await writer.execute({ ...input, content: f.text }, f.context);
    expect((await f.complete(input)).outcome).toBe("accepted");
    state = required((await f.store.getRun(f.run.runId))?.planning);
    expect(state.prdAcceptance?.sessionId).toBe(f.run.planning?.sessionId);
    expect(state.prdAcceptance?.attempt).toBe(2);
    expect(state.attempts?.filter((a) => a.stage === "prd")).toHaveLength(2);
    expect(state.attempts?.at(-1)?.stage).toBe("issues");
    expect(state.owner?.attempt).toBe(1);
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

test("native exhaustion keeps unavailable input pending and records an explicit Stop without resetting", async () => {
  const f = await nativePrdFixture();
  try {
    const { supervisePlanning } = await import(
      "../../src/planning/generation.js"
    );
    const { requestNativeInput } = await import(
      "../../src/opencode/native-input.js"
    );
    f.adapter.inspectPlanningTurn = async () => "settled";
    f.adapter.inspectSession = async () => "idle";
    let question = "";
    const native = required(f.host.tools.get("question"));
    f.host.tools.set("question", {
      ...native,
      async execute(input) {
        question = JSON.stringify(input);
        return { content: "", metadata: {} };
      },
    });
    f.adapter.requestUserInput = (request) =>
      requestNativeInput(f.host.context, request, new AbortController().signal);
    for (let i = 0; i < 3; i++)
      await supervisePlanning(f.store, f.adapter, f.run.runId);
    const pending = required(
      (await f.store.getRun(f.run.runId))?.planning?.pending,
    );
    expect(question).toContain("exhausted three");
    expect(question).toContain("Reset budget and retry");
    expect(pending.kind).toBe("planning-recovery");
    expect(
      (await f.store.getRun(f.run.runId))?.planning?.error?.message,
    ).toContain("Native recovery input unavailable");
    // A response for another request has no authority to reset this budget.
    f.adapter.requestUserInput = async (request) => ({
      ok: true,
      ...request,
      requestId: "stale-request",
      source: "user",
      messageId: "stale-reset",
      text: "Reset budget and retry",
    });
    await supervisePlanning(f.store, f.adapter, f.run.runId);
    expect(
      (await f.store.getRun(f.run.runId))?.planning?.budgetResets,
    ).toBeUndefined();
    const retained = required(
      (await f.store.getRun(f.run.runId))?.planning?.attempts?.at(-1)?.job,
    );
    expect(
      await f.store.recordIntent({
        ...retained,
        jobId: "retained-worker",
        role: "executor",
        sessionId: "retained-worker",
        attempt: 1,
      }),
    ).toBe(true);
    f.host.tools.set("question", {
      ...native,
      async execute() {
        return { content: "", metadata: { answers: [["Stop"]] } };
      },
    });
    f.adapter.requestUserInput = (request) =>
      requestNativeInput(f.host.context, request, new AbortController().signal);
    await supervisePlanning(f.store, f.adapter, f.run.runId);
    const stopped = required(await f.store.getRun(f.run.runId));
    expect(stopped.control?.status).toBe("stopped");
    expect(stopped.control?.facts).toEqual([]);
    expect(stopped.jobs["retained-worker"]?.result?.outcome).toBe("cancelled");
    expect(stopped.planning?.budgetResets).toBeUndefined();
    expect(stopped.planning?.attempts).toHaveLength(3);
  } finally {
    if (typeof f.dispose === "function") await f.dispose();
    await f.project.cleanup();
  }
});

test("public control and router resume retain the native issue owner without another question or handoff", async () => {
  const f = await nativeIssueFixture();
  try {
    const before = required(await f.store.getRun(f.run.runId));
    await f.store.createRun("later-command-verification");
    const prompts = f.fake.requests.filter((r) =>
      r.path.endsWith("/prompt"),
    ).length;
    f.host.tools.set("question", {
      id: "question",
      name: "question",
      description: "No new gate",
      input: {} as never,
      async execute() {
        throw new Error("Unexpected approval");
      },
    });
    const result = JSON.parse(
      String(
        (
          await required(f.host.tools.get("ralph_control")).execute(
            { action: "resume" },
            {
              sessionID: "main",
              signal: new AbortController().signal,
            } as never,
          )
        ).content,
      ),
    );
    expect(result.runId).toBe(f.run.runId);
    await f.router.dispatch("ralph-resume", f.run.runId, {
      workspace: f.project.directory,
      sessionId: "main",
    });
    const after = required(await f.store.getRun(f.run.runId));
    expect(after.planning?.owner).toEqual(before.planning?.owner);
    expect(after.planning?.issueHandoff).toEqual(before.planning?.issueHandoff);
    expect(after.planning?.approval).toEqual(before.planning?.approval);
    expect(after.planning?.phase).toBe("issue_generation");
    expect(
      f.fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(prompts);
  } finally {
    await f.cleanup();
  }
});
