import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { handleControlCommand } from "./commands/control.js";
import { startNativeFeature } from "./commands/orchestrator.js";
import { runRemovalCommand } from "./commands/remove-command.js";
import { createCommandRouter } from "./commands/router.js";
import {
  commandSetupPrompt,
  saveProjectCommands,
} from "./commands/save-commands.js";
import { commandConfigSchema } from "./config/commands.js";
import type { UserInputRequest, UserInputResult } from "./core/types.js";
import { startDashboard } from "./dashboard/server.js";
import {
  createOpenCodeAdapter,
  reviewToolAlias,
  reviewTools,
} from "./opencode/adapter.js";
import { ralphBridge } from "./opencode/bridge.js";
import {
  nativeAnswer,
  nativeQuestionInput,
  requestNativeInput,
} from "./opencode/native-input.js";
import { createProgressObserver } from "./opencode/progress.js";
import {
  planningFileInput,
  writePlanningFile,
} from "./planning/artifact-writer.js";
import {
  completeInterview,
  completeInterviewInput,
  completeIssues,
  completeIssuesInput,
  completePrd,
  completePrdInput,
} from "./planning/completion.js";
import {
  setPlanningQuestionWaiting,
  startPlanningSupervision,
} from "./planning/generation.js";
import {
  productDecisionInput,
  requestProductDecision,
} from "./planning/questions.js";
import { reconcileRun } from "./recovery/reconcile.js";
import { runAutomaticReview } from "./review/automatic.js";
import { acquireHostLease } from "./state/host-lease.js";
import { openRunStore } from "./state/run-store.js";
import { runtimeSecretValues, sanitizeValue } from "./state/sanitize.js";

const RALPH_COMMANDS = [
  "ralph-status",
  "ralph-commands",
  "ralph-orchestrator",
  "ralph-pause",
  "ralph-resume",
  "ralph-stop",
  "ralph-remove",
] as const;

/** The TUI shows a synthetic message collapsed to its description, so it must carry the outcome. */
const brief = (text: string) => {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};
const RELAY_PROMPT =
  "Ralph needs a human answer in this session. Call the question tool exactly once now with any input; Ralph replaces it with the pending question and records the human answer. Then end your turn.";
