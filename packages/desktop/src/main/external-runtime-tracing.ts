import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sessionsRoot, type StreamEvent, type TerminalReason } from "@cjhyy/code-shell-core";
import {
  recordExternalModelTrace,
  recordModelTraceEvent,
  withModelTraceContext,
  ModelTraceStore,
  type ModelTraceEvent,
  type ModelTraceStatus,
} from "@cjhyy/code-shell-core/internal";
import type {
  ExternalRuntimeKind,
  ExternalRuntimeTurnInput,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";

// Leave a value larger than Core's content cap so it preserves the truncated state.
const MAX_OUTPUT = 128 * 1024;
const MAX_TOOLS = 128;

function statusFor(reason?: TerminalReason): ModelTraceStatus {
  if (reason?.startsWith("aborted_") || reason === "hook_stopped") return "cancelled";
  if (reason === "model_error" || reason === "replay_incomplete" || reason === "image_error")
    return "failed";
  return "completed";
}

/**
 * The Host knows the input submitted to the CLI and its emitted events. The CLI's
 * private instructions, history, provider retries and final HTTP payload are opaque.
 */
export function startExternalRuntimeTrace(options: {
  sessionId: string;
  runId: string;
  workspacePath: string;
  kind: ExternalRuntimeKind;
  model?: string;
  input: ExternalRuntimeTurnInput;
  developerInstructions: string;
  initialContext?: string;
  storageDir?: string;
  source?: string;
}) {
  const context = {
    storageDir: options.storageDir ?? join(sessionsRoot(), ".model-traces"),
    workspacePath: options.workspacePath,
    sessionId: options.sessionId,
    runId: options.runId,
    source:
      options.source && /^panel:[a-z][a-z0-9-]{0,63}$/.test(options.source)
        ? options.source
        : `desktop-${options.kind}-cli`,
    purpose: "external-runtime",
  };
  const startedAt = Date.now();
  const common = {
    ...context,
    provider: options.kind,
    // A CLI default is opaque to the Host; avoid inventing a provider model id.
    model: options.model ?? "CLI default",
    startedAt,
  };
  const initial = recordExternalModelTrace({
    ...common,
    status: "running",
    input: {
      messages: [{ role: "user", content: options.input.text }],
      parameters: {
        developerInstructions: options.developerInstructions,
        sessionInitialContext: options.initialContext,
        attachments: options.input.attachments,
        injected: options.input.injected ?? false,
        coverage: "external-cli-input",
      },
    },
  });
  if (!initial) return undefined;
  // Enabling capture during a turn cannot recover content that was not captured.
  const capture = initial.inputState !== "not-recorded";
  const store = new ModelTraceStore({ storageDir: context.storageDir });
  const policyRevision = store.getConfig().policyRevision;
  const contentEnabled = () => {
    try {
      const config = store.getConfig();
      return (
        capture &&
        config.enabled &&
        config.captureContent &&
        config.policyRevision === policyRevision
      );
    } catch {
      return false;
    }
  };
  let text = "";
  let thinking = "";
  let error: string | undefined;
  let terminal: TerminalReason | undefined;
  let finished = false;
  const tools = new Map<string, ModelTraceEvent>();
  // Claimed by the trusted Host invocation, never inferred from tool names or
  // argument contents. Its ToolExecutor already records the canonical span.
  const hostTools = new Set<string>();
  const span = (input: Parameters<typeof recordModelTraceEvent>[0]) =>
    withModelTraceContext(context, () =>
      recordModelTraceEvent({
        ...input,
        ...(!contentEnabled()
          ? {
              inputState: "not-recorded",
              outputState: "not-recorded",
              error: input.error ? "External CLI operation failed" : undefined,
            }
          : {}),
      }),
    );

  return {
    async runHostTool<T>(toolCallId: string, operation: () => Promise<T>): Promise<T> {
      if (!finished) hostTools.add(toolCallId);
      try {
        return await withModelTraceContext(context, operation);
      } finally {
        hostTools.delete(toolCallId);
      }
    },
    observe(event: StreamEvent) {
      if (finished) return;
      switch (event.type) {
        case "text_delta":
          if (contentEnabled()) text = (text + event.text).slice(0, MAX_OUTPUT);
          else if (capture && !text.endsWith("[Content capture paused]"))
            text = (text + "\n[Content capture paused]").slice(0, MAX_OUTPUT);
          break;
        case "thinking_delta":
          if (contentEnabled()) thinking = (thinking + event.text).slice(0, MAX_OUTPUT);
          else if (capture && !thinking.endsWith("[Content capture paused]"))
            thinking = (thinking + "\n[Content capture paused]").slice(0, MAX_OUTPUT);
          break;
        case "error":
          error = contentEnabled()
            ? event.error.slice(0, MAX_OUTPUT)
            : "External CLI request failed";
          break;
        case "turn_complete":
          terminal = event.reason;
          // Some CLIs supply only a terminal full response, without deltas.
          if (contentEnabled() && !text && event.text) text = event.text.slice(0, MAX_OUTPUT);
          break;
        case "tool_use_start": {
          if (hostTools.has(event.toolCall.id)) break;
          if (tools.size >= MAX_TOOLS) break;
          const tool = span({
            id: randomUUID(),
            first: true,
            kind: "tool",
            name: event.toolCall.toolName,
            startedAt: Date.now(),
            status: "running",
            input: event.toolCall.args,
          });
          if (tool) tools.set(event.toolCall.id, tool);
          break;
        }
        case "tool_use_args_delta": {
          const tool = tools.get(event.toolCallId);
          if (!tool) break;
          const updated = span({ ...tool, input: event.args, inputState: undefined });
          if (updated) tools.set(event.toolCallId, updated);
          break;
        }
        case "tool_result": {
          const tool = tools.get(event.result.id);
          if (!tool) break;
          span({
            ...tool,
            endedAt: Date.now(),
            status: event.result.error || event.result.isError ? "failed" : "completed",
            output: event.result.sensitive
              ? (event.result.transcriptResult ??
                event.result.displayResult ??
                "[Sensitive tool output omitted]")
              : (event.result.result ?? event.result.displayResult),
            error: event.result.sensitive ? undefined : event.result.error,
            outputState: undefined,
          });
          tools.delete(event.result.id);
          break;
        }
        case "usage_update":
          // CLI usage may be a session snapshot; do not label it per-provider usage.
          span({
            kind: "lifecycle",
            name: "External CLI usage snapshot",
            startedAt: Date.now(),
            status: "completed",
            output: event,
          });
          break;
      }
    },
    finish(reason?: TerminalReason) {
      if (finished) return;
      finished = true;
      const endedAt = Date.now();
      const finalReason = reason ?? (error ? "model_error" : (terminal ?? "completed"));
      const status = statusFor(finalReason);
      for (const tool of tools.values()) {
        span({ ...tool, endedAt, status: status === "failed" ? "failed" : "cancelled" });
      }
      tools.clear();
      hostTools.clear();
      recordExternalModelTrace({
        ...common,
        id: initial.id,
        endedAt,
        status,
        error,
        output: capture ? { text, thinking, stopReason: finalReason } : undefined,
      });
    },
  };
}
