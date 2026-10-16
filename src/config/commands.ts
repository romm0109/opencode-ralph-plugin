import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import { z } from "zod";

export const platforms = ["darwin", "linux", "win32"] as const;
const phases = ["setup", "check", "start", "readiness", "cleanup"] as const;
const nonempty = z
  .string()
  .min(1)
  .refine((s) => !s.includes("\0"));
const relativePath = nonempty.refine(
  (s) =>
    !isAbsolute(s) && !win32.isAbsolute(s) && !s.split(/[\\/]/).includes(".."),
  "Path must stay inside the workspace",
);
const commandSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    phase: z.enum(phases),
    executable: nonempty,
    args: z.array(z.string().refine((s) => !s.includes("\0"))),
    cwd: relativePath,
    timeoutMs: z.number().int().positive().max(86_400_000),
    platforms: z.array(z.enum(platforms)).min(1),
    env: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    ),
    shell: nonempty.optional(),
  })
  .strict();
export const commandConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    commands: z.array(commandSchema).min(1),
    rationale: nonempty,
    unsupportedPlatforms: z
      .partialRecord(z.enum(platforms), nonempty)
      .optional(),
    url: z.url().optional(),
    resources: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.enum(["port", "namespace", "directory"]),
      )
      .optional(),
    exclusiveResources: z.array(nonempty).optional(),
  })
  .strict();
export type CommandSpec = z.infer<typeof commandSchema>;
export type ApprovedCommandConfig = z.infer<typeof commandConfigSchema>;
export function parseCommandConfig(input: unknown): ApprovedCommandConfig {
  const config = commandConfigSchema.parse(input);
  const ids = new Set<string>();
  for (const command of config.commands) {
    if (
      ids.has(command.id) ||
      new Set(command.platforms).size !== command.platforms.length
    )
      throw new Error("Duplicate command ID or platform");
    ids.add(command.id);
  }
  for (const platform of platforms) {
    const applicable = config.commands.filter((c) =>
      c.platforms.includes(platform),
    );
    if (config.unsupportedPlatforms?.[platform]) {
      if (applicable.length)
        throw new Error(
          `Unsupported platform ${platform} has executable commands`,
        );
      continue;
    }
    if (!applicable.some((c) => c.phase === "check"))
      throw new Error(`No check or unsupported explanation for ${platform}`);
    let previous = -1;
    for (const command of applicable) {
      const phase = phases.indexOf(command.phase);
      if (phase < previous) throw new Error("Invalid lifecycle ordering");
      previous = phase;
    }
    if (
      applicable.some((c) => c.phase === "start") !==
      applicable.some((c) => c.phase === "readiness")
    )
      throw new Error("Startup requires readiness and vice versa");
  }
  return config;
}
export function commandConfigHash(config: ApprovedCommandConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(parseCommandConfig(config)))
    .digest("hex");
}
