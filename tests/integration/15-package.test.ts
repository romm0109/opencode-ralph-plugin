import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("the distributable has no dependency on a developer-local copy of itself", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  expect(manifest.dependencies[manifest.name]).toBeUndefined();
  for (const version of Object.values(manifest.dependencies)) {
    expect(version).not.toMatch(/^(?:file:|\/|[A-Za-z]:)/);
  }
});

test("a tarball loads in two repositories with bundled assets and isolated state", async () => {
  const { verifyPackage } = await import("../helpers/package.js");
  await mkdir(resolve("dist"), { recursive: true });
  await writeFile(
    resolve("dist/runtime-token-canary.log"),
    "packaging canary; not a credential",
  );
  const result = await verifyPackage(true);
  expect(result.repositories.map((repository) => repository.outcome)).toEqual([
    "verified",
    "incomplete-validation",
  ]);
  for (const repository of result.repositories)
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
  expect(result.repositories).toHaveLength(2);
  expect(result.repositories[0]?.root).not.toBe(result.repositories[1]?.root);
  expect(result.repositories[0]?.port).not.toBe(result.repositories[1]?.port);
}, 180_000);

test("recovery notifications are deferred until v2 plugin activation finishes", async () => {
  const { RalphPlugin } = await import("../../src/plugin.js");
  const { openRunStore } = await import("../../src/state/run-store.js");
  const { createFakePluginContext } = await import(
    "../helpers/fake-opencode.js"
  );
  const { createTestProject } = await import("../helpers/project.js");
  const project = await createTestProject();
  const store = await openRunStore(project.directory);
  await store.createRun("recover");
  const host = createFakePluginContext(project.directory);
  const dispose = await RalphPlugin.setup(host.context);
  try {
    expect(host.statuses).toHaveLength(0);
    for (let i = 0; i < 100 && !host.statuses.length; i++) await Bun.sleep(5);
    expect(host.statuses).toHaveLength(1);
  } finally {
    await dispose?.();
    await project.cleanup();
  }
}, 15_000);
