import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import type { UserInputRequest, UserInputResult } from "../core/types.js";

const answers = z.object({ answers: z.tuple([z.tuple([z.string().min(1)])]) });

/** Invoke the host's question UI directly; model prose cannot settle a gate. */
export async function requestNativeInput(
  ctx: Pick<Plugin.Context, "session" | "tool">,
  request: UserInputRequest,
  signal: AbortSignal,
): Promise<UserInputResult> {
  signal.throwIfAborted();
  const question = (await ctx.tool.list()).find(
    (tool) => tool.id === "question",
  );
  if (!question)
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "OpenCode's native question tool is unavailable",
      },
    };
  const session = await ctx.session.get({ sessionID: request.sessionId });
  const result = await question.execute(
    {
      questions: [
        {
          question: request.question,
          header: "Ralph",
          custom: true,
          options:
            request.options ??
            (request.kind === "feature"
              ? []
              : [
                  {
                    label: request.recommendation ?? "Continue",
                    description: request.recommendation
                      ? "Recommended answer; you can also enter your own answer"
                      : "Use the free-text field to describe or revise the feature",
                  },
                ]),
        },
      ],
    },
    {
      sessionID: request.sessionId as ToolContext["sessionID"],
      agent: (session.agent ?? "build") as ToolContext["agent"],
      messageID: `ralph-input:${request.requestId}` as ToolContext["messageID"],
      id: `ralph-input:${request.requestId}` as ToolContext["id"],
      signal,
      progress: async () => {},
    },
  );
  signal.throwIfAborted();
  const parsed = answers.safeParse(result.metadata);
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: "missing-output",
        message: "Native question returned no single answer",
      },
    };
  return {
    ok: true,
    source: "user",
    requestId: request.requestId,
    revision: request.revision,
    sessionId: request.sessionId,
    messageId: `question:${request.requestId}`,
    text: parsed.data.answers[0][0],
  };
}
