import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [mode, file, ...args] = process.argv.slice(2);
if (mode === "record") {
  await writeFile(
    file ?? "missing-fixture-file",
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      env: process.env.FIXTURE_VALUE,
    }),
  );
  console.log(process.env.FIXTURE_VALUE ?? "recorded");
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  console.error("fixture check failed");
  process.exit(7);
} else if (mode === "service") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ready"),
  });
  const descendant = spawn(process.execPath, [import.meta.filename, "hang"], {
    stdio: "ignore",
  });
  await writeFile(
    file ?? "missing-fixture-file",
    JSON.stringify({
      url: server.url.href,
      pid: process.pid,
      descendant: descendant.pid,
    }),
  );
} else if (mode === "readiness") {
  try {
    const info = JSON.parse(
      await Bun.file(file ?? "missing-fixture-file").text(),
    );
    const response = await fetch(info.url);
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
} else if (mode === "cleanup") {
  await writeFile(file ?? "missing-fixture-file", "cleaned");
}
