import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { CommandContext } from "../cli/commands/registry.js";
import { CommandRegistry } from "../cli/commands/registry.js";
import { Box, Text } from "../render/index.js";
import { canExecuteGoalCommandWhileRunning } from "../cli/commands/builtin/goal-command.js";
import { AgentBlockEnd, AgentBlockStart } from "./components/AgentBlock.js";
import {
  ContextLimitMessage,
  ErrorMessage,
  MessageContent,
  RateLimitMessage,
  ThinkingMessage,
  UserMessage,
} from "./components/MessageContent.js";
import { ToolCallResult, ToolCallRunning, ToolCallStart } from "./components/ToolCall.js";
import type { ChatEntry } from "./store.js";

const STREAM_DIAG_ON = process.env.CODESHELL_DEBUG_STREAM === "1";
const HIGH_FREQUENCY_STREAM_EVENTS = new Set<StreamEvent["type"]>([
  "text_delta",
  "thinking_delta",
  "tool_use_args_delta",
]);

export function shouldTraceStreamEvent(type: StreamEvent["type"]): boolean {
  return STREAM_DIAG_ON || !HIGH_FREQUENCY_STREAM_EVENTS.has(type);
}

export function streamDiagnosticsEnabled(): boolean {
  return STREAM_DIAG_ON;
}

export function shouldAppendThinkingDeltaToMainFeed(agentId: string | undefined): boolean {
  return agentId === undefined;
}

export function shouldDrainBackgroundNotifications(opts: {
  notificationCount: number;
  isQueryActive: boolean;
  queryGuardBusy: boolean;
  input: string;
  overlayOpen: boolean;
  sessionId: string | undefined;
}): boolean {
  if (opts.notificationCount === 0) return false;
  if (opts.isQueryActive || opts.queryGuardBusy) return false;
  if (opts.input.trim() !== "") return false;
  if (opts.overlayOpen) return false;
  return typeof opts.sessionId === "string" && opts.sessionId.length > 0;
}

export function canExecuteCommandWhileRunning(input: string): boolean {
  const [head = "", ...rest] = input.trim().split(/\s+/);
  const normalizedHead = head.toLowerCase();
  if (normalizedHead === "/sid" || normalizedHead === "/help") return true;
  return normalizedHead === "/goal" && canExecuteGoalCommandWhileRunning(rest.join(" "));
}

export function goalEventMatchesActive(
  activeGoalId: string | null,
  activeRevision: number | null,
  eventGoalId: string | undefined,
  eventRevision: number | undefined,
): boolean {
  if ((eventGoalId ?? null) !== activeGoalId) return false;
  if (activeRevision === null && eventRevision === undefined) return true;
  return activeRevision !== null && eventRevision === activeRevision;
}

export function shouldApplyGoalUpdateEvent(
  activeGoalId: string | null,
  activeRevision: number | null,
  eventGoalId: string | undefined,
  eventRevision: number | undefined,
): boolean {
  if (activeGoalId !== null && eventGoalId !== activeGoalId) return false;
  if (activeRevision !== null && (eventRevision === undefined || eventRevision < activeRevision)) {
    return false;
  }
  return true;
}

export function goalUpdateResponseIsFresh(
  activeGoalId: string | null,
  activeRevision: number | null,
  responseGoalId: string | undefined,
  responseRevision: number | undefined,
): boolean {
  if (!activeGoalId || !responseGoalId || responseGoalId !== activeGoalId) return false;
  if (responseRevision === undefined) return false;
  return activeRevision === null || responseRevision >= activeRevision;
}

const CANCELLED_RUN_LIFECYCLE_EVENTS = new Set<StreamEvent["type"]>([
  "session_started",
  "turn_complete",
  "goal_set",
  "goal_updated",
  "goal_cleared",
  "goal_progress",
]);

export function shouldSuppressCancelledMainStreamEvent(
  cancelledRunPending: boolean,
  event: StreamEvent,
): boolean {
  return (
    cancelledRunPending &&
    (event as { agentId?: string }).agentId === undefined &&
    !CANCELLED_RUN_LIFECYCLE_EVENTS.has(event.type)
  );
}

export function formatCommandError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function dispatchSlashCommandSafely(
  registry: Pick<CommandRegistry, "dispatch">,
  cmd: string,
  cmdCtx: CommandContext,
  addStatus: (status: string) => void,
): void {
  try {
    void Promise.resolve(registry.dispatch(cmd, cmdCtx)).catch((error) => {
      addStatus(`Command failed: ${formatCommandError(error)}`);
    });
  } catch (error) {
    addStatus(`Command failed: ${formatCommandError(error)}`);
  }
}

export function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

export function friendlyReason(reason: string): string {
  switch (reason) {
    case "aborted_streaming":
    case "aborted_tools":
      return "已中断";
    case "model_error":
      return "模型调用失败 — 检查网络 / API key / 配额后重试";
    case "prompt_too_long":
      return "上下文超长 — 用 /compact 压缩,或开新会话";
    case "max_turns":
      return "达到最大回合数 — 可继续输入推进";
    case "goal_budget_exhausted":
      return "目标预算已耗尽 — 调高 token/时间预算后重试";
    case "hook_stopped":
    case "stop_hook_prevented":
      return "被 hook 拦截 — 检查 settings.json 中的 hook 配置";
    case "image_error":
      return "图片处理失败";
    case "completed":
      return "";
    default:
      return reason;
  }
}

