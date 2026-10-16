import { expect, test } from "bun:test";
import { join } from "node:path";
import { acquireHostLease } from "../../src/state/host-lease.js";
import { createTestProject } from "../helpers/project.js";

const module = new URL("../../src/state/host-lease.ts", import.meta.url)
  .pathname;
test("a new host recovers only after the previous host's birth identity is gone", async () => {
  const project = await createTestProject();
  const root = join(project.directory, ".git");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const {acquireHostLease}=await import(${JSON.stringify(module)}); const lease=await acquireHostLease(${JSON.stringify(root)}); await lease.ready(); console.log('ready'); setTimeout(()=>{},60000);`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    reader.releaseLock();
    await expect(acquireHostLease(root)).rejects.toThrow(
      "Another live OpenCode host",
    );
    child.kill();
    await child.exited;
    const lease = await acquireHostLease(root);
    expect(lease.recover).toBe(true);
    await lease.ready();
    const other = await acquireHostLease(root);
    expect(other.recover).toBe(false);
    expect(await lease.release()).toBe(false);
    expect(await other.release()).toBe(true);
    await other.finish();
    const fresh = await acquireHostLease(root);
    expect(fresh.recover).toBe(true);
    await fresh.release();
    await fresh.finish();
  } finally {
    child.kill();
    await child.exited;
    await project.cleanup();
  }
});
