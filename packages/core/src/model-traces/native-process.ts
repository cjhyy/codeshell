import { StringDecoder } from "node:string_decoder";
import { createNativeModelTraceFrameDecoder } from "./native-frames.js";
import type { TokenUsage } from "../types.js";
import type { ExternalModelTraceInput, ModelTraceContext, ModelTraceRecord } from "./types.js";

function validUsage(value: TokenUsage | undefined): value is TokenUsage {
  return (
    !!value &&
    [
      value.promptTokens,
      value.completionTokens,
      value.totalTokens,
      value.cacheReadTokens ?? 0,
      value.cacheCreationTokens ?? 0,
    ].every((count) => Number.isSafeInteger(count) && count >= 0)
  );
}

/** Bounded, write-only inference observations; the launcher supplies every scope field. */
export function createNativeModelTraceChannel(options: {
  context: ModelTraceContext;
  source: string;
  record(input: ExternalModelTraceInput): ModelTraceRecord | null;
}) {
  const context = options.context;
  const active = new Map<string, ExternalModelTraceInput | null>();
  const seen = new Set<string>();
  const decoder = new StringDecoder("utf8");
  const frames = createNativeModelTraceFrameDecoder();
  let pending = "",
    bytes = 0,
    closed = false;
  const settle = (key: string, message: Record<string, any>) => {
    const initial = active.get(key);
    if (!active.has(key)) return;
    active.delete(key);
    if (!initial) return;
    const raw = message.output;
    const output =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? {
            ...(typeof raw.text === "string" ? { text: raw.text } : {}),
            ...(typeof raw.thinking === "string" ? { thinking: raw.thinking } : {}),
            ...(typeof raw.stopReason === "string" ? { stopReason: raw.stopReason } : {}),
            ...(Array.isArray(raw.toolCalls) ? { toolCalls: raw.toolCalls } : {}),
            ...(Object.hasOwn(raw, "data") ? { data: raw.data } : {}),
          }
        : undefined;
    options.record({
      ...initial,
      endedAt: Date.now(),
      status: message.status,
      output,
      outputState: message.outputState,
      error: typeof message.error === "string" ? message.error : undefined,
      usage: validUsage(message.usage) ? message.usage : undefined,
    });
  };
  const accept = (message: any) => {
    if (
      !message ||
      message.version !== 1 ||
      message.type !== "model_trace" ||
      typeof message.callId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(message.callId)
    )
      return;
    const allowed =
      message.phase === "start"
        ? [
            "version",
            "type",
            "phase",
            "callId",
            "provider",
            "model",
            "purpose",
            "input",
            "inputState",
            "stream",
          ]
        : [
            "version",
            "type",
            "phase",
            "callId",
            "status",
            "output",
            "outputState",
            "error",
            "usage",
          ];
    if (Object.keys(message).some((key) => !allowed.includes(key))) return;
    if (message.phase === "start") {
      if (
        seen.has(message.callId) ||
        seen.size >= 256 ||
        active.size >= 64 ||
        typeof message.provider !== "string" ||
        !message.provider ||
        message.provider.length > 200 ||
        typeof message.model !== "string" ||
        !message.model ||
        message.model.length > 256 ||
        !message.input ||
        typeof message.input !== "object" ||
        Array.isArray(message.input)
      )
        return;
      if (message.inputState !== undefined && message.inputState !== "truncated") return;
      const input = message.input;
      if (
        Object.keys(input).some(
          (key) => !["systemPrompt", "messages", "tools", "parameters"].includes(key),
        ) ||
        (input.systemPrompt !== undefined && typeof input.systemPrompt !== "string") ||
        (input.messages !== undefined && !Array.isArray(input.messages)) ||
        (input.tools !== undefined && !Array.isArray(input.tools)) ||
        (input.parameters !== undefined &&
          (!input.parameters ||
            typeof input.parameters !== "object" ||
            Array.isArray(input.parameters)))
      )
        return;
      seen.add(message.callId);
      const initial: ExternalModelTraceInput = {
        ...context,
        source: options.source,
        purpose:
          typeof message.purpose === "string" ? message.purpose.slice(0, 128) : "native-model",
        provider: message.provider,
        model: message.model,
        startedAt: Date.now(),
        status: "running",
        coverage: "logical-input",
        stream: message.stream === true,
        input: {
          systemPrompt: input.systemPrompt ?? "",
          messages: input.messages ?? [],
          tools: input.tools ?? [],
          parameters: input.parameters ?? {},
        },
        inputState: message.inputState === "truncated" ? "truncated" : undefined,
      };
      const record = options.record(initial);
      active.set(message.callId, record ? { ...initial, id: record.id, input: undefined } : null);
    } else if (
      message.phase === "finish" &&
      ["completed", "failed", "cancelled"].includes(message.status)
    ) {
      if (message.outputState !== undefined && message.outputState !== "truncated") return;
      settle(message.callId, message);
    }
  };
  const finish = (status: "completed" | "failed" | "cancelled" = "cancelled") => {
    if (closed) return;
    closed = true;
    for (const key of active.keys())
      settle(key, { status, error: "Native model process ended before reporting a result" });
    pending = "";
    frames.clear();
  };
  return {
    data(chunk: Uint8Array | string) {
      if (closed) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) {
        finish("failed");
        return;
      }
      pending += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      for (let newline; (newline = pending.indexOf("\n")) >= 0; ) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > 256 * 1024) {
          finish("failed");
          return;
        }
        try {
          const message = frames.read(line);
          if (message !== undefined) accept(JSON.parse(message));
        } catch {
          // A broken channel closes observations without changing command output.
          finish("failed");
          return;
        }
      }
      if (Buffer.byteLength(pending) > 256 * 1024) finish("failed");
    },
    finish,
  };
}
