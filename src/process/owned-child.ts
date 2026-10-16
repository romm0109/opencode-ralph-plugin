import { execFile, spawn } from "node:child_process";
import { processIdentity } from "./ownership.js";

// The wrapper shares one process group with its children and watches its parent's birth identity.
const [
  parentPid,
  parentStart,
  _token,
  workspace,
  _repository,
  executable,
  ...args
] = process.argv.slice(2);
if (!parentPid || !parentStart || !workspace || !executable) process.exit(1);
const child = spawn(executable, args, { cwd: workspace, stdio: "ignore" });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], () =>
      process.exit(0),
    );
  } else {
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 250);
  }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", stop);
child.on("exit", stop);
let inspecting = false;
setInterval(async () => {
  if (inspecting) return;
  inspecting = true;
  try {
    const parent = await processIdentity(Number(parentPid));
    if (!parent || parent.startedAt !== parentStart) stop();
  } catch {
    stop();
  } finally {
    inspecting = false;
  }
}, 250);
