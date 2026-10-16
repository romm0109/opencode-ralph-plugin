const build = Bun.spawn(["bun", "run", "build:dashboard"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) process.exit(1);
const tests = Bun.spawn(
  ["bunx", "--no-install", "playwright", "test", ...process.argv.slice(2)],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(await tests.exited);
