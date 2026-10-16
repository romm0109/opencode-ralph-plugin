import { expect, test } from "bun:test";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeIssue } from "../../src/execution/execute-issue.js";
import { integrateIssue } from "../../src/execution/integrate-issue.js";
import { gitOutput } from "../../src/git/worktrees.js";
import {
  singleIssueFixture as fixture,
  required,
} from "../helpers/single-issue.js";

test("approved issue uses separate sessions, validates exact commit and cleans owned worktrees", async () => {
  const f = await fixture();
  try {
    const submission = await executeIssue(f.store, f.adapter, f.runId, "A");
    expect(submission.status).toBe("submitted");
    const integrated = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(integrated.status).toBe("integrated");
    expect(integrated.validation?.candidateCommit).toBe(
      required(integrated.integratedCommit),
    );
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      required(integrated.integratedCommit),
    );
    expect(
      (await gitOutput(f.project.directory, ["rev-parse", "HEAD"])).trim(),
    ).toBe(f.project.commit);
    expect(integrated.mergerSessionId).not.toBe(
      submission.submission?.sessionId,
    );
    await expect(access(submission.job.workspace)).rejects.toThrow();
    await expect(
      access(required(integrated.candidate).job.workspace),
    ).rejects.toThrow();
    expect(
      (await f.store.getRun(f.runId))?.issueAttempts?.A?.submission?.tdd.cycles,
    ).toHaveLength(1);
  } finally {
    await f.project.cleanup();
  }
});

test("candidate mutation after check completion cannot advance integration", async () => {
  const f = await fixture();
  try {
    await executeIssue(f.store, f.adapter, f.runId, "A");
    const record = f.store.recordOperation.bind(f.store);
    f.store.recordOperation = async (operation) => {
      const accepted = await record(operation);
      if (
        operation.kind === "integration.advance" &&
        operation.status === "intent"
      ) {
        await writeFile(
          join(operation.job.workspace, "behavior.ts"),
          "export const addOne=(n:number)=>n;",
        );
        await gitOutput(operation.job.workspace, [
          "commit",
          "-am",
          "Changed after validation",
        ]);
      }
      return accepted;
    };
    const result = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("failed");
    expect(result.validation?.status).toBe("passed");
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      f.project.commit,
    );
  } finally {
    await f.project.cleanup();
  }
});

test("rejected submission identity retains its worktree and failure evidence", async () => {
  const f = await fixture();
  try {
    f.setMode("identity");
    const result = await executeIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("identity mismatch");
    await access(result.job.workspace);
    expect(
      (await f.store.getRun(f.runId))?.issueAttempts?.A?.error,
    ).toBeDefined();
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      f.project.commit,
    );
    expect(
      f.fake.requests.filter((request) => request.path === "/api/session")
        .length,
    ).toBe(1);
  } finally {
    await f.project.cleanup();
  }
});

test("behavior conflicts return structured repair feedback and retain both worktrees", async () => {
  const f = await fixture();
  try {
    const submission = await executeIssue(f.store, f.adapter, f.runId, "A");
    f.setMode("conflict");
    const result = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("failed");
    expect(result.feedback).toBe("Choose behavior for addOne");
    await access(submission.job.workspace);
    await access(required(result.candidate).job.workspace);
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      f.project.commit,
    );
  } finally {
    await f.project.cleanup();
  }
});

test("failed candidate checks preserve integration HEAD and retained diagnostics", async () => {
  const f = await fixture();
  try {
    await executeIssue(f.store, f.adapter, f.runId, "A");
    f.setMode("validation");
    const result = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("failed");
    expect(result.validation?.status).toBe("failed");
    expect(result.validation?.checks[0]?.result?.exitCode).toBe(1);
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      f.project.commit,
    );
    await access(required(result.candidate).job.workspace);
  } finally {
    await f.project.cleanup();
  }
});

test("a moved integration HEAD rebuilds and revalidates in a fresh merger session", async () => {
  const f = await fixture();
  try {
    await executeIssue(f.store, f.adapter, f.runId, "A");
    let validations = 0;
    let newer = "";
    f.adapter.authorizeCommand = async () => {
      if (++validations === 1) {
        await writeFile(
          join(f.workspace, "parallel.txt"),
          "Another integrated issue\n",
        );
        await gitOutput(f.workspace, ["add", "parallel.txt"]);
        await gitOutput(f.workspace, [
          "commit",
          "-m",
          "Independent integration",
        ]);
        newer = (await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim();
      }
      return { ok: true };
    };
    const result = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("integrated");
    expect(validations).toBe(2);
    expect(result.candidate?.job.baseCommit).toBe(newer);
    expect(result.validation?.candidateCommit).toBe(
      required(result.integratedCommit),
    );
    expect(
      f.fake.requests.filter((request) => request.path === "/api/session")
        .length,
    ).toBe(3);
    await access(join(f.workspace, "parallel.txt"));
    const candidates = Object.values(
      required(await f.store.getRun(f.runId)).operations,
    ).filter((op) => op.kind === "candidate.workspace");
    expect(candidates).toHaveLength(2);
    await access(required(candidates[0]).job.workspace); // stale evidence remains inspectable
  } finally {
    await f.project.cleanup();
  }
});

test("cleanup failure retains accepted integration and leaves changed work inspectable", async () => {
  const f = await fixture();
  try {
    const submission = await executeIssue(f.store, f.adapter, f.runId, "A");
    const record = f.store.recordIssueAttempt.bind(f.store);
    let dirtied = false;
    f.store.recordIssueAttempt = async (runId, revision, attempt) => {
      const accepted = await record(runId, revision, attempt);
      if (accepted && attempt.status === "integrated" && !dirtied) {
        dirtied = true;
        await writeFile(
          join(submission.job.workspace, "keep.txt"),
          "Do not force remove\n",
        );
      }
      return accepted;
    };
    const result = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("integrated");
    expect(result.cleanupErrors).toHaveLength(1);
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      required(result.integratedCommit),
    );
    await access(join(submission.job.workspace, "keep.txt"));
    expect(
      (await f.store.getRun(f.runId))?.issueAttempts?.A?.cleanupErrors,
    ).toHaveLength(1);
    await expect(
      access(required(result.candidate).job.workspace),
    ).rejects.toThrow();
  } finally {
    await f.project.cleanup();
  }
});

test("a baseline from an older approval cannot dispatch an executor", async () => {
  const f = await fixture();
  try {
    const run = await f.store.getRun(f.runId);
    await f.store.recordBaseline(
      f.runId,
      required(run).revision,
      {
        ...required(required(run).baseline),
        approvalRequestId: "older-approval",
      },
      [],
    );
    await expect(
      executeIssue(f.store, f.adapter, f.runId, "A"),
    ).rejects.toThrow("baseline");
    expect(f.fake.requests).toHaveLength(0);
  } finally {
    await f.project.cleanup();
  }
});

test("stopping after integration intent ignores the late completion", async () => {
  const f = await fixture();
  try {
    await executeIssue(f.store, f.adapter, f.runId, "A");
    const record = f.store.recordOperation.bind(f.store);
    f.store.recordOperation = async (operation) => {
      const accepted = await record(operation);
      if (
        operation.kind === "integration.advance" &&
        operation.status === "intent"
      )
        await f.store.recordControl(f.runId, {
          status: "stopped",
          source: "human",
        });
      return accepted;
    };
    const result = await integrateIssue(f.store, f.adapter, f.runId, "A");
    expect(result.status).toBe("failed");
    expect((await gitOutput(f.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
      f.project.commit,
    );
    await access(result.job.workspace);
  } finally {
    await f.project.cleanup();
  }
});
