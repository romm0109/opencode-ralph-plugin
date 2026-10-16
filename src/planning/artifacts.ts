import { createHash } from "node:crypto";
export function explanationHash(value: {
  text: string;
  scope: string[];
  criteria: string[];
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "explanation",
        text: value.text,
        scope: value.scope,
        criteria: value.criteria,
      }),
    )
    .digest("hex");
}

export function artifactHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export function issueBundleHash(graph: unknown, files: Record<string, string>) {
  return artifactHash(
    JSON.stringify({
      graph,
      files: Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }),
  );
}
