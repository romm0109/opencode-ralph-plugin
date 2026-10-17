import { Rpc } from "@opencode/schema/rpc";
import { z } from "zod";

// OpenCode v2 exposes the tool catalog to plugins, but not as a client endpoint.
// This read-only RPC keeps external typed integrations on the same host boundary.
export const ralphBridge = Rpc.define({
  id: "ralph",
  methods: {
    tools: { input: z.object({}), output: z.array(z.string()) },
    prepareReview: {
      input: z.object({ tools: z.array(z.string()) }),
      output: z.object({ ok: z.literal(true) }),
    },
    publishStatus: {
      input: z.object({ text: z.string() }),
      output: z.object({ ok: z.literal(true) }),
    },
  },
  events: {
    stageSession: {
      schema: z.object({
        runId: z.string(),
        revision: z.number().int().positive(),
        stage: z.enum(["interview", "issues"]),
        sessionId: z.string(),
        attempt: z.number().int().positive(),
      }),
    },
    status: { schema: z.object({ text: z.string() }) },
    // The TUI loads forms when a session opens; a Ralph question created while
    // its session is already open must be loaded explicitly to appear.
    question: { schema: z.object({ sessionId: z.string() }) },
  },
});
