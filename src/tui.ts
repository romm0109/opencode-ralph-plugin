import { define } from "@opencode/plugin/tui/plugin";

export default define({
  id: "ralph",
  setup(ctx) {
    const followed = new Set<string>();
    const revisions = new Map<string, number>();
    const unsubscribe = ctx.data.listen(({ details }) => {
      if (
        !["rpc.ralph.status", "rpc.ralph.stageSession"].includes(details.type)
      )
        return;
      if (
        !ctx.location ||
        details.location?.directory !== ctx.location.directory
      )
        return;
      const data = details.data as Record<string, unknown> | undefined;
      if (details.type === "rpc.ralph.stageSession") {
        if (
          !ctx.location ||
          details.location?.directory !== ctx.location.directory ||
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          typeof data.sessionId !== "string" ||
          typeof data.runId !== "string" ||
          !["interview", "issues"].includes(String(data.stage)) ||
          !Number.isSafeInteger(data.attempt) ||
          Number(data.attempt) < 1 ||
          !Number.isSafeInteger(data.revision) ||
          Number(data.revision) < 1
        )
          return;
        const revision = Number(data.revision);
        if (revision <= (revisions.get(data.runId) ?? 0)) return;
        revisions.set(data.runId, revision);
        const key = `${data.runId}:${data.stage}:${data.attempt}:${data.sessionId}`;
        if (followed.has(key)) return;
        followed.add(key);
        if (!ctx.ui.tabs.focus(data.sessionId))
          ctx.ui.router.navigate({
            type: "session",
            sessionID: data.sessionId,
          });
        return;
      }
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        typeof data.text !== "string"
      )
        return;
      ctx.ui.toast.show({
        title: "Ralph status",
        message: data.text,
        variant: "info",
      });
    });
    return () => {
      unsubscribe();
    };
  },
});