const RELAYED = Symbol("relayed");
/** How long a disposed last instance waits for a reloaded successor. */
function reloadGraceMs() {
  const value = Number(process.env.RALPH_RELOAD_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : 3000;
}
/** The background completion of each relayed stage tool call, by tool context. */
export const relayedStageWork = new WeakMap<object, Promise<unknown>>();

export const RalphPlugin = Plugin.define({
  id: "ralph",
  async setup(ctx) {
    const directory = ctx.location.directory;
    // The Ralph stage tool call that is running, if any.
    const stageToolCall = new AsyncLocalStorage<{
      sessionId: string;
      relayed: () => void;
      returned: boolean;
    }>();
    // OpenCode shows forms that Ralph creates itself only while a slash command
    // runs. Every other Ralph question is relayed through the session agent's
    // own question tool call: Ralph replaces that call's input with the pending
    // question and reads the human answer from the host result.
    const relays = new Map<
      string,
      {
        request: UserInputRequest;
        resolve: (result: UserInputResult) => void;
        callId?: string;
      }
    >();
    async function relayUserInput(
      request: UserInputRequest,
    ): Promise<UserInputResult> {
      if (!(await ctx.tool.list()).some((tool) => tool.id === "question"))
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "OpenCode's native question tool is unavailable",
          },
        };
      return new Promise<UserInputResult>((resolve) => {
        relays.get(request.sessionId)?.resolve({
          ok: false,
          error: {
            code: "cancelled",
            message: "Superseded by a newer Ralph question",
          },
        });
        relays.set(request.sessionId, { request, resolve });
        const caller = stageToolCall.getStore();
        // Only the first question can ride the agent's next tool call; once
        // the stage tool has returned, later questions prompt the agent.
        if (caller?.sessionId === request.sessionId && !caller.returned) {
          caller.returned = true;
          caller.relayed();
          return;
        }
        void ctx.session
          .prompt({
            sessionID: request.sessionId,
            text: request.details
              ? `${RELAY_PROMPT}\nBefore calling it, write this text to the user verbatim as your message:\n\n${request.details}`
              : RELAY_PROMPT,
            metadata: { ralphCommand: true },
          })
          .catch((cause) => {
            if (relays.get(request.sessionId)?.request !== request) return;
            relays.delete(request.sessionId);
            resolve({
              ok: false,
              error: { code: "sdk-error", message: String(cause) },
            });
          });
      });
    }
    /** Returns to the agent as soon as its tool call needs a relayed answer. */
    async function relayingTool(
      context: { sessionID: string },
      work: () => Promise<unknown>,
    ) {
      const sessionId = context.sessionID;
      let relayed: () => void = () => {};
      const asked = new Promise<typeof RELAYED>((resolve) => {
        relayed = () => resolve(RELAYED);
      });
      const running = stageToolCall.run(
        { sessionId, relayed: () => relayed(), returned: false },
        work,
      );
      const first = await Promise.race([running, asked]);
      if (first !== RELAYED) return JSON.stringify(first);
      relayedStageWork.set(context, running);
      running.catch((cause) =>
        console.error(
          "Ralph stage completion failed",
          sanitizeValue(String(cause), runtimeSecretValues()).slice(0, 1000),
        ),
      );
      const details = relays.get(sessionId)?.request.details;
      return JSON.stringify({
        outcome: "awaiting-human",
        ...(details
          ? {
              show: details,
              next: "First write the `show` text to the user verbatim as your message. Then call the question tool with any input. Ralph shows its pending question there and records the human answer. Call no other tool first.",
            }
          : {
              next: "Call the question tool now with any input. Ralph shows its pending question there and records the human answer. Call no other tool first.",
            }),
      });
    }
    // A globally installed plugin also loads in folders that are not Git
    // repositories. Stay loaded and explain the requirement instead of failing.
    if (
      Bun.spawnSync(["git", "-C", directory, "rev-parse", "--git-dir"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode !== 0
    ) {
      const registration = await ctx.command.transform((editor) => {
        for (const name of RALPH_COMMANDS)
          editor.add({
            name,
            description: "Ralph needs a Git repository in this folder",
            async execute(input) {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `Ralph is unavailable here: ${directory} is not inside a Git repository. Run \`git init\` and commit your project, then restart OpenCode in it.`,
                description: "Ralph needs a Git repository",
                resume: false,
              });
            },
          });
      });
      return () => registration.dispose();
    }
    const store = await openRunStore(directory);
    const lease = await acquireHostLease(store.root);
    const registrations: Registration[] = [];
    const observationAliases = new Set<string>();
    function addObservationAliases(
      editor: ToolEditor,
      allowed: readonly string[],
    ) {
      for (const tool of editor.list()) {
        if (!allowed.includes(tool.id) || editor.get(reviewToolAlias(tool.id)))
          continue;
        editor.add({
          name: reviewToolAlias(tool.id),
          description: tool.description,
          input: tool.input,
          ...(tool.output ? { output: tool.output } : {}),
          options: {
            codemode: false,
            permission: tool.options?.permission ?? tool.id,
          },
          execute: tool.execute,
        });
        observationAliases.add(tool.id);
      }
    }
    async function prepareReview(_workspace: string, allowed: string[]) {
      if (allowed.every((id) => observationAliases.has(id))) return;
      registrations.push(
        await ctx.tool.transform((editor) =>
          addObservationAliases(editor, allowed),
        ),
      );
      await ctx.tool.reload();
    }
    let statusEvents:
      | Awaited<ReturnType<typeof ctx.rpc.register<typeof ralphBridge>>>
      | undefined;
    const adapter = createOpenCodeAdapter(
      {
        session: {
          ...ctx.session,
          async create(input) {
            // OpenCode scopes forms and tools by location spelling. A canonical
            // path can identify the same checkout but select a different scope.
            const sameWorkspace =
              input?.location?.directory &&
              (await realpath(input.location.directory)) ===
                (await realpath(directory));
            return ctx.session.create({
              ...input,
              ...(sameWorkspace ? { location: { directory } } : {}),
            });
          },
        },
        requestUserInput: (request) =>
          request.kind === "feature" || request.kind === "existing-run"
            ? requestNativeInput(ctx, request, eventsAbort.signal)
            : relayUserInput(request),
        assertCommandPermission: async (sessionId, command, hash) => {
          await ctx.permission.assert({
            sessionID: sessionId,
            action: "shell",
            resources: [
              JSON.stringify({
                executable: command.executable,
                args: command.args,
                cwd: command.cwd,
                shell: command.shell,
              }),
            ],
            metadata: { ralphCommandHash: hash, commandId: command.id },
          });
        },
        tools: async () => (await ctx.tool.list()).map((tool) => tool.id),
        prepareReview,
        focusStageSession: async (
          _workspace,
          runId,
          sessionId,
          stage = "interview",
        ) => {
          const run = await store.getRun(runId);
          if (
            !run?.planning?.owner ||
            run.planning.owner.retired ||
            run.planning.owner.sessionId !== sessionId ||
            (stage === "issues"
              ? run.planning.owner.stage !== "issues"
              : run.planning.owner.stage !== "interview") ||
            (await realpath(run.planning.workspace)) !==
              (await realpath(directory)) ||
            (await realpath(_workspace)) !== (await realpath(directory))
          )
            return;
          await statusEvents?.events.emit("stageSession", {
            runId,
            sessionId,
            stage,
            attempt: run.planning.owner.attempt,
            revision: run.revision,
          });
        },
        notify: async (_workspace, text) => {
          await statusEvents?.events.emit("status", {
            text: sanitizeValue(text, runtimeSecretValues()).slice(0, 16000),
          });
        },
      },
      store,
    );
    const recoveryNotifications: string[] = [];
    adapter.finalizeExecution = (snapshot) =>
      runAutomaticReview(store, adapter, snapshot);
    try {
      if (lease.recover)
        for (const run of await store.listRuns()) {
          if (
            (run.reviewWorkflow?.status === "terminal" ||
              (run.control?.status === "stopped" &&
                Object.values(run.operations).some(
                  (op) =>
                    op.kind === "run.release" && op.status === "completed",
                ))) &&
            Object.values(run.operations).every((op) => op.status !== "intent")
          )
            continue;
          recoveryNotifications.push(
            JSON.stringify(
              await reconcileRun({
                store,
                directory,
                runId: run.runId,
                adapter,
              }),
            ),
          );
        }
      if (lease.recover) await lease.ready();
    } catch (cause) {
      if (await lease.release()) await lease.finish();
      throw cause;
    }
    let dashboard: Awaited<ReturnType<typeof startDashboard>>;
    try {
      dashboard = await startDashboard(store);
    } catch (cause) {
      if (await lease.release()) await lease.finish();
      throw cause;
    }
    const router = createCommandRouter(
      store,
      adapter,
      dashboard.url,
      directory,
    );
    const eventsAbort = new AbortController();
    let disposed = false;
    const stopPlanningSupervision = startPlanningSupervision(store, adapter);
    let notification: ReturnType<typeof setImmediate> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    const progress = createProgressObserver({
      store,
      directory,
      async deliver({ runId, sessionId, id, text }) {
        if (disposed) throw new Error("Progress observer stopped");
        const result = await adapter.publishProgress?.(
          runId,
          sessionId,
          directory,
          id,
          text,
        );
        if (!result?.ok)
          throw new Error(result?.error?.message ?? "Progress unavailable");
        // Toasts stay short; the full update is in the chat entry.
        await adapter.publishStatus(
          sessionId,
          directory,
          text.split("\n", 1)[0]?.slice(0, 200) ?? "",
        );
      },
    });
    async function interviewOwner(sessionID: string) {
      return (await store.listRuns()).find(
        (run) =>
          run.planning?.protocol === "native-interview-v1" &&
          (run.planning.owner?.sessionId === sessionID ||
            run.planning.prdAcceptance?.sessionId === sessionID ||
            run.planning.attempts?.some((a) => a.sessionId === sessionID)),
      );
    }
    async function sessionJob(sessionID: string) {
      for (const run of await store.listRuns()) {
        const entry = Object.values(run.jobs).find(
          (job) =>
            job.envelope.sessionId === sessionID &&
            job.envelope.role !== "command-verification",
        );
        if (entry) return entry;
      }
    }
    async function dispose() {
      if (disposed) return;
      disposed = true;
      stopPlanningSupervision();
      if (progressTimer) clearInterval(progressTimer);
      await progress.stop();
      if (notification) clearImmediate(notification);
      eventsAbort.abort();
      for (const relay of relays.values())
        relay.resolve({
          ok: false,
          error: { code: "cancelled", message: "Ralph is shutting down" },
        });
      relays.clear();
      // A config change reloads plugins in this same host: the new instance
      // takes over the durable runs, so only a real shutdown stops them.
      const live = (await store.listRuns()).some(
        (run) =>
          run.control?.status !== "stopped" &&
          run.reviewWorkflow?.status !== "terminal",
      );
      const lastInstance =
        (await lease.release()) &&
        !(live && (await lease.awaitSuccessor(reloadGraceMs())));
      try {
        if (lastInstance)
          for (const run of await store.listRuns()) {
            if (
              (run.control?.status === "stopped" ||
                run.reviewWorkflow?.status === "terminal") &&
              !Object.values(run.operations).some((op) => op.ownedProcess)
            )
              continue;
            await handleControlCommand(
              "ralph-stop",
              run.runId,
              store,
              adapter,
              {
                source: "shutdown",
              },
            );
            const current = await store.getRun(run.runId);
            await store.recordControl(run.runId, {
              status: "interrupted",
              source: "shutdown",
              facts: current?.control?.facts ?? [],
            });
          }
      } finally {
        await Promise.allSettled(
          registrations.map((registration) => registration.dispose()),
        );
        try {
          await dashboard.stop();
        } finally {
          if (lastInstance) await lease.finish();
        }
      }
    }
    try {
      statusEvents = await ctx.rpc.register(ralphBridge, {
        tools: async () => (await ctx.tool.list()).map((tool) => tool.id),
        prepareReview: async ({ tools }) => {
          await prepareReview(directory, tools);
          return { ok: true };
        },
        publishStatus: async ({ text }) => {
          await statusEvents?.events.emit("status", {
            text: sanitizeValue(text, runtimeSecretValues()).slice(0, 16000),
          });
          return { ok: true };
        },
      });
      registrations.push(statusEvents);
      registrations.push(
        await ctx.command.transform((editor) => {
          for (const name of RALPH_COMMANDS) {
            editor.add({
              name,
              description: {
                "ralph-status": "Read durable Ralph run status",
                "ralph-commands":
                  "Discover, review and approve project commands",
                "ralph-orchestrator":
                  "Build a feature: interview, PRD, issues, then automatic execution",
                "ralph-pause": "Pause the Ralph run after current work settles",
                "ralph-resume": "Resume the paused or interrupted Ralph run",
                "ralph-stop": "Stop the Ralph run and its owned work",
                "ralph-remove":
                  "Preview and remove Ralph state from this project",
              }[name],
              async execute(input) {
                if (name === "ralph-commands") {
                  await ctx.session.prompt({
                    sessionID: input.sessionID,
                    text: commandSetupPrompt,
                    metadata: { ralphCommand: true },
                    delivery: input.delivery,
                  });
                  return;
                }
                if (name === "ralph-orchestrator") {
                  try {
                    await startNativeFeature({
                      workspace: directory,
                      sessionId: input.sessionID,
                      feature: input.prompt.text.trim(),
                      store,
                      adapter,
                    });
                  } catch (cause) {
                    const text = `Ralph interview blocked: ${cause instanceof Error ? cause.message : String(cause)}`;
                    await adapter.publishStatus(
                      input.sessionID,
                      directory,
                      text,
                    );
                    await ctx.session.synthetic({
                      sessionID: input.sessionID,
                      text,
                      description: brief(text),
                      resume: false,
                    });
                  }
                  return;
                }
                if (name === "ralph-resume") {
                  let text: string;
                  try {
                    text = await router.dispatch(
                      name,
                      input.prompt.text.trim(),
                      { workspace: directory, sessionId: input.sessionID },
                    );
                  } catch (cause) {
                    text = `Ralph resume blocked: ${String(cause)}`;
                  }
                  await adapter.publishStatus(input.sessionID, directory, text);
                  await ctx.session.synthetic({
                    sessionID: input.sessionID,
                    text,
                    description: brief(text),
                    resume: false,
                  });
                  return;
                }
                if (name === "ralph-remove") {
                  let text: string;
                  try {
                    text = await runRemovalCommand({
                      directory,
                      store,
                      sessionId: input.sessionID,
                      ask: (request) =>
                        requestNativeInput(ctx, request, eventsAbort.signal),
                    });
                  } catch (cause) {
                    text = `Ralph removal failed; nothing more was deleted: ${cause instanceof Error ? cause.message : String(cause)}`;
                  }
                  if (disposed) return;
                  await ctx.session.synthetic({
                    sessionID: input.sessionID,
                    text,
                    description: brief(text),
                    resume: false,
                  });
                  return;
                }
                const publish = async (text: string) => {
                  if (disposed) return;
                  await adapter.publishStatus(input.sessionID, directory, text);
                  await ctx.session.synthetic({
                    sessionID: input.sessionID,
                    text,
                    description: brief(text),
                    resume: false,
                  });
                };
                const execute = async () => {
                  const args = input.prompt.text.trim();
                  const text = await router.dispatch(name, args, {
                    workspace: directory,
                    sessionId: input.sessionID,
                  });
                  await publish(text);
                };
                await execute();
              },
            });
          }
        }),
      );
      // Tool transforms belong to a location. Bootstrap observations in each
      // child location; registering aliases only in the parent hides all tools.
      const localObservationTools = new Set([
        "read",
        "glob",
        "grep",
        "list",
        "http",
        "webfetch",
      ]);
      const canonicalDirectory = await realpath(directory);
      for (const run of await store.listRuns())
        for (const { envelope } of Object.values(run.jobs)) {
          if (
            envelope.readOnly &&
            (await realpath(envelope.workspace).catch(() => undefined)) ===
              canonicalDirectory
          )
            for (const tool of reviewTools(envelope))
              localObservationTools.add(tool);
        }
      registrations.push(
        await ctx.tool.transform((editor) => {
          addObservationAliases(editor, [...localObservationTools]);
          editor.add({
            name: "ralph_request_product_decision",
            description:
              "Ask the owning stage product question natively; revised explanations require separate scope approval.",
            input: productDecisionInput,
            options: { codemode: false },
            async execute(input, context) {
              context.signal.throwIfAborted();
              return {
                content: await relayingTool(context, () =>
                  requestProductDecision(
                    store,
                    adapter,
                    input,
                    context.sessionID,
                  ),
                ),
              };
            },
          });
          editor.add({
            name: "ralph_complete_interview",
            description:
              "Propose explanation, scope and criteria from the owning interview. Native human approval authorizes PRD creation, issue planning and implementation.",
            input: completeInterviewInput,
            options: { codemode: false },
            async execute(input, context) {
              context.signal.throwIfAborted();
              return {
                content: await relayingTool(context, () =>
                  completeInterview(store, adapter, input, context.sessionID),
                ),
              };
            },
          });
          editor.add({
            name: "ralph_complete_issues",
            description:
              "Validate the owning issue graph and files and execute from the pinned scope authorization.",
            input: completeIssuesInput,
            options: { codemode: false },
            async execute(input, context) {
              context.signal.throwIfAborted();
              return {
                content: JSON.stringify(
                  await completeIssues(
                    store,
                    adapter,
                    input,
                    context.sessionID,
                  ),
                ),
              };
            },
          });
          editor.add({
            name: "ralph_complete_prd",
            description:
              "Validate the owning written PRD, accept an immutable revision and hand off once to fresh issue planning.",
            input: completePrdInput,
            options: { codemode: false },
            async execute(input, context) {
              context.signal.throwIfAborted();
              return {
                content: JSON.stringify(
                  await completePrd(store, adapter, input, context.sessionID),
                ),
              };
            },
          });
          editor.add({
            name: "ralph_write_planning_file",
            description:
              "Write only the owning stage PRD.md or graph.json and numbered issue Markdown drafts.",
            input: planningFileInput,
            options: { codemode: false },
            async execute(input, context) {
              context.signal.throwIfAborted();
              return {
                content: JSON.stringify(
                  await writePlanningFile(store, input, context.sessionID),
                ),
              };
            },
          });
          editor.add({
            name: "ralph_save_commands",
            description:
              "Validate and save the project command configuration to .ralph/commands.json after the user approves your proposal. Does not execute commands. Read any existing file first; revision must increase by one (start at 1).",
            input: commandConfigSchema,
            options: { codemode: false },
            async execute(config, context) {
              context.signal.throwIfAborted();
              const result = await saveProjectCommands(
                directory,
                config,
                store,
                context.signal,
              );
              return { content: JSON.stringify(result) };
            },
          });
          editor.add({
            name: "ralph_status",
            description:
              "Read persisted Ralph phase, correlated job result, errors and dashboard URL.",
            input: z.object({ runId: z.string().optional() }),
            options: { codemode: false },
            async execute({ runId }) {
              return {
                content: await router.status(runId?.trim() || undefined),
              };
            },
          });
          editor.add({
            name: "ralph_control",
            description:
              "Pause, resume or stop a durable Ralph run. Use slash commands for explicit user intent.",
            input: z.object({
              action: z.enum(["pause", "resume", "stop"]),
              runId: z.string().optional(),
              selectedCommit: z.string().optional(),
              review: z.boolean().optional(),
            }),
            options: { codemode: false },
            async execute({ action, runId, selectedCommit, review }, context) {
              if (action === "resume") {
                if (review && selectedCommit)
                  throw new Error(
                    "Review-only retry cannot change the starting commit",
                  );
                return {
                  content: await router.resume(
                    runId,
                    { workspace: directory, sessionId: context.sessionID },
                    {
                      ...(selectedCommit ? { selectedCommit } : {}),
                      ...(review ? { review: true } : {}),
                    },
                  ),
                };
              }
              if (selectedCommit || review)
                throw new Error("Resume options require action=resume");
              return {
                content: await router.dispatch(
                  `ralph-${action}`,
                  runId?.trim() ?? "",
                  { workspace: directory, sessionId: context.sessionID },
                ),
              };
            },
          });
        }),
      );
      registrations.push(
        await ctx.session.hook("context", async (input) => {
          const owner = await interviewOwner(input.sessionID);
          if (owner) {
            const allowed = new Set([
              "read",
              "glob",
              "grep",
              "list",
              "question",
              "ralph_complete_interview",
              "ralph_request_product_decision",
              ...(owner.planning?.owner?.stage === "prd"
                ? ["ralph_write_planning_file", "ralph_complete_prd"]
                : owner.planning?.owner?.stage === "issues"
                  ? ["ralph_write_planning_file", "ralph_complete_issues"]
                  : []),
            ]);
            for (const name of Object.keys(input.tools))
              if (!allowed.has(name)) delete input.tools[name];
            return;
          }
          const entry = await sessionJob(input.sessionID);
          const job = entry?.envelope.readOnly ? entry.envelope : undefined;
          const allowed = job
            ? new Set([...reviewTools(job)].map(reviewToolAlias))
            : undefined;
          for (const name of Object.keys(input.tools)) {
            if (
              allowed
                ? !allowed.has(name)
                : name.startsWith("ralph_review_") ||
                  (!!entry &&
                    ["ralph_save_commands", "ralph_control"].includes(name))
            )
              delete input.tools[name];
          }
        }),
      );
      registrations.push(
        await ctx.tool.hook("execute.after", async (input) => {
          if (input.tool !== "question") return;
          const owner = await interviewOwner(input.sessionID);
          if (owner)
            await setPlanningQuestionWaiting(
              store,
              owner.runId,
              input.sessionID,
              String(input.id),
              false,
            );
          // Resolve after the waiting flag is cleared: both update planning state.
          const relay = relays.get(input.sessionID);
          if (relay && relay.callId === String(input.id)) {
            relays.delete(input.sessionID);
            const text =
              input.status === "completed"
                ? nativeAnswer(input.result.metadata)
                : undefined;
            relay.resolve(
              text
                ? {
                    ok: true,
                    source: "user",
                    requestId: relay.request.requestId,
                    revision: relay.request.revision,
                    sessionId: relay.request.sessionId,
                    messageId: `question:${String(input.id)}`,
                    text,
                  }
                : {
                    ok: false,
                    error: {
                      code:
                        input.status === "error"
                          ? "cancelled"
                          : "missing-output",
                      message:
                        input.status === "error"
                          ? "The question was dismissed without an answer"
                          : "Native question returned no single answer",
                    },
                  },
            );
          }
        }),
      );
      // Execution checks also cover tools reached through code mode or renamed
      // definitions. Never change a host denial into an allow.
      registrations.push(
        await ctx.tool.hook("execute.before", async (input) => {
          // The agent's question call carries Ralph's pending question; the
          // model cannot change its wording or options.
          if (input.tool === "question") {
            const relay = relays.get(input.sessionID);
            if (relay && !relay.callId) {
              relay.callId = String(input.id);
              input.input = nativeQuestionInput(relay.request);
            }
          }
          const owner = await interviewOwner(input.sessionID);
          if (owner) {
            const pendingNativeQuestion =
              input.tool === "question" &&
              owner.planning?.pending &&
              String(input.id) ===
                `ralph-input:${owner.planning.pending.requestId}`;
            if (
              !pendingNativeQuestion &&
              (owner.planning?.owner?.retired ||
                owner.planning?.owner?.sessionId !== input.sessionID)
            )
              throw new Error(
                "Retired Ralph planning session cannot execute tools",
              );
            if (input.tool === "question" && !pendingNativeQuestion)
              await setPlanningQuestionWaiting(
                store,
                owner.runId,
                input.sessionID,
                String(input.id),
                true,
              );
            if (owner.control && owner.control.status !== "active")
              throw new Error(
                "Ralph interview ownership is inactive; inspect /ralph-status.",
              );
            if (
              ![
                "read",
                "glob",
                "grep",
                "list",
                "question",
                "ralph_complete_interview",
                "ralph_request_product_decision",
                ...(owner.planning?.owner?.stage === "prd"
                  ? ["ralph_write_planning_file", "ralph_complete_prd"]
                  : owner.planning?.owner?.stage === "issues"
                    ? ["ralph_write_planning_file", "ralph_complete_issues"]
                    : []),
              ].includes(input.tool)
            )
              throw new Error(
                `Permission denied: Ralph interview cannot execute ${input.tool}`,
              );
            return;
          }
          const entry = await sessionJob(input.sessionID);
          const job = entry?.envelope;
          if (
            entry &&
            ["ralph_save_commands", "ralph_control"].includes(input.tool)
          )
            throw new Error(
              "Ralph administrative tools belong to the user's main chat, not worker agents.",
            );
          if (
            job?.readOnly &&
            !new Set([...reviewTools(job)].map(reviewToolAlias)).has(input.tool)
          )
            throw new Error(
              `Permission denied: Ralph review cannot execute ${input.tool}`,
            );
          // A background receipt is not completed validation and may outlive
          // the attempt. Keep owned agent commands inside the awaited turn.
          if (
            entry?.status === "running" &&
            !job?.readOnly &&
            input.tool === "shell" &&
            input.input &&
            typeof input.input === "object" &&
            "background" in input.input &&
            input.input.background === true
          )
            input.input = { ...input.input, background: false };
        }),
      );
      const events = ctx.event.subscribe({ signal: eventsAbort.signal });
      void (async () => {
        try {
          for await (const event of events) {
            if (disposed) break;
            // The TUI loads forms when a session opens; ask it to load forms
            // created while their session is already open.
            if (event.type === "form.created")
              await statusEvents?.events
                .emit("question", { sessionId: event.data.form.sessionID })
                .catch(() => {});
            await adapter.receiveEvent(event);
          }
        } catch (cause) {
          if (!eventsAbort.signal.aborted)
            console.error("Ralph event subscription failed", cause);
        }
      })();
      // Host activation must finish before emitting notifications.
      notification = setImmediate(async () => {
        if (disposed) return;
        const flush = () =>
          void progress.flush().catch((cause) => {
            if (!disposed)
              console.error(
                "Ralph progress delivery failed",
                sanitizeValue(
                  cause instanceof Error ? cause.message : String(cause),
                  runtimeSecretValues(),
                ).slice(0, 1000),
              );
          });
        flush();
        progressTimer = setInterval(flush, 250);
        progressTimer.unref();
        for (const text of recoveryNotifications) {
          if (disposed) break;
          await adapter.publishStatus("", directory, text);
        }
      });
      notification.unref();
      return dispose;
    } catch (cause) {
      await dispose();
      throw cause;
    }
  },
});
export default RalphPlugin;
