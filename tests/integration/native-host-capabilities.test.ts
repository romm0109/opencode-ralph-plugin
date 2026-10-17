import { expect, test } from "bun:test";
import { createOpenCodeAdapter } from "../../src/opencode/adapter.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createFakeOpenCode } from "../helpers/fake-opencode.js";
import { createTestProject } from "../helpers/project.js";

test("native plugin session capabilities reconcile deterministic issue sessions without list or inbox", async () => {
  const project = await createTestProject();
  try {
    const fake = createFakeOpenCode();
    const sessions = new Map<
      string,
      Awaited<ReturnType<typeof fake.client.session.get>>
    >();
    const {
      list: _list,
      inbox: _inbox,
      ...nativeSession
    } = fake.client.session;
    const adapter = createOpenCodeAdapter(
      {
        ...fake.client,
        session: {
          ...nativeSession,
          async create(input) {
            const session = await fake.client.session.create(input);
            sessions.set(session.id, {
              ...session,
              ...(input?.metadata ? { metadata: input.metadata } : {}),
            });
            return session;
          },
          async get({ sessionID }) {
            const session = sessions.get(sessionID);
            if (!session) throw { _tag: "Session.NotFoundError", sessionID };
            return session;
          },
        },
      },
      await openRunStore(project.directory),
    );
    expect(
      await adapter.findIssueSession?.(project.directory, "run", "job", 1),
    ).toBeUndefined();
    const id = await adapter.createIssueSession?.(
      project.directory,
      "run",
      "job",
      1,
      { providerID: "fixture", modelID: "model" },
    );
    if (!id) throw new Error("Issue session was not created");
    expect(
      await adapter.findIssueSession?.(project.directory, "run", "job", 1),
    ).toBe(id);
    await adapter.queueStagePrompt?.(
      id,
      "msg_ralph-issues-test",
      "Issue planning",
    );
    await adapter.queueStagePrompt?.(
      id,
      "msg_ralph-issues-test",
      "Issue planning",
    );
    expect(
      fake.requests.filter((r) => r.path.endsWith("/prompt")),
    ).toHaveLength(1);
    expect(
      await adapter.inspectStagePrompt?.(
        id,
        "msg_ralph-issues-test",
        "Issue planning",
      ),
    ).toBe("present");
    expect(
      await adapter.inspectStagePrompt?.(
        id,
        "msg_ralph-issues-test",
        "Changed content",
      ),
    ).toBe("unknown");
    const saved = sessions.get(id);
    if (!saved) throw new Error("Missing created session");
    saved.metadata = {
      ralph: { runId: "other", jobId: "job", attempt: 1 },
    };
    await expect(
      adapter.findIssueSession?.(project.directory, "run", "job", 1),
    ).rejects.toThrow("metadata");
  } finally {
    await project.cleanup();
  }
});
