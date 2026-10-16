import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createCommandRouter } from "../../src/commands/router.js";
import { projectRunSnapshot } from "../../src/dashboard/projections.js";
import { startDashboard } from "../../src/dashboard/server.js";
import { coordinateReviewRound } from "../../src/review/coordinator.js";
import { openRunStore } from "../../src/state/run-store.js";
import { createTestProject, git } from "../helpers/project.js";

for (const outcome of [
  "verified",
  "unverified",
  "unresolved",
  "incomplete-validation",
] as const) {
  test(`browser report matches persisted ${outcome} report and chat status`, async ({
    page,
  }) => {
    const project = await createTestProject();
    const store = await openRunStore(project.directory);
    const dashboard = await startDashboard(store, { pollIntervalMs: 50 });
    try {
      const graph = { revision: "g1", issues: [{ id: "a" }] };
      await writeFile(
        join(project.directory, "PRD.md"),
        "# Acceptance\n- [ ] UI works\n",
      );
      await writeFile(
        join(project.directory, "graph.json"),
        JSON.stringify(graph),
      );
      await git("git", ["-C", project.directory, "add", "."]);
      await git("git", ["-C", project.directory, "commit", "-m", "feature"]);
      const commit = (
        await git("git", ["-C", project.directory, "rev-parse", "HEAD"])
      ).stdout.trim();
      const run = await store.createRun("r");
      await store.recordExecution("r", run.revision, {
        verification: "passed",
        issues: [
          {
            id: "a",
            title: "UI",
            dependencies: [],
            status: "integrated",
            blockers: [],
          },
        ],
        integrationQueue: [],
        checks: [
          {
            id: "tests",
            status: outcome === "incomplete-validation" ? "skipped" : "passed",
            reason: "timeout",
            attempt: 1,
            commandRevision: 1,
            candidateCommit: commit,
          },
        ],
      });
      const report = await coordinateReviewRound({
        store,
        directory: project.directory,
        runId: "r",
        commit,
        baseCommit: project.commit,
        graph,
        prdRevision: "p1",
        evidenceRefs: ["tests"],
        reviewers: {
          code: async (s) => ({
            role: "code-review",
            reviewedCommit: s.commit,
            round: s.round,
            outcome: outcome === "unresolved" ? "findings" : "passed",
            evidenceRefs: ["tests"],
            findings:
              outcome === "unresolved"
                ? [
                    {
                      id: "code-bug",
                      reviewerRole: "code-review",
                      reviewedCommit: s.commit,
                      category: "correctness",
                      blocking: true,
                      criterion: "UI works",
                      evidence: ["PRD.md:2"],
                      suggestedRepair: "Fix behavior",
                      disposition: "open",
                    },
                  ]
                : [],
          }),
          functional: async (s) => ({
            role: "functional-review",
            reviewedCommit: s.commit,
            round: s.round,
            outcome: outcome === "unverified" ? "unverified" : "passed",
            findings: [],
            evidenceRefs: ["observed"],
            evidence: [],
            criteria: [
              {
                id: "ac",
                criterion: "UI works",
                coverage: ["browser"],
                status: outcome === "unverified" ? "unverified" : "pass",
                reason:
                  outcome === "unverified"
                    ? "Browser unavailable"
                    : "Observed UI",
                evidenceRefs: ["observed"],
              },
            ],
            attempts: [{ attempt: 1, evidenceRefs: ["observed"] }],
          }),
        },
      });
      const state = await store.getRun("r");
      if (!state) throw new Error("Missing persisted report");
      expect(projectRunSnapshot(state).completion?.outcome).toBe(
        report.outcome,
      );
      expect(
        JSON.parse(await createCommandRouter(store).status("r")).reviewWorkflow
          .report,
      ).toEqual(report);
      await page.goto(dashboard.url);
      const region = page.getByRole("region", { name: "Review report" });
      await expect(
        region.getByText(`Outcome: ${report.outcome}`),
      ).toBeVisible();
      await expect(
        region.getByRole("heading", { name: "Review round 1" }),
      ).toBeVisible();
      await expect(
        region.getByText(
          `Feature branch: ${report.branch} · Commit: ${report.commit}`,
        ),
      ).toBeVisible();
      if (outcome === "unresolved")
        await expect(
          region.getByText(/code-bug · code-review · blocking · open/),
        ).toBeVisible();
      if (outcome === "unverified")
        await expect(
          region.getByText(/Unavailable review:.*missing verification/),
        ).toBeVisible();
      if (outcome === "incomplete-validation")
        await expect(
          region.getByText("Skipped checks: tests: timeout"),
        ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /repair|retry|merge|publish/i }),
      ).toHaveCount(0);
    } finally {
      await dashboard.stop();
      await project.cleanup();
    }
  });
}
