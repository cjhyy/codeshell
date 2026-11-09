/**
 * Worker runtime for isolated Panel agent tasks (`agent.task.*`): starts the
 * isolated worker run, translates its session stream into task progress, and
 * cancels/closes/rebinds the worker session. Task bookkeeping and ownership
 * stay in PanelAppAgentTaskService / PanelAgentTaskOwnership.
 */
import type {
  PanelAgentTaskProgressInput,
  PanelAgentTaskRuntime,
} from "./panel-app-agent-task-service.js";
import type { AgentBridge } from "./agent-bridge.js";
import { PANEL_AGENT_RUN_TIMEOUT_MS } from "./panel-app-bridge-support.js";

export function panelAgentTaskProgress(event: unknown): {
  progress?: PanelAgentTaskProgressInput;
  error?: string;
} {
  const stream = event as Record<string, unknown> | null;
  switch (stream?.type) {
    case "session_started":
      return {
        progress: { kind: "model", status: "running", message: "Task started" },
      };
    case "stream_request_start":
      return {
        progress: {
          kind: "model",
          status: "running",
          message: "AI is planning the next step",
        },
      };
    case "text_delta":
    case "assistant_message":
      return {
        progress: {
          kind: "model",
          status: "running",
          message: "AI is preparing the result",
        },
      };
    case "tool_use_start": {
      const toolCall = stream.toolCall as Record<string, unknown> | undefined;
      const toolName = typeof toolCall?.toolName === "string" ? toolCall.toolName : "Tool";
      return {
        progress: {
          kind: "tool",
          status: "running",
          message: `Running ${toolName}`,
          toolName,
        },
      };
    }
    case "tool_result": {
      const result = stream.result as Record<string, unknown> | undefined;
      const toolName = typeof result?.toolName === "string" ? result.toolName : "Tool";
      return {
        progress: {
          kind: "tool",
          status: "completed",
          message: `${toolName} returned`,
          toolName,
        },
      };
    }
    case "task_update": {
      const tasks = Array.isArray(stream.tasks) ? stream.tasks : [];
      const current = tasks.find(
        (task) => (task as Record<string, unknown> | null)?.status === "in_progress",
      ) as Record<string, unknown> | undefined;
      const subject = typeof current?.subject === "string" ? current.subject.trim() : "";
      return subject
        ? {
            progress: {
              kind: "plan",
              status: "running",
              message: subject,
            },
          }
        : {};
    }
    case "error": {
      const error = typeof stream.error === "string" ? stream.error.trim() : "Task failed";
      return {
        error,
        progress: { kind: "error", status: "failed", message: error },
      };
    }
    case "turn_complete":
      return stream.reason === "completed"
        ? {
            progress: { kind: "model", status: "completed", message: "Task completed" },
          }
        : {};
    default:
      return {};
  }
}

export function createPanelAgentTaskRuntime(deps: {
  getAgentBridge(): AgentBridge | null;
  /** Registers the run with PanelAgentTaskOwnership; returns its release. */
  trackOwnership(sessionId: string, bridge: AgentBridge): () => void;
}): PanelAgentTaskRuntime {
  return {
    run: async (input) => {
      const bridge = deps.getAgentBridge();
      if (!bridge) throw new Error("agent worker is unavailable");
      bridge.reserveHostSession(
        input.sessionId,
        input.owner.cwd,
        "panel-agent-task",
        input.owner.projectPath,
      );
      bridge.rebindHostSessionBucket(input.sessionId, input.owner.bucket);
      bridge.claimSessionPanelOwner(input.sessionId, input.owner.ownerWebContentsId);
      let latestError = "";
      const unsubscribe = bridge.subscribeOutbound((_line, snapshotEntry) => {
        if (!snapshotEntry || snapshotEntry.sessionId !== input.sessionId) return;
        const update = panelAgentTaskProgress(snapshotEntry.event);
        if (update.error) latestError = update.error;
        if (update.progress) input.onProgress(update.progress);
      });
      let releaseOwnership: (() => void) | undefined;
      try {
        const pending = bridge.requestWorker(
          "agent/run",
          {
            task: input.prompt,
            modelTraceSource: `panel:${input.owner.appId}`,
            displayText: input.label,
            clientMessageId: `panel-task:${input.owner.appId}:${input.sessionId}`,
            sessionId: input.sessionId,
            cwd: input.owner.cwd,
            bucket: input.owner.bucket,
            behaviorMode: "isolatedTask",
            ephemeral: true,
            ...(input.model ? { model: input.model } : {}),
            toolAllowlist: input.toolNames,
            skillAllowlist: input.skillNames,
            maxTurns: input.maxTurns,
            maxContextTokens: input.maxContextTokens,
          },
          PANEL_AGENT_RUN_TIMEOUT_MS,
          {
            settleOnExit: true,
            failFast: true,
            meta: { origin: "host", producer: "panel-agent-task" },
          },
        );
        // requestWorker synchronously ensures/spawns the worker before returning
        // its Promise. Capture that generation before any worker reply can arrive.
        releaseOwnership = deps.trackOwnership(input.sessionId, bridge);
        const response = await pending;
        if (!response.ok) throw new Error(response.message);
        const result = (response.result ?? {}) as {
          text?: unknown;
          reason?: unknown;
          usage?: {
            promptTokens?: unknown;
            completionTokens?: unknown;
            totalTokens?: unknown;
          };
        };
        const usage = result.usage;
        return {
          text: typeof result.text === "string" ? result.text : "",
          ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
          ...(latestError ? { error: latestError } : {}),
          ...(usage &&
          typeof usage.promptTokens === "number" &&
          typeof usage.completionTokens === "number" &&
          typeof usage.totalTokens === "number"
            ? {
                usage: {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                },
              }
            : {}),
        };
      } finally {
        releaseOwnership?.();
        unsubscribe();
      }
    },
    cancel: async (sessionId) => {
      const bridge = deps.getAgentBridge();
      if (!bridge) throw new Error("agent worker is unavailable");
      const response = await bridge.requestWorker("agent/cancel", { sessionId }, 30_000, {
        settleOnExit: true,
        failFast: true,
        meta: { origin: "host", producer: "panel-agent-cancel" },
      });
      if (!response.ok) throw new Error(response.message);
    },
    close: async (sessionId) => {
      const bridge = deps.getAgentBridge();
      if (!bridge) return;
      try {
        await bridge.closeSession(sessionId);
      } finally {
        bridge.forgetSession(sessionId);
      }
    },
    rebind: (sessionId, owner) => {
      const bridge = deps.getAgentBridge();
      if (!bridge) return;
      bridge.rebindHostSessionBucket(sessionId, owner.bucket);
      bridge.claimSessionPanelOwner(sessionId, owner.ownerWebContentsId);
    },
  };
}
