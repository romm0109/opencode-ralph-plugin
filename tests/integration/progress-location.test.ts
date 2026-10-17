import { test } from "bun:test";
import { join } from "node:path";
import { openRunStore } from "../../src/state/run-store.js";
import { createTestProject } from "../helpers/project.js";

test("progress observation ignores a successfully removed worktree location", async () => {
  const project = await createTestProject();
  try {
    const { createProgressObserver } = await import(
      "../../src/opencode/progress.js"
    );
    const observer = createProgressObserver({
      store: await openRunStore(project.directory),
      directory: join(project.directory, "removed-owned-worktree"),
      async deliver() {
        throw new Error("Removed worktree cannot own progress");
      },
    });
    await observer.flush();
    await observer.flush();
    await observer.stop();
  } finally {
    await project.cleanup();
  }
});
