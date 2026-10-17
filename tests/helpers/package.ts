import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTestProject, git } from "./project.js";

export async function runFixtureCommand(argv: string[], cwd: string) {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" },
  });
  const timeout = setTimeout(() => proc.kill(), 120_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code)
      throw new Error(`Package fixture failed (${code}): ${stdout}\n${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}
export interface PackageEvidence {
  platform: string;
  bun: string;
  archiveSha256: string;
  repositories: {
    root: string;
    port: string;
    outcome?: string;
    stages?: string[];
    commandHash?: string;
  }[];
}
/** Installs the actual tarball; the child resolves every runtime import in that installation. */
export async function verifyPackage(
  fullWorkflow: boolean,
): Promise<PackageEvidence> {
  const root = resolve(import.meta.dir, "../..");
  const staging = await mkdtemp(join(tmpdir(), "ralph package with spaces "));
  const projects: Awaited<ReturnType<typeof createTestProject>>[] = [];
  try {
    await runFixtureCommand([process.execPath, "run", "build"], root);
    await runFixtureCommand(
      [process.execPath, "pm", "pack", "--destination", staging, "--quiet"],
      root,
    );
    const archives = (await readdir(staging)).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (archives.length !== 1) throw new Error("Expected exactly one tarball");
    for (const label of ["verified", "skipped"]) {
      const project = await createTestProject(`ralph ${label} project `);
      projects.push(project);
      await writeFile(
        join(project.directory, ".gitignore"),
        "node_modules/\n*.tgz\n",
      );
      await copyFile(
        join(staging, archives[0] as string),
        join(project.directory, "plugin.tgz"),
      );
      await writeFile(
        join(project.directory, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: {
            "opencode-ralph-plugin": "file:./plugin.tgz",
          },
        }),
      );
      await runFixtureCommand(
        [process.execPath, "install", "--ignore-scripts"],
        project.directory,
      );
      // Copy only the controllable HTTP fixture. Its adapter import resolves in the installed package.
      const fake = (
        await readFile(join(root, "tests/helpers/fake-opencode.ts"), "utf8")
      )
        .replace(
          "../../src/opencode/adapter.js",
          "opencode-ralph-plugin/adapter",
        )
        .replace("../../src/plugin.js", "opencode-ralph-plugin");
      await writeFile(join(project.directory, "fake-opencode.ts"), fake);
      await copyFile(
        join(root, "tests/helpers/packaged-workflow.ts"),
        join(project.directory, "packaged-workflow.ts"),
      );
      const plugin = await realpath(
        join(project.directory, "node_modules/opencode-ralph-plugin"),
      );
      await writeFile(
        join(project.directory, "opencode.json"),
        JSON.stringify({ plugins: [plugin] }),
      );
      await git("git", ["-C", project.directory, "add", "."]);
      await git("git", [
        "-C",
        project.directory,
        "commit",
        "-m",
        "isolated package installation",
      ]);
    }
    const runner = join(projects[0]?.directory as string, "probe.ts");
    await writeFile(
      runner,
      await readFile(join(root, "tests/helpers/packaged-probe.ts"), "utf8"),
    );
    const output = await runFixtureCommand(
      [
        process.execPath,
        runner,
        fullWorkflow ? "full" : "load",
        ...projects.map((project) => project.directory),
      ],
      projects[0]?.directory as string,
    );
    const line = output
      .split("\n")
      .find((value) => value.startsWith("PACKAGE_EVIDENCE="));
    if (!line) throw new Error("Installed probe produced no evidence");
    return {
      ...JSON.parse(line.slice("PACKAGE_EVIDENCE=".length)),
      archiveSha256: new Bun.CryptoHasher("sha256")
        .update(await readFile(join(staging, archives[0] as string)))
        .digest("hex"),
    };
  } finally {
    for (const project of projects) await project.cleanup();
    await rm(staging, { recursive: true, force: true });
  }
}
