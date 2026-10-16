import { expect, test } from "bun:test";
import RalphTui from "../../src/tui.js";

test("TUI shows scoped status, ignores question forms, and registers no answer command", () => {
  let listener: ((event: unknown) => void) | undefined;
  const toasts: unknown[] = [];
  let keymapUsed = false;
  const dispose = RalphTui.setup({
    location: { directory: "/project" },
    keymap: {
      layer: () => {
        keymapUsed = true;
      },
    },
    ui: {
      toast: {
        show: (toast: unknown) => {
          toasts.push(toast);
        },
      },
    },
    data: {
      listen: (next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  } as never);
  listener?.({ details: { type: "form.created", data: { form: {} } } });
  listener?.({
    details: {
      type: "rpc.ralph.status",
      location: { directory: "/other" },
      data: { text: "Other project" },
    },
  });
  expect(toasts).toEqual([]);
  listener?.({
    details: {
      type: "rpc.ralph.status",
      location: { directory: "/project" },
      data: { text: "Stopped" },
    },
  });
  expect(toasts).toEqual([
    { title: "Ralph status", message: "Stopped", variant: "info" },
  ]);
  expect(keymapUsed).toBe(false);
  if (typeof dispose === "function") dispose();
  expect(listener).toBeUndefined();
});

test("TUI follows only matching stage locations once, with router fallback when tabs are disabled", () => {
  let listener: ((event: unknown) => void) | undefined;
  const focused: string[] = [];
  const navigated: unknown[] = [];
  const dispose = RalphTui.setup({
    location: { directory: "/project" },
    ui: {
      tabs: {
        focus: (id: string) => {
          focused.push(id);
          return false;
        },
      },
      router: { navigate: (route: unknown) => navigated.push(route) },
    },
    data: {
      listen: (next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  } as never);
  const event = (directory?: string) => ({
    details: {
      type: "rpc.ralph.stageSession",
      ...(directory ? { location: { directory } } : {}),
      data: {
        runId: "r",
        stage: "interview",
        sessionId: "interview-1",
        attempt: 1,
        revision: 1,
      },
    },
  });
  listener?.(event("/other"));
  listener?.(event());
  expect(focused).toEqual([]);
  listener?.(event("/project"));
  listener?.(event("/project"));
  expect(focused).toEqual(["interview-1"]);
  expect(navigated).toEqual([{ type: "session", sessionID: "interview-1" }]);
  const issueEvent = event("/project");
  issueEvent.details.data.stage = "issues";
  issueEvent.details.data.revision = 2;
  issueEvent.details.data.sessionId = "issues-1";
  listener?.(issueEvent);
  listener?.(issueEvent);
  expect(focused).toEqual(["interview-1", "issues-1"]);
  expect(navigated).toEqual([
    { type: "session", sessionID: "interview-1" },
    { type: "session", sessionID: "issues-1" },
  ]);
  issueEvent.details.data.revision = 3;
  issueEvent.details.data.attempt = 2;
  issueEvent.details.data.sessionId = "issues-retry";
  listener?.(issueEvent);
  listener?.(issueEvent);
  expect(focused).toEqual(["interview-1", "issues-1", "issues-retry"]);
  listener?.(event("/project"));
  expect(focused).toEqual(["interview-1", "issues-1", "issues-retry"]);
  issueEvent.details.data.revision = 4;
  issueEvent.details.data.attempt = 0;
  issueEvent.details.data.sessionId = "invalid";
  listener?.(issueEvent);
  expect(focused).not.toContain("invalid");
  if (typeof dispose === "function") dispose();
});
