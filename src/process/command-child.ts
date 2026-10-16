import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { processIdentity } from "./ownership.js";

const [
  parentPid,
  parentStart,
  _token,
  workspace,
  _repository,
  shell,
  executable,
  ...args
] = process.argv.slice(2);
if (!parentPid || !parentStart || !workspace || !executable) process.exit(1);
// Keep the owner alive after command exit so descendants remain in an owned group
// until the parent has collected the result and terminated the whole lease.
const child = spawn(executable, args, {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe"],
  ...(shell ? { shell } : {}),
});
function capture(stream: NodeJS.ReadableStream | null) {
  const decoder = new StringDecoder("utf8");
  let text = "",
    bytes = 0,
    overflow = false;
  stream?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 65536) {
      overflow = true;
      text = "";
      return;
    }
    if (!overflow) text += decoder.write(chunk);
  });
  return () => (overflow ? "[output exceeded limit]" : text + decoder.end());
}
// IPC and pipe delivery have no shared ordering. The final receipt carries the
// bounded command output so completion cannot race its last stdout/stderr bytes.
const stdout = capture(child.stdout);
const stderr = capture(child.stderr);
child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
child.once("spawn", () => process.send?.({ type: "started" }));
child.once("error", (error: NodeJS.ErrnoException) =>
  process.send?.({ type: "error", code: error.code, message: error.message }),
);
child.once("close", (code, signal) =>
  process.send?.({
    type: "exit",
    code,
    signal,
    stdout: stdout(),
    stderr: stderr(),
  }),
);
process.on("SIGTERM", () => {
  // The parent signals the group first. Escalate stubborn descendants while
  // this wrapper still proves ownership of that group.
  if (process.platform !== "win32")
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 100);
});
let inspecting = false;
setInterval(async () => {
  if (inspecting) return;
  inspecting = true;
  try {
    const parent = await processIdentity(Number(parentPid));
    if (!parent || parent.startedAt !== parentStart) {
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else process.kill(-process.pid, "SIGKILL");
    }
  } catch {
    /* Retain ownership on ambiguous inspection. */
  } finally {
    inspecting = false;
  }
}, 250);
