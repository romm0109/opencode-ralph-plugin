import { readFile } from "node:fs/promises";
/** The source and compiled module both resolve the package's bundled role skill. */
export function loadRoleInstructions(
  role: "code-review" | "functional-review" | "tdd" | "merge",
): Promise<string> {
  return readFile(
    new URL(`../../skills/${role}/SKILL.md`, import.meta.url),
    "utf8",
  );
}
