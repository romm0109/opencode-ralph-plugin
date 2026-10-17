import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function loadRoleInstructions(
  workspace: string,
  role: "interview" | "prd" | "issues" | "executor" | "merger",
  overrides: Record<string, string> = {},
) {
  const bundled = new URL(
    `../../skills/${{ interview: "grill-me", prd: "create-prd", issues: "to-issues", executor: "tdd", merger: "merge" }[role]}/SKILL.md`,
    import.meta.url,
  );
  const path = overrides[role] ? resolve(workspace, overrides[role]) : bundled;
  let text: string;
  try {
    text = await readFile(path, "utf8");
    if (!text.trim()) throw new Error("Empty instructions");
    if (overrides[role])
      text = `${await readFile(bundled, "utf8")}\nProject instructions:\n${text}`;
  } catch (cause) {
    throw new Error(
      `Cannot load ${role} instructions at ${path}. Fix .ralph/project.json skillPaths.${role}.`,
      { cause },
    );
  }
  if (role === "interview")
    text += `
Ralph interview stage contract:
Explore repository facts with observation tools. Resolve scope, acceptance criteria,
constraints, and failure behavior. Ask one substantive question at a time with
OpenCode's native question tool. Put your recommended answer first as an option
whose label ends with "(Recommended)", add real alternatives, and wait for the
human answer. Keep exploring and asking in this same turn; never end your turn
with a question in prose. Only if the question tool is unavailable, end your turn
with the question as JSON for Ralph to ask:
{"kind":"question","question":"...","recommendation":"..."}
When decisions are resolved, explain the feature using ASD-STE100 writing instructions:
use short sentences, active voice, consistent terms, and simple vocabulary. This is
writing guidance, not a separately certified result. Finish by calling
ralph_complete_interview with runId, attempt, text, scope[], and criteria[].
The host supplies session identity and obtains native human approval.
Stay in this interview. Do not write project files or advance to another stage.
Assistant prose cannot complete the stage or authorize work.
`;
  return {
    path: String(path),
    hash: createHash("sha256").update(text).digest("hex"),
    text,
  };
}
