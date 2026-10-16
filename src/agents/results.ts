import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { JobEnvelope, JobResult } from "../core/types.js";

const stage = z
  .object({ exitCode: z.number().int(), log: z.string().trim().min(1) })
  .strict();
const tdd = z
  .object({
    cycles: z.array(
      z
        .object({
          behavior: z.string().trim().min(1),
          red: stage.refine((s) => s.exitCode !== 0),
          green: stage.refine((s) => s.exitCode === 0),
        })
        .strict(),
    ),
    exception: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((t) => t.cycles.length > 0 || !!t.exception);
export const submissionSchema = z
  .object({
    issueId: z.string(),
    attempt: z.number().int().positive(),
    baseCommit: z.string(),
    submittedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tdd,
  })
  .strict();
export type Submission = z.infer<typeof submissionSchema> & {
  sessionId: string;
};
export function correlatedResult(job: JobEnvelope, result: JobResult) {
  if (
    (result.outcome !== "completed" &&
      !(job.role === "executor" && result.outcome === "needs_input")) ||
    !result.text ||
    !result.sessionId ||
    [
      "runId",
      "jobId",
      "role",
      "issueId",
      "attempt",
      "baseCommit",
      "workspace",
    ].some(
      (key) =>
        job[key as keyof JobEnvelope] !== result[key as keyof JobEnvelope],
    ) ||
    !isDeepStrictEqual(job.inputRevisions, result.inputRevisions)
  )
    throw new Error("Invalid or missing correlated agent output");
  return JSON.parse(result.text) as unknown;
}
export function parseSubmission(
  result: JobResult,
  job: JobEnvelope,
): Submission {
  if (result.outcome !== "completed")
    throw new Error("Executor question is not a submission");
  const value = submissionSchema.parse(correlatedResult(job, result));
  if (
    value.issueId !== job.issueId ||
    value.attempt !== job.attempt ||
    value.baseCommit !== job.baseCommit
  )
    throw new Error("Submission identity mismatch");
  return { ...value, sessionId: result.sessionId as string };
}

export const executorQuestionSchema = z
  .object({
    kind: z.literal("needs_input"),
    question: z.string().trim().min(1),
    recommendedAnswer: z.string().trim().min(1),
    affectedRequirement: z.string().trim().min(1),
    revisedExplanation: z
      .object({
        text: z.string().trim().min(1),
        scope: z.array(z.string().trim().min(1)).min(1),
        criteria: z.array(z.string().trim().min(1)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export function parseExecutorQuestion(result: JobResult, job: JobEnvelope) {
  const raw = correlatedResult(job, result);
  if (
    typeof raw === "object" &&
    raw !== null &&
    "kind" in raw &&
    raw.kind === "needs_input"
  )
    return executorQuestionSchema.parse(raw);
  return undefined;
}
