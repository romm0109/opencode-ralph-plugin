import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type ApprovedCommandConfig, parseCommandConfig } from "./commands.js";

const model = z
  .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    models: z.record(z.string(), model).default({}),
    skillPaths: z.record(z.string(), z.string().min(1)).default({}),
    concurrency: z.number().int().positive().default(2),
    agentTimeoutMs: z.number().int().positive().default(1800000),
    timeoutMs: z.number().int().positive().default(300000),
  })
  .strict();
export type ProjectConfig = z.infer<typeof schema> & {
  commands: ApprovedCommandConfig;
};
export async function loadProjectConfig(
  workspace: string,
): Promise<ProjectConfig> {
  let raw = "{}";
  try {
    raw = await readFile(join(workspace, ".ralph/project.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return {
      ...schema.parse(JSON.parse(raw)),
      commands: parseCommandConfig(
        JSON.parse(
          await readFile(join(workspace, ".ralph/commands.json"), "utf8"),
        ),
      ),
    };
  } catch (cause) {
    throw new Error(
      "Invalid Ralph project configuration. Check .ralph/project.json and commands.json",
      { cause },
    );
  }
}
