import type { StreamEvent, TokenUsage } from "../../types.js";
import type { AgentProgressPhase, ProgressPayload } from "./agent-notifications.js";

function safeSummary(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function initialAgentProgress(now = Date.now()): ProgressPayload {
  return {
    phase: "starting",
    tokens: { prompt: 0, completion: 0, total: 0 },
    summary: "正在启动",
    observedAt: now,
  };
}

export function reduceAgentProgress(
  previous: ProgressPayload,
  event: StreamEvent,
  now = Date.now(),
): ProgressPayload {
  if (event.type === "stream_request_start") {
    return { ...previous, phase: "model", summary: "模型处理中", observedAt: now };
  }
  if (event.type === "tool_use_start") {
    const name = safeSummary(event.toolCall.toolName) || "tool";
    return {
      ...previous,
      phase: "tool",
      lastTool: { name, state: "running", startedAt: now },
      summary: safeSummary(`正在运行 ${name}`),
      observedAt: now,
    };
  }
  if (event.type === "tool_result") {
    const aborted = /abort/i.test(event.result.error ?? "");
    const state = aborted
      ? "aborted"
      : event.result.error || event.result.isError
        ? "failed"
        : "completed";
    const name = safeSummary(event.result.toolName) || previous.lastTool?.name || "tool";
    return {
      ...previous,
      phase: "tool",
      lastTool: {
        name,
        state,
        startedAt: previous.lastTool?.startedAt,
        finishedAt: now,
      },
      summary: safeSummary(`${name} ${state}`),
      observedAt: now,
    };
  }
  if (event.type === "context_compact") {
    return { ...previous, phase: "compacting", summary: "正在压缩上下文", observedAt: now };
  }
  return previous;
}

export function applyAgentProgressUsage(
  previous: ProgressPayload,
  usage: TokenUsage,
  now = Date.now(),
): ProgressPayload {
  const prompt = previous.tokens.prompt + (usage.promptTokens ?? 0);
  const completion = previous.tokens.completion + (usage.completionTokens ?? 0);
  return {
    ...previous,
    tokens: { prompt, completion, total: prompt + completion },
    observedAt: now,
  };
}

export function applyAgentProgressPhase(
  previous: ProgressPayload,
  phase: AgentProgressPhase,
  now = Date.now(),
  toolName?: string,
): ProgressPayload {
  const name = toolName ? safeSummary(toolName) : undefined;
  const summary =
    phase === "starting"
      ? "正在启动"
      : phase === "model"
        ? "模型处理中"
        : phase === "tool"
          ? name
            ? `正在运行 ${name}`
            : "工具批次处理中"
          : phase === "waiting-permission"
            ? name
              ? `等待用户批准 ${name}`
              : "等待用户批准"
            : phase === "compacting"
              ? "正在压缩上下文"
              : "正在收尾";
  return { ...previous, phase, summary: safeSummary(summary), observedAt: now };
}
