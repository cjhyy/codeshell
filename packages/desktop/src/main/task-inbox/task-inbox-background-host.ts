import {
  cancelBackgroundWorkForUI,
  listBackgroundWorkForUI,
} from "@cjhyy/code-shell-core/internal";
import type { AgentBridge } from "../agent-bridge.js";
import type { TaskInboxBackgroundEntry, TaskInboxSourcesDeps } from "./task-inbox-sources.js";

/** Native worker and external-runtime tools own independent process registries. */
export function createTaskInboxBackgroundHost(options: {
  worker(): Pick<AgentBridge, "hasLiveWorker" | "requestWorker"> | null;
  readMain?: typeof listBackgroundWorkForUI;
  cancelMain?: typeof cancelBackgroundWorkForUI;
}): NonNullable<TaskInboxSourcesDeps["background"]> {
  return {
    available: () => true,
    list: async () => {
      const main: TaskInboxBackgroundEntry[] = (options.readMain ?? listBackgroundWorkForUI)(
        "task-inbox",
        { scope: "all" },
      ).map((entry) => ({ ...entry, executionOrigin: "main" as const }));
      const worker = options.worker();
      if (!worker?.hasLiveWorker()) return main;
      const result = await worker.requestWorker(
        "agent/backgroundWork",
        { sessionId: "task-inbox", scope: "all" },
        5_000,
        {
          failFast: true,
          settleOnExit: true,
          meta: { origin: "host", producer: "task-inbox" },
        },
      );
      if (!result.ok) throw new Error(result.message);
      const value = result.result as { items?: TaskInboxBackgroundEntry[] };
      if (!Array.isArray(value?.items)) throw new Error("Invalid background task snapshot");
      return [
        ...main,
        ...value.items.map((entry) => ({ ...entry, executionOrigin: "worker" as const })),
      ];
    },
    cancel: async (entry) => {
      const params = {
        sessionId: entry.sourceSession.sessionId,
        kind: entry.kind,
        workId:
          entry.kind === "shell"
            ? entry.shell.shellId
            : entry.kind === "subagent"
              ? entry.agentId
              : entry.jobId,
        expectedStartedAt: entry.kind === "shell" ? entry.shell.startedAt : entry.startedAt,
        ...(entry.kind === "subagent"
          ? { expectedRuntimeGeneration: entry.runtimeGeneration }
          : {}),
      };
      if (entry.executionOrigin === "main")
        return (options.cancelMain ?? cancelBackgroundWorkForUI)(params);
      if (entry.executionOrigin !== "worker") return false;
      const worker = options.worker();
      if (!worker?.hasLiveWorker()) return false;
      const result = await worker.requestWorker("agent/backgroundWorkCancel", params, 15_000, {
        failFast: true,
        settleOnExit: true,
        meta: { origin: "host", producer: "task-inbox" },
      });
      if (!result.ok) throw new Error(result.message);
      return (result.result as { cancelled?: boolean })?.cancelled === true;
    },
  };
}
