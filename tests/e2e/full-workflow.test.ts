import { expect, test } from "bun:test";
import { verifyPackage } from "../helpers/package.js";

test("installed setup-to-report workflow preserves verified versus skipped validation in two projects", async () => {
  const evidence = await verifyPackage(true);
  expect(evidence.repositories.map((repository) => repository.outcome)).toEqual(
    ["verified", "incomplete-validation"],
  );
  for (const repository of evidence.repositories) {
    expect(repository.stages).toEqual([
      "setup",
      "interview",
      "prd",
      "issues",
      "executor",
      "merger",
      "review",
      "report",
    ]);
  }
  console.log(
    `Packaged workflow: ${evidence.platform}, Bun ${evidence.bun}; complete deterministic workflow.`,
  );
}, 180_000);