export function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("aborted") || m.includes("abort")) return "已中断";
  if (m.includes("401") || m.includes("unauthorized") || m.includes("invalid api key")) {
    return "API key 无效或已过期 — 检查 /providers";
  }
  if (m.includes("429") || m.includes("rate limit") || m.includes("quota")) {
    return "触发限流 / 配额耗尽 — 稍后再试,或切换模型";
  }
  if (m.includes("timeout") || m.includes("etimedout") || m.includes("econnreset")) {
    return "网络超时 — 检查连接后重试";
  }
  if (m.includes("enotfound") || m.includes("getaddrinfo")) {
    return "无法解析模型服务地址 — 检查 DNS / 代理设置";
  }
  if (m.includes("context length") || m.includes("maximum context") || m.includes("too long")) {
    return "上下文超长 — 用 /compact 压缩,或开新会话";
  }
  return msg;
}

export function ModeIndicator({ mode }: { mode: "plan" | "normal" | "bypass" }) {
  const display = {
    plan: { symbol: "⏵  ", title: "plan  read-only", color: "ansi:yellow" },
    normal: { symbol: "⏵⏵ ", title: "auto-accept edits", color: "ansi:cyan" },
    bypass: { symbol: "⏵⏵⏵", title: "bypass permissions", color: "ansi:red" },
  }[mode];
  return (
    <Box>
      <Text color={display.color}>{display.symbol}</Text>
      <Text dim>{" " + display.title + " "}</Text>
      <Text dim>{"(shift+tab)"}</Text>
    </Box>
  );
}

export function classifyError(error: string): import("./store.js").ErrorKind {
  const lower = error.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  ) {
    return "rate_limit";
  }
  if (
    lower.includes("context") &&
    (lower.includes("limit") || lower.includes("too long") || lower.includes("too many tokens"))
  ) {
    return "context_limit";
  }
  if (
    lower.includes("invalid") &&
    (lower.includes("api key") || lower.includes("api_key") || lower.includes("authentication"))
  ) {
    return "invalid_api_key";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) return "api_timeout";
  if (lower.includes("credit") || lower.includes("balance") || lower.includes("billing")) {
    return "credit_balance";
  }
  return "generic";
}

export function renderEntry(entry: ChatEntry, key: string, expanded = false) {
  const nested = !!(entry as { agentId?: string }).agentId;

  switch (entry.type) {
    case "user":
      return <UserMessage key={key} text={entry.text} />;
    case "assistant_text":
      return nested ? (
        <Box key={key} marginLeft={1}>
          <Text dim>│ ⎿ </Text>
          <MessageContent text={entry.text} streaming={entry.streaming} nested />
        </Box>
      ) : (
        <MessageContent key={key} text={entry.text} streaming={entry.streaming} />
      );
    case "thinking":
      if (!nested) return null;
      return (
        <Box key={key} marginLeft={1}>
          <Text dim>│ ⎿ </Text>
          <ThinkingMessage content={entry.content} collapsed={!expanded} nested />
        </Box>
      );
    case "tool_start":
      return (
        <ToolCallStart key={key} toolName={entry.toolName} args={entry.args} nested={nested} />
      );
    case "tool_running":
      return <ToolCallRunning key={key} toolName={entry.toolName} nested={nested} />;
    case "tool_result":
      return (
        <ToolCallResult
          key={key}
          toolName={entry.toolName}
          result={entry.result}
          error={entry.error}
          nested={nested}
          expanded={expanded}
          compact={entry.compact}
        />
      );
    case "agent_start":
      return (
        <AgentBlockStart
          key={key}
          name={entry.name}
          agentType={entry.agentType}
          description={entry.description}
          running
        />
      );
    case "agent_end":
      return (
        <AgentBlockEnd
          key={key}
          name={entry.name}
          agentType={entry.agentType}
          description={entry.description}
          text={entry.text}
          error={entry.error}
        />
      );
    case "error": {
      const kind = entry.errorKind;
      if (kind === "rate_limit") return <RateLimitMessage key={key} text={entry.error} />;
      if (kind === "context_limit") return <ContextLimitMessage key={key} />;
      return (
        <Box key={key} marginLeft={nested ? 1 : 0}>
          {nested && <Text dim>│ ⎿ </Text>}
          <ErrorMessage error={entry.error} nested={nested} />
        </Box>
      );
    }
    case "system":
      if (entry.subtype === "compact_boundary") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text dim>{entry.text ?? "── context compacted ──"}</Text>
          </Box>
        );
      }
      if (entry.subtype === "memory_saved") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text color="ansi:magenta">{"✦ "}</Text>
            <Text dim>{entry.text ?? "Memory saved"}</Text>
          </Box>
        );
      }
      if (entry.subtype === "bg_agent_notification") {
        return (
          <Box key={key} flexDirection="column" marginLeft={1} marginTop={1}>
            {(entry.text ?? "").split("\n").map((line, index) => (
              <Text key={index} dim>
                {line}
              </Text>
            ))}
          </Box>
        );
      }
      return (
        <Box key={key} marginLeft={1} marginTop={1}>
          <Text dim>{entry.text ?? ""}</Text>
        </Box>
      );
    case "status":
      return (
        <Box key={key} marginLeft={1} marginTop={1}>
          <Text dim>{entry.reason}</Text>
        </Box>
      );
  }
}
