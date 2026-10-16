import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleControlCommand } from "../../src/commands/control.js";
import { createCommandRouter } from "../../src/commands/router.js";
import { executeIssue } from "../../src/execution/execute-issue.js";
import { integrateIssue } from "../../src/execution/integrate-issue.js";
import { reconcileReadiness } from "../../src/execution/readiness.js";
import { coordinateReviewRound } from "../../src/review/coordinator.js";
import { retryUnverifiedReview } from "../../src/review/retry.js";
import { required, singleIssueFixture } from "../helpers/single-issue.js";

test("explicit review retry preserves the failed round, frozen commit and issue budget", async () => {
  const f = await singleIssueFixture();
  try {
    await executeIssue(f.store, f.adapter, f.runId, "A");
    const integrated = await integrateIssue(f.store, f.adapter, f.runId, "A");
    const integratedRun = required(await f.store.getRun(f.runId));
    await f.store.recordExecution(
      f.runId,
      integratedRun.revision,
      reconcileReadiness(integratedRun, []),
    );
    const planning = required((await f.store.getRun(f.runId))?.planning);
    const options = {
      store: f.store,
      directory: f.workspace,
      runId: f.runId,
      commit: required(integrated.integratedCommit),
      baseCommit: f.project.commit,
      prdRevision: required(planning.prd).hash,
      graph: {
        revision: required(planning.graph).hash,
        issues: required(planning.graph).value.issues,
      },
      evidenceRefs: ["integration:A"],
      approvedPlanning: true,
    };
    const report = await coordinateReviewRound({
      ...options,
      reviewers: {
        code: async (s) => ({
          role: "code-review",
          reviewedCommit: s.commit,
          round: s.round,
          outcome: "unverified",
          findings: [],
          evidenceRefs: [],
        }),
        functional: async (s) => ({
          role: "functional-review",
          reviewedCommit: s.commit,
          round: s.round,
          outcome: "unverified",
          findings: [],
          evidenceRefs: [],
          criteria: [],
          evidence: [],
          attempts: [{ attempt: 1, evidenceRefs: [] }],
        }),
      },
    });
    expect(report.outcome).toBe("unverified");
    await handleControlCommand("ralph-resume", f.runId, f.store, f.adapter);
    const previous = required(await f.store.getRun(f.runId));
    const lock = join(f.store.root, "active-run.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ runId: "other", repositoryId: f.store.repositoryId }),
    );
    let finalized = 0;
    f.adapter.finalizeExecution = async (snapshot) => {
      finalized++;
      const run = required(await f.store.getRun(f.runId));
      expect(snapshot.round).toBe(2);
      expect(snapshot.commit).toBe(report.commit);
      expect(run.reviewWorkflow?.rounds[0]?.code?.outcome).toBe("unverified");
      expect(run.reviewWorkflow?.rounds).toHaveLength(2);
      expect(run.review?.inputs.tddEvidence?.[0]?.tdd.cycles).toHaveLength(1);
    };
    await expect(
      retryUnverifiedReview(f.store, f.adapter, f.runId),
    ).rejects.toThrow("Another feature");
    expect((await f.store.getRun(f.runId))?.revision).toBe(previous.revision);
    await rm(lock, { recursive: true });
    await createCommandRouter(f.store, f.adapter).dispatch(
      "ralph-resume",
      `${f.runId} --review`,
    );
    const next = required(await f.store.getRun(f.runId));
    expect(finalized).toBe(1);
    expect(next.issueAttempts).toEqual(previous.issueAttempts);
    expect(next.reviewWorkflow?.ownerId).not.toBe(
      previous.reviewWorkflow?.ownerId,
    );
    expect(next.reviewWorkflow?.status).toBe("running");
    expect(
      JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).runId,
    ).toBe(f.runId);
    expect(
      (await f.store.events(f.runId)).some((e) =>
        JSON.stringify(e).includes('"outcome":"unverified"'),
      ),
    ).toBe(true);
    await expect(
      retryUnverifiedReview(f.store, f.adapter, f.runId),
    ).rejects.toThrow("Review-only retry");
  } finally {
    await f.project.cleanup();
  }
}, 30000);
