// Deterministic OpenAI-compatible HTTP model; OpenCode itself is never mocked.
export function createModelFixture() {
  let calls = 0;
  let holding = false;
  let release: (() => void) | undefined;
  const reviewTools: string[][] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content?: unknown }[];
        tools?: { function: { name: string } }[];
      };
      calls++;
      const last = body.messages.at(-1);
      const text =
        typeof last?.content === "string"
          ? last.content
          : JSON.stringify(last?.content);
      if (last?.role === "user" && text === "RALPH_HOLD") {
        holding = true;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      const discovery = body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes(
            "Return ONLY a complete JSON command configuration",
          ),
      );
      let tool: { name: string; arguments: string } | undefined;
      if (last?.role === "user" && text?.startsWith("RALPH_REVIEW"))
        reviewTools.push(body.tools?.map((t) => t.function.name) ?? []);
      const setup = body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes(
            "Set up Ralph project commands in this conversation.",
          ),
      );
      const removal = body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes(
            "Remove Ralph from this project.",
          ),
      );
      const previousTool = [...body.messages]
        .reverse()
        .find((message) => message.role === "tool");
      const previousText = (
        typeof previousTool?.content === "string"
          ? previousTool.content
          : (JSON.stringify(previousTool?.content) ?? "")
      ).replace(/\\"/g, '"');
      const field = (name: string) =>
        previousText.match(new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]+)"`))?.[1];
      const config = {
        schemaVersion: 1,
        revision: 1,
        rationale: "Repository check proposal",
        commands: [
          {
            id: "test",
            phase: "check",
            executable: "bun",
            args: ["test"],
            cwd: ".",
            timeoutMs: 30000,
            platforms: ["darwin", "linux", "win32"],
            env: {},
          },
        ],
      };
      if (
        removal &&
        last?.role === "user" &&
        text?.includes("Remove Ralph from this project.")
      )
        tool = {
          name: "ralph_remove",
          arguments: JSON.stringify({ action: "preview" }),
        };
      else if (removal && last?.role === "user" && text === "yes")
        tool = {
          name: "ralph_remove",
          arguments: JSON.stringify({
            action: "remove",
            planId: field("planId"),
          }),
        };
      else if (
        setup &&
        last?.role === "user" &&
        text?.includes("Set up Ralph project commands")
      )
        tool = {
          name: "glob",
          arguments: JSON.stringify({ pattern: "README.md" }),
        };
      else if (
        setup &&
        last?.role === "user" &&
        text === "Approve the proposed commands"
      )
        tool = {
          name: "ralph_save_commands",
          arguments: JSON.stringify(config),
        };
      else if (last?.role === "user" && text === "RALPH_FOREGROUND")
        tool = {
          name: "shell",
          arguments: JSON.stringify({
            command: "bun --version",
            background: true,
            timeout: 10000,
          }),
        };
      else if (
        last?.role === "user" &&
        (text === "RALPH_DENIAL" || text?.startsWith("RALPH_REVIEW_MUTATION"))
      )
        tool = {
          name: "shell",
          arguments: JSON.stringify({
            command: "echo bypass > denied-sentinel",
            description: "Denied smoke operation",
          }),
        };
      else if (
        last?.role === "user" &&
        text?.includes("ralph_status") &&
        body.tools?.some((t) => t.function.name === "ralph_status")
      )
        tool = {
          name: "ralph_status",
          arguments: JSON.stringify({ runId: "smoke-run" }),
        };
      // Native interview prompts finish through tools, never JSON final prose.
      const stageMessage = [...body.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Stage identity: runId="),
        );
      const stageText = JSON.stringify(stageMessage?.content ?? "");
      const identity = stageText.match(
        /Stage identity: runId=([^,]+), attempt=(\d+)/,
      );
      if (
        !tool &&
        identity &&
        last?.role === "user" &&
        body.tools?.some((t) => t.function.name === "ralph_complete_interview")
      )
        tool = {
          name: "ralph_complete_interview",
          arguments: JSON.stringify({
            runId: identity[1],
            attempt: Number(identity[2]),
            text: "Reset the counter to zero.",
            scope: ["Counter reset"],
            criteria: ["Counter is zero"],
          }),
        };
      const content =
        setup && !tool && !text?.includes("configured")
          ? "Proposed commands: bun test (check, cwd ., 30 seconds, macOS/Linux/Windows, no environment mappings). Do you approve?"
          : discovery
            ? JSON.stringify({
                schemaVersion: 1,
                revision: 1,
                rationale: "Native setup/wrapper probe",
                unsupportedPlatforms: {},
                commands: [
                  {
                    id: "bun-version",
                    phase: "check",
                    executable: "bun",
                    args: ["--version"],
                    cwd: ".",
                    timeoutMs: 10000,
                    platforms: ["darwin", "linux", "win32"],
                    env: {},
                  },
                ],
              })
            : last?.role === "tool"
              ? text
              : "actual response";
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const response =
        chunk(
          {
            role: "assistant",
            ...(tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${calls}`,
                      type: "function",
                      function: tool,
                    },
                  ],
                }
              : { content }),
          },
          null,
        ) +
        chunk({}, tool ? "tool_calls" : "stop") +
        "data: [DONE]\n\n";
      return new Response(response, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    calls: () => calls,
    holding: () => holding,
    reviewTools: () => reviewTools,
    release: () => release?.(),
    close: () => server.stop(true),
  };
}
