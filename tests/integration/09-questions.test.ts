import { expect, test } from "bun:test";
import type {
  UserInputRequest,
  UserInputResult,
} from "../../src/core/types.js";
import { controllableClock } from "../helpers/clock.js";
import { diamondFixture, until } from "../helpers/diamond.js";
import { required } from "../helpers/single-issue.js";

test("B waits without a deadline or retry while C and E integrate, then resumes the same task", async () => {
  const f = await diamondFixture();
  const time = controllableClock();
  let request: UserInputRequest | undefined;
  let answer: ((value: UserInputResult) => void) | undefined;
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  let questioned = false;
  f.adapter.dispatchJob = async (job) => {
    if (job.role === "executor" && job.issueId === "B" && !questioned) {
      questioned = true;
      f.fake.respond(
        JSON.stringify({
          kind: "needs_input",
          question: "Which value?",
          recommendedAnswer: "Use one",
          affectedRequirement: "B returns a value",
        }),
      );
      const { createOpenCodeAdapter } = await import(
        "../../src/opencode/adapter.js"
      );
      return createOpenCodeAdapter(f.fake.client, f.store).dispatchJob(job);
    }
    return dispatch(job);
  };
  f.adapter.requestUserInput = async (input) => {
    request = input;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  try {
    await f.router.scheduleIssues(f.runId, { clock: time.clock });
    await until(() => !!request);
    let run = required(await f.store.getRun(f.runId));
    expect(run.issueAttempts?.B?.status).toBe("waiting");
    expect(run.issueAttempts?.B?.executionResult?.outcome).toBe("needs_input");
    expect(run.issueAttempts?.C?.status).toBe("integrated");
    expect(run.issueAttempts?.E?.status).toBe("integrated");
    expect(run.execution?.issues.find((i) => i.id === "D")?.status).toBe(
      "blocked",
    );
    expect(time.pending).toBe(0);
    time.advance(3600000);
    expect((await f.store.getRun(f.runId))?.issueAttempts?.B?.attempt).toBe(1);
    answer?.({
      ok: true,
      ...required(request),
      source: "user",
      messageId: "answer-B",
      text: "Use one",
    });
    await until(
      async () =>
        (await f.store.getRun(f.runId))?.issueAttempts?.D?.status ===
        "integrated",
    );
    run = required(await f.store.getRun(f.runId));
    expect(run.issueAttempts?.B?.attempt).toBe(1);
    expect(run.issueAttempts?.B?.history).toEqual([]);
    expect(f.jobs.find((j) => j.issueId === "B")?.prompt).toContain("Use one");
    expect(f.fake.requests.some((r) => r.path.endsWith("publishStatus"))).toBe(
      true,
    );
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("unrelated-session, superseded and duplicate answers cannot resume an executor", async () => {
  const f = await diamondFixture();
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  let request: UserInputRequest | undefined;
  f.adapter.requestUserInput = async (input) => {
    request = input;
    return {
      ok: false,
      error: { code: "unsupported", message: "Pending human input" },
    };
  };
  f.adapter.dispatchJob = async (job) => {
    if (job.role === "executor") {
      f.fake.respond(
        JSON.stringify({
          kind: "needs_input",
          question: "Which value?",
          recommendedAnswer: "one",
          affectedRequirement: "value",
        }),
      );
      const { createOpenCodeAdapter } = await import(
        "../../src/opencode/adapter.js"
      );
      return createOpenCodeAdapter(f.fake.client, f.store).dispatchJob(job);
    }
    return dispatch(job);
  };
  try {
    await f.router.executeIssue(f.runId, "A");
    await until(() => !!request);
    const response = {
      ok: true as const,
      ...required(request),
      source: "user" as const,
      messageId: "human-answer",
      text: "one",
    };
    expect(
      await f.router.answerExecutorQuestion(f.runId, "A", {
        ...response,
        sessionId: "unrelated",
      }),
    ).toBe(false);
    expect(
      await f.router.answerExecutorQuestion(f.runId, "A", {
        ...response,
        requestId: "superseded",
      }),
    ).toBe(false);
    expect(await f.router.answerExecutorQuestion(f.runId, "E", response)).toBe(
      false,
    );
    expect((await f.store.getRun(f.runId))?.issueAttempts?.A?.status).toBe(
      "waiting",
    );
    expect(await f.router.answerExecutorQuestion(f.runId, "A", response)).toBe(
      true,
    );
    expect(await f.router.answerExecutorQuestion(f.runId, "A", response)).toBe(
      false,
    );
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("a changed acceptance criterion requires native scope authorization and regenerated artifacts while retaining integrated work", async () => {
  const f = await diamondFixture();
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  let request: UserInputRequest | undefined;
  let questioned = false;
  f.adapter.requestUserInput = async (input) => {
    request = input;
    return { ok: false, error: { code: "unsupported", message: "pending" } };
  };
  f.adapter.dispatchJob = async (job) => {
    if (job.role === "executor" && job.issueId === "B" && !questioned) {
      questioned = true;
      f.fake.respond(
        JSON.stringify({
          kind: "needs_input",
          question: "Which value?",
          recommendedAnswer: "one",
          affectedRequirement: "B acceptance",
        }),
      );
      const { createOpenCodeAdapter } = await import(
        "../../src/opencode/adapter.js"
      );
      return createOpenCodeAdapter(f.fake.client, f.store).dispatchJob(job);
    }
    return dispatch(job);
  };
  try {
    await f.router.scheduleIssues(f.runId);
    await until(() => !!request);
    const before = required(await f.store.getRun(f.runId));
    const state = required(before.planning);
    const graph = structuredClone(required(state.graph));
    required(
      graph.value.issues.find((i) => i.id === "B"),
    ).acceptanceCriteria.push("Uses the clarified value one");
    const response = {
      ok: true as const,
      ...required(request),
      source: "user" as const,
      messageId: "scope-answer",
      text: JSON.stringify({
        kind: "revise_scope",
        explanation: {
          text: "Build diamond using the clarified value one",
          scope: ["Diamond"],
          criteria: ["Uses the clarified value one"],
        },
        prd: "Add one",
        graph: graph.value,
        files: graph.files,
      }),
    };
    expect(await f.router.answerExecutorQuestion(f.runId, "B", response)).toBe(
      true,
    );
    let run = required(await f.store.getRun(f.runId));
    expect(run.planning?.phase).toBe("execution_approval");
    expect(run.planning?.executionEligibility).toBeUndefined();
    expect(run.issueAttempts?.B?.status).toBe("waiting");
    expect(run.issueAttempts?.C?.integratedCommit).toBe(
      before.issueAttempts?.C?.integratedCommit,
    );
    await expect(f.router.scheduleIssues(f.runId)).rejects.toThrow(
      "approved graph",
    );
    f.adapter.requestUserInput = async (input) => ({
      ok: true,
      ...input,
      source: "user",
      messageId: "new-approval",
      text: required(input.options?.[0]).label,
    });
    await f.router.continuePlanning(f.runId);
    run = required(await f.store.getRun(f.runId));
    expect(run.issueAttempts?.B?.attempt).toBe(1);
    expect(run.issueAttempts?.B?.status).toBe("waiting");
    expect(run.issueAttempts?.C?.integratedCommit).toBe(
      before.issueAttempts?.C?.integratedCommit,
    );
    expect(run.issueAttempts?.C?.attempt).toBe(
      before.issueAttempts?.C?.attempt,
    );
    expect(run.issueAttempts?.E?.integratedCommit).toBe(
      before.issueAttempts?.E?.integratedCommit,
    );
    expect(run.planning?.phase).toBe("prd_generation");
    expect(run.planning?.executionEligibility).toBeUndefined();
    expect(run.planning?.graph).toBeUndefined();
    expect(run.planning?.prd).toBeUndefined();
    expect(run.planning?.approval?.hash).toBe(run.planning?.explanation?.hash);
    expect(run.planning?.scopeChange?.previousGraph.hash).toBe(
      state.graph?.hash,
    );
  } finally {
    await f.project.cleanup();
  }
}, 90000);

test("successive questions supersede prior answers and preserve the remaining active-time deadline", async () => {
  const f = await diamondFixture();
  const time = controllableClock();
  const requests: UserInputRequest[] = [];
  const dispatch = f.adapter.dispatchJob.bind(f.adapter);
  let questions = 0;
  f.adapter.requestUserInput = async (input) => {
    requests.push(input);
    return { ok: false, error: { code: "unsupported", message: "pending" } };
  };
  f.adapter.dispatchJob = async (job) => {
    if (job.role === "executor" && job.issueId === "A" && questions++ < 2) {
      time.advance(5000);
      f.fake.respond(
        JSON.stringify({
          kind: "needs_input",
          question: `Question ${questions}?`,
          recommendedAnswer: "one",
          affectedRequirement: "A value",
        }),
      );
      const { createOpenCodeAdapter } = await import(
        "../../src/opencode/adapter.js"
      );
      return createOpenCodeAdapter(f.fake.client, f.store).dispatchJob(job);
    }
    return dispatch(job);
  };
  try {
    await f.router.executeIssue(f.runId, "A", { clock: time.clock });
    await until(() => requests.length === 1);
    const first = {
      ok: true as const,
      ...required(requests[0]),
      source: "user" as const,
      messageId: "first",
      text: "one",
    };
    expect(await f.router.answerExecutorQuestion(f.runId, "A", first)).toBe(
      true,
    );
    time.advance(3600000);
    await f.router.executeIssue(f.runId, "A", { clock: time.clock });
    await until(() => requests.length === 2);
    expect(
      await f.router.answerExecutorQuestion(f.runId, "A", {
        ...first,
        messageId: "late-first",
      }),
    ).toBe(false);
    const attempt = required((await f.store.getRun(f.runId))?.issueAttempts?.A);
    expect(attempt.remainingAgentMs).toBe(20000);
    expect(attempt.attempt).toBe(1);
    expect(time.pending).toBe(0);
    expect(
      await f.router.answerExecutorQuestion(f.runId, "A", {
        ok: true,
        ...required(requests[1]),
        source: "user",
        messageId: "second",
        text: "one",
      }),
    ).toBe(true);
    const integrated = await f.router.executeIssue(f.runId, "A", {
      clock: time.clock,
    });
    expect(integrated.status).toBe("integrated");
    expect(integrated.attempt).toBe(1);
  } finally {
    await f.project.cleanup();
  }
}, 90000);
