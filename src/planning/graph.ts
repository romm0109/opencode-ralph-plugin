import { z } from "zod";

const strings = z.array(z.string().trim().min(1)).min(1);
export const artifactRevision = z
  .object({
    revision: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    artifactPath: z.string().min(1),
  })
  .strict();
const issue = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    title: z.string().trim().min(1),
    artifactPath: z.string().regex(/^issues\/[A-Za-z0-9_-]+\.md$/),
    dependencies: z.array(z.string().min(1)),
    acceptanceCriteria: strings,
    testableBehaviors: strings,
  })
  .strict();
const graph = z
  .object({
    schemaVersion: z.literal(1),
    prdRevision: artifactRevision,
    issues: z.array(issue).min(1),
  })
  .strict();
export type IssueSpec = z.infer<typeof issue>;
export type IssueGraph = z.infer<typeof graph>;
export function topologicalOrder(value: IssueGraph): string[] {
  const issues = new Map(value.issues.map((item) => [item.id, item]));
  if (issues.size !== value.issues.length)
    throw new Error("Duplicate issue IDs");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Issue graph contains a cycle");
    if (visited.has(id)) return;
    const item = issues.get(id);
    if (!item) throw new Error(`Unknown dependency ${id}`);
    visiting.add(id);
    for (const dependency of item.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const item of value.issues) visit(item.id);
  return order;
}
export function validateIssueGraph(
  raw: unknown,
  files: Record<string, string>,
  prd: z.infer<typeof artifactRevision>,
): IssueGraph {
  const value = graph.parse(raw);
  if (
    JSON.stringify(value.prdRevision) !==
    JSON.stringify(artifactRevision.parse(prd))
  )
    throw new Error("Issue graph references a different PRD revision");
  const paths = new Set<string>();
  for (const item of value.issues) {
    if (paths.has(item.artifactPath))
      throw new Error("Duplicate issue artifact path");
    paths.add(item.artifactPath);
    const text = files[item.artifactPath];
    if (!text?.trim())
      throw new Error(`Missing issue file ${item.artifactPath}`);
    const sections = new Map<string, string>();
    const headings = [...text.matchAll(/^##\s+(.+)$/gm)];
    for (const [index, match] of headings.entries()) {
      const name = (match[1] ?? "").trim().toLowerCase();
      if (sections.has(name))
        throw new Error(`Issue ${item.id} repeats ${name}`);
      sections.set(
        name,
        text
          .slice(
            (match.index ?? 0) + match[0].length,
            headings[index + 1]?.index ?? text.length,
          )
          .trim(),
      );
    }
    for (const heading of [
      "What to build",
      "Context: files to read before implementing",
      "Patterns to follow",
      "Step-by-step tasks",
      "Acceptance criteria",
      "Validation commands",
      "Blocked by",
    ])
      if (
        !sections
          .get(heading.toLowerCase())
          ?.replace(/^#+.*$/gm, "")
          .trim()
      )
        throw new Error(`Issue ${item.id} missing or empty ${heading}`);
  }
  if (Object.keys(files).some((path) => !paths.has(path)))
    throw new Error("Invalid issue file reference");
  topologicalOrder(value);
  return value;
}
