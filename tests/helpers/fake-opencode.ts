import type { Plugin } from "@opencode/plugin";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Info, ToolEditor } from "@opencode/plugin/promise/tool";
import { createAdapterClient } from "../../src/opencode/adapter.js";

export function createFakeOpenCode(options: { sessionPrefix?: string } = {}) {
  const requests: {
    path: string;
    directory: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const sessions = new Map<
    string,
    {
      directory: string;
      text?: string;
      promptId?: string;
      metadata?: Record<string, unknown>;
    }
  >();
  let denied = false,
    empty = false,
    deniedTool = false,
    invalidTool = false,
    holdCreation = false,
    holdPrompt = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let failCreationReceipt = false,
    failPromptReceipt = false;
  let count = 0;
  type Responder = (
    prompt: string,
    metadata?: Record<string, unknown>,
  ) => string | Promise<string>;
  let reply: string | Responder = "actual response";
  let failedCodeMode = false;
  let missingRead: { tool: string; message: string } | undefined;
  const client = createAdapterClient(
    "http://fixture.invalid",
    async (request) => {
      const url = new URL(request.url);
      const raw = request.method === "POST" ? await request.text() : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const sessionID = url.pathname.match(/\/session\/([^/]+)/)?.[1];
      const location = body.location as { directory?: string } | undefined;
      requests.push({
        path: url.pathname,
        directory:
          location?.directory ??
          (sessionID ? sessions.get(sessionID)?.directory : undefined) ??
          url.searchParams.get("location[directory]"),
        body,
      });
      if (denied)
        return Response.json(
          { _tag: "PermissionDeniedError", message: "Permission denied" },
          { status: 403 },
        );
      if (url.pathname.startsWith("/api/rpc/")) {
        const method = url.pathname.split("/").at(-1);
        return Response.json({
          output:
            method === "tools"
              ? [
                  "read",
                  "glob",
                  "grep",
                  "edit",
                  "write",
                  "shell",
                  "custom_tool",
                  "http",
                  "agent-browser",
                ]
              : { ok: true },
        });
      }
      if (url.pathname === "/api/session" && request.method === "GET") {
        return Response.json({
          data: [...sessions].map(([id, session]) => ({
            id,
            location: { directory: session.directory },
            metadata: session.metadata,
          })),
          cursor: {},
        });
      }
      if (url.pathname === "/api/session") {
        if (holdCreation) await gate;
        const id =
          typeof body.id === "string"
            ? body.id
            : `${options.sessionPrefix ?? "session"}-${++count}`;
        sessions.set(id, {
          directory: location?.directory ?? "",
          metadata: body.metadata as Record<string, unknown>,
        });
        if (failCreationReceipt) {
          failCreationReceipt = false;
          throw new Error("Lost session creation receipt");
        }
        return Response.json({
          data: {
            id,
            location: { directory: location?.directory },
            time: { created: 1, updated: 1 },
          },
        });
      }
      if (sessionID && url.pathname === `/api/session/${sessionID}`)
        return Response.json({
          data: {
            id: sessionID,
            agent: "build",
            model: { providerID: "fixture", id: "model" },
            location: { directory: sessions.get(sessionID)?.directory ?? "" },
          },
        });
      if (url.pathname.endsWith("/interrupt"))
        return Response.json({ data: { interrupted: true } });
      if (url.pathname.endsWith("/wait")) {
        await gate;
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/inbox")) {
        return Response.json({ data: [] });
      }
      if (url.pathname.endsWith("/prompt")) {
        if (holdPrompt) await gate;
        const session = sessions.get(sessionID as string);
        if (session) {
          session.text = String(body.text);
          if (typeof body.id === "string") session.promptId = body.id;
          else delete session.promptId;
        }
        if (failPromptReceipt) {
          failPromptReceipt = false;
          throw new Error("Lost queued prompt receipt");
        }
        return Response.json({
          data: {
            id: "user-1",
            type: "user",
            sessionID,
            payload: { text: body.text },
            time: { created: 1 },
            delivery: "steer",
          },
        });
      }
      if (url.pathname.endsWith("/context")) {
        const stagePrompt = sessions.get(sessionID as string)?.promptId;
        if (stagePrompt?.startsWith("msg_ralph-"))
          return Response.json({
            data: [
              {
                id: stagePrompt,
                type: "user",
                text: sessions.get(sessionID as string)?.text,
                time: { created: 1 },
              },
            ],
          });
        return Response.json({
          data: [
            {
              id: sessions.get(sessionID as string)?.promptId ?? "user-1",
              type: "user",
              text: sessions.get(sessionID as string)?.text,
              time: { created: 1 },
            },
            {
              id: "earlier-message",
              type: "assistant",
              time: { created: 1, completed: 2 },
              content: invalidTool
                ? [
                    {
                      type: "tool",
                      name: "invalid",
                      state: {
                        status: "completed",
                        input: {},
                        content: [{ type: "text", text: "unavailable" }],
                      },
                    },
                  ]
                : failedCodeMode
                  ? [
                      {
                        type: "tool",
                        name: "execute",
                        state: {
                          status: "completed",
                          input: {},
                          content: [
                            { type: "text", text: "caught inner failure" },
                          ],
                          metadata: {
                            toolCalls: [{ tool: "shell", status: "error" }],
                          },
                        },
                      },
                    ]
                  : deniedTool
                    ? [
                        {
                          type: "tool",
                          name: "shell",
                          state: {
                            status: "error",
                            error: {
                              type: "PermissionDenied",
                              message:
                                "The user rejected permission to use this tool",
                            },
                          },
                        },
                      ]
                    : missingRead
                      ? [
                          {
                            type: "tool",
                            name: missingRead.tool,
                            state: {
                              status: "error",
                              error: { message: missingRead.message },
                            },
                          },
                        ]
                      : [],
            },
            {
              id: "message-1",
              type: "assistant",
              time: { created: 1, completed: 2 },
              finish: "stop",
              content: [
                {
                  type: "text",
                  text: empty
                    ? ""
                    : typeof reply === "function"
                      ? await reply(
                          sessions.get(sessionID as string)?.text ?? "",
                          sessions.get(sessionID as string)?.metadata,
                        )
                      : reply,
                },
              ],
            },
            {
              id: "idle-1",
              type: "idle",
              outcome: "succeeded",
              time: { created: 3 },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/synthetic"))
        return Response.json({
          data: {
            id: "synthetic-1",
            sessionID,
            type: "synthetic",
            payload: body,
            time: { created: 1 },
            delivery: "steer",
          },
        });
      return Response.json({ data: true });
    },
  );
  return {
    client,
    requests,
    loseCreationReceipt() {
      failCreationReceipt = true;
    },
    losePromptReceipt() {
      failPromptReceipt = true;
    },
    respond: (text: string | Responder) => {
      reply = text;
    },
    denyTool: () => {
      deniedTool = true;
    },
    invalidTool: () => {
      invalidTool = true;
    },
    missingRead: () => {
      missingRead = {
        tool: "ralph_review_read",
        message: "File not found: guessed.ts",
      };
    },
    failObservation: (tool: string, message: string) => {
      missingRead = { tool, message };
    },
    failCodeMode: () => {
      failedCodeMode = true;
    },
    empty: () => {
      empty = true;
    },
    holdPrompt: () => {
      holdPrompt = true;
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    holdCreation: () => {
      holdCreation = true;
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    deny: () => {
      denied = true;
    },
    hold: () => {
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    release: () => release?.(),
  };
}

// Exercises the actual v2 registration and cleanup contracts without a model.
export function createFakePluginContext(
  directory: string,
  client = createFakeOpenCode().client,
) {
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, Info & { id: string }>();
  const hooks = new Map<string, (input: unknown) => Promise<void> | void>();
  const statuses: string[] = [];
  const stageSessions: unknown[] = [];
  const rpcHandlers = new Map<string, (input: never) => Promise<unknown>>();
  const registration = (dispose = async () => {}) => ({ dispose });
  const context = {
    location: { directory },
    permission: { assert: async () => {} },
    session: {
      ...client.session,
      hook: async (
        name: string,
        hook: (input: unknown) => Promise<void> | void,
      ) => {
        hooks.set(`session.${name}`, hook);
        return registration(async () => {
          hooks.delete(`session.${name}`);
        });
      },
    },
    command: {
      transform: async (
        apply: (editor: { add(definition: CommandDefinition): void }) => void,
      ) => {
        apply({
          add: (definition) => {
            commands.set(definition.name, definition);
          },
        });
        return registration(async () => {
          commands.clear();
        });
      },
    },
    tool: {
      list: async () => [...tools.values()],
      reload: async () => {},
      transform: async (apply: (editor: ToolEditor) => void) => {
        const added: string[] = [];
        apply({
          list: () => [...tools.values()],
          get: (id: string) => tools.get(id),
          namespace: () => {},
          update: () => {},
          remove: (id: string) => {
            tools.delete(id);
          },
          add: (info) => {
            tools.set(info.name, { ...info, id: info.name });
            added.push(info.name);
          },
        });
        return registration(async () => {
          for (const name of added) tools.delete(name);
        });
      },
      hook: async (
        name: string,
        hook: (input: unknown) => Promise<void> | void,
      ) => {
        hooks.set(`tool.${name}`, hook);
        return registration(async () => {
          hooks.delete(`tool.${name}`);
        });
      },
    },
    rpc: {
      register: async (
        _definition: unknown,
        handlers: Record<string, (input: never) => Promise<unknown>>,
      ) => {
        for (const [name, handler] of Object.entries(handlers))
          rpcHandlers.set(name, handler);
        return {
          ...registration(async () => {
            rpcHandlers.clear();
          }),
          events: {
            emit: async (name: string, data: { text: string }) => {
              if (name === "stageSession") stageSessions.push(data);
              else statuses.push(data.text);
            },
          },
        };
      },
    },
    event: {
      subscribe: async function* (_options: { signal?: AbortSignal }) {},
    },
  } as unknown as Plugin.Context;
  return {
    context,
    commands,
    tools,
    hooks,
    statuses,
    stageSessions,
    rpcHandlers,
  };
}
