import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  processIdentity,
  terminateOwnedProcess,
} from "../../src/process/ownership.js";
import { createTestProject } from "../helpers/project.js";

test.each([
  60000, 70000,
])("owned command completion preserves output or reports its bound for %i bytes", async (size) => {
  const project = await createTestProject();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const parent = await processIdentity(process.pid);
    if (!parent) throw new Error("Missing parent identity");
    child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../src/process/command-child.ts", import.meta.url),
        ),
        String(process.pid),
        parent.startedAt,
        "output-test",
        project.directory,
        "fixture",
        "",
        "bun",
        "-e",
        `process.stdout.write("héllo\\n"+"x".repeat(${size})+"\\nEND");process.stderr.write("warning\\nTAIL");`,
      ],
      {
        cwd: project.directory,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout?.resume();
    child.stderr?.resume();
    const receipt = await new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      child?.on("message", (m: unknown) => {
        const value = m as {
          type: string;
          code: number;
          stdout: string;
          stderr: string;
        };
        if (value.type === "exit") resolve(value);
      });
      child?.once("error", reject);
      child?.once("exit", () =>
        reject(new Error("Wrapper exited before receipt")),
      );
    });
    expect(receipt.code).toBe(0);
    expect(
      receipt.stdout ===
        (size > 65536
          ? "[output exceeded limit]"
          : `héllo\n${"x".repeat(size)}\nEND`),
    ).toBe(true);
    expect(receipt.stderr).toBe("warning\nTAIL");
  } finally {
    if (child?.pid) {
      const identity = await processIdentity(child.pid);
      if (identity)
        await terminateOwnedProcess({
          pid: child.pid,
          startedAt: identity.startedAt,
          ownerToken: "output-test",
          workspace: project.directory,
          repositoryId: "fixture",
        });
    }
    await project.cleanup();
  }
}, 15000);
