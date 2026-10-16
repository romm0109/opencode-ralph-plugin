/** A compiled OpenCode executable embeds Bun but cannot execute arbitrary scripts. */
export function bunRuntime(): string {
  const executable = Bun.which("bun");
  if (!executable)
    throw new Error(
      "Ralph requires Bun on PATH to run owned command wrappers. Install the version pinned in .bun-version.",
    );
  return executable;
}
