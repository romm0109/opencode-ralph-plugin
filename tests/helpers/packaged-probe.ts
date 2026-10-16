// Executed after copying into a consumer repository; all runtime imports use its installation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageName = "opencode-ralph-plugin";
const full = process.argv[2] === "full";
const directories = process.argv.slice(3);
assert.equal(directories.length, 2);
const instances: Awaited<
  ReturnType<typeof import("../../src/plugin.js").RalphPlugin.setup>
>[] = [];
const evidence: {
  root: string;
  port: string;
  outcome?: string;
  stages?: string[];
  commandHash?: string;
}[] = [];
try {
  for (const [index, directory] of directories.entries()) {
    const installed = join(directory, "node_modules", packageName);
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    const loadExport = (subpath: string) => {
      const entry = manifest.exports[subpath]?.import;
      assert.equal(typeof entry, "string");
      return import(pathToFileURL(join(installed, entry)).href);
    };
    const { default: RalphPlugin } = (await loadExport(
      ".",
    )) as typeof import("../../src/plugin.js");
    const { default: tuiPlugin } = await loadExport("./tui");
    assert.equal(tuiPlugin.id, "ralph");
    assert.equal(typeof tuiPlugin.setup, "function");
    const { openRunStore } = (await loadExport(
      "./store",
    )) as typeof import("../../src/state/run-store.js");
    const { createCommandRouter } = (await loadExport(
      "./commands",
    )) as typeof import("../../src/commands/router.js");
    const { createOpenCodeAdapter } = (await loadExport(
      "./adapter",
    )) as typeof import("../../src/opencode/adapter.js");
    const { createFakeOpenCode, createFakePluginContext } = (await import(
      pathToFileURL(join(directory, "fake-opencode.ts")).href
    )) as typeof import("./fake-opencode.js");
    assert.equal(manifest.dependencies[packageName], undefined);
    for (const name of await readdir(installed)) {
      assert.ok(
        [
          "package.json",
          "dist",
          "docs",
          "skills",
          "README.md",
          "server.js",
          "tui.js",
        ].includes(name),
        `Unexpected package content: ${name}`,
      );
    }
    const runtimeFiles = await readdir(join(installed, "dist"), {
      recursive: true,
    });
    assert.ok(
      !runtimeFiles.some((file) =>
        /(?:\.log$|\.jsonl$|runtime-token|\.env)/.test(file),
      ),
      "Runtime output leaked into package",
    );
    for (const doc of [
      "README.md",
      "docs/opencode-compatibility.md",
      "docs/troubleshooting.md",
      "docs/package-validation.md",
    ]) {
      assert.ok((await readFile(join(installed, doc), "utf8")).length > 100);
    }
    for (const role of [
      "command-discovery",
      "grill-me",
      "create-prd",
      "to-issues",
      "tdd",
      "merge",
      "code-review",
      "functional-review",
    ]) {
      assert.ok(
        Buffer.byteLength(
          await readFile(join(installed, "skills", role, "SKILL.md"), "utf8"),
        ) >=
          ({ "grill-me": 600, "create-prd": 6800, "to-issues": 8000 }[role] ??
            100),
      );
    }
    const store = await openRunStore(directory);
    const fake = createFakeOpenCode();
    const host = createFakePluginContext(directory, fake.client);
    const dispose = await RalphPlugin.setup(host.context);
    instances.push(dispose);
    for (const command of [
      "ralph-status",
      "ralph-pause",
      "ralph-resume",
      "ralph-stop",
    ])
      assert.ok(host.commands.has(command));
    const status = JSON.parse(
      String(
        (await host.tools.get("ralph_status")?.execute({}, {} as never))
          ?.content,
      ),
    );
    const url = new URL(status.dashboardUrl);
    const html = await (await fetch(url.origin)).text();
    assert.ok(html.includes('<div id="root"'));
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset, url.origin))).status, 200);
    const adapter = createOpenCodeAdapter(fake.client, store);
    const router = createCommandRouter(store, adapter);
    // Exercise the shipped ownership wrapper, including argv boundaries and descendant cleanup.
    const { startOwnedProcess, terminateOwnedProcess, inspectOwnedProcess } =
      (await loadExport(
        "./process",
      )) as typeof import("../../src/process/ownership.js");
    await store.createRun("process-probe");
    const processJob = {
      runId: "process-probe",
      jobId: "app",
      role: "probe",
      attempt: 1,
      workspace: directory,
      baseCommit: "fixture",
      inputRevisions: {},
      prompt: "approved fixture process",
    };
    const appFile = join(store.root, "app with spaces.ts");
    const readyFile = join(store.root, "ready.json");
    await writeFile(
      appFile,
      `const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") }); await Bun.write(process.argv[2], JSON.stringify({ url: app.url.href, args: process.argv.slice(3) }));`,
    );
    const args = [
      "argument with spaces",
      '"quoted"',
      "$literal;&value",
      "日本語",
    ];
    const owned = await startOwnedProcess(store, processJob, process.execPath, [
      appFile,
      readyFile,
      ...args,
    ]);
    let ready: { url: string; args: string[] } | undefined;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          ready = JSON.parse(await readFile(readyFile, "utf8"));
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      assert.ok(ready, "Owned fixture failed readiness");
      assert.deepEqual(ready.args, args);
      assert.equal(await (await fetch(ready.url)).text(), "ready");
      assert.notEqual(new URL(ready.url).port, url.port);
    } finally {
      assert.equal(await terminateOwnedProcess(owned), true);
    }
    assert.equal((await inspectOwnedProcess(owned)).status, "gone");
    assert.ok(ready);
    await assert.rejects(fetch(ready.url));
    const target = (
      await exec("git", ["-C", directory, "rev-parse", "HEAD"])
    ).stdout.trim();
    const targetBranch = (
      await exec("git", ["-C", directory, "symbolic-ref", "HEAD"])
    ).stdout.trim();
    const runId = `repository-${index}`;
    const result = await router.runJob({
      runId,
      jobId: "probe",
      attempt: 1,
      role: "probe",
      workspace: directory,
      inputRevisions: {},
      baseCommit: target,
      prompt: "hello",
    });
    assert.equal(result.outcome, "completed");
    await router.dispatch("ralph-pause", runId);
    assert.equal((await store.getRun(runId))?.control?.status, "paused");
    await router.dispatch("ralph-resume", runId);
    evidence.push({ root: store.root, port: url.port });
    if (full) {
      const { exerciseWorkflow } = await import(
        pathToFileURL(join(directory, "packaged-workflow.ts")).href
      );
      const { run, stages } = await exerciseWorkflow(
        directory,
        store,
        adapter,
        router,
        createOpenCodeAdapter,
        !!index,
        host,
        fake,
      );
      const workflowId = run.runId;
      const featureDirectory = run.baseline.workspace;
      const commit = (
        await exec("git", ["-C", featureDirectory, "rev-parse", "HEAD"])
      ).stdout.trim();
      const report = run.reviewWorkflow?.report;
      assert.ok(
        report,
        "Installed completion must automatically produce dual review/report",
      );
      assert.equal(
        report.outcome,
        index ? "incomplete-validation" : "verified",
        JSON.stringify(report),
      );
      assert.equal(report.skippedChecks.length > 0, !!index);
      assert.notEqual(
        report.rounds[0]?.code?.sessionId,
        report.rounds[0]?.functional?.sessionId,
      );
      assert.deepEqual(
        JSON.parse(await router.status(workflowId)).reviewWorkflow.report,
        report,
      );
      assert.equal(report.commit, commit);
      const visible = () =>
        fake.requests.some(
          (request) =>
            request.path.endsWith("/synthetic") &&
            String(request.body.text).includes(report.outcome),
        );
      const progressDeadline = Date.now() + 5000;
      while (!visible() && Date.now() < progressDeadline) await Bun.sleep(25);
      assert.ok(
        visible(),
        "Final qualified result must be published to the host session",
      );
      assert.equal(
        host.stageSessions.length,
        2,
        JSON.stringify({ events: host.stageSessions, planning: run.planning }),
      );
      const row = evidence[index];
      assert.ok(row);
      row.outcome = report.outcome;
      row.stages = [...stages, "review", "report"];
      row.commandHash = run.planning.commandHash;
      assert.equal(
        (
          await exec("git", ["-C", directory, "rev-parse", `${targetBranch}~1`])
        ).stdout.trim(),
        target,
      );
      assert.equal(
        (await exec("git", ["-C", directory, "remote", "-v"])).stdout,
        "",
      );
    }
    const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const runs = (await (
      await fetch(`${url.origin}/api/runs`, { headers: auth })
    ).json()) as { runId: string }[];
    assert.deepEqual(
      runs.map((run) => run.runId).sort(),
      (await store.listRuns()).map((run) => run.runId).sort(),
    );
    assert.equal(await store.getRun(`repository-${1 - index}`), undefined);
  }
  assert.notEqual(evidence[0]?.root, evidence[1]?.root);
  assert.notEqual(evidence[0]?.port, evidence[1]?.port);
  if (full) assert.notEqual(evidence[0]?.commandHash, evidence[1]?.commandHash);
} finally {
  for (const dispose of instances) await dispose?.();
}
console.log(
  `PACKAGE_EVIDENCE=${JSON.stringify({ platform: process.platform, bun: Bun.version, repositories: evidence })}`,
);
