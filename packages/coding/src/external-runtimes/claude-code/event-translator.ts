/**
 * Claude Code `--output-format stream-json` → CodeShell `StreamEvent`.
 *
 * Shapes measured against real `claude 2.1.220`, not inferred. The stream is a
 * mix of two vocabularies:
 *
 *  - CodeShell-ish envelopes: `system` (with `subtype: "init"`), `assistant`,
 *    `user` (carrying tool results), `result`, `rate_limit_event`.
 *  - Raw Anthropic streaming events under `type: "stream_event"` →
 *    `event.type: message_start | content_block_start | content_block_delta | …`.
 *
 * Tool lifecycle comes from the RAW events, because only they carry the tool id
 * at `content_block.id`. Text likewise: `assistant` repeats the whole message, so
 * translating both it and the deltas would double every character.
 *
 * §15.2 still applies: a CodeShell Host Tool already emits its own lifecycle
 * through `ToolExecutor`, so a `mcp__codeshell_tools__*` tool_use must NOT get a
 * second card here. Claude namespaces MCP tools with that prefix, which is what
 * makes the distinction reliable.
 */
import type { StreamEvent, TerminalReason } from "@cjhyy/code-shell-core/extension";

export interface ClaudeEventTranslatorOptions {
  /** CodeShell business session id, for correlating logs. */
  sessionId: string;
  /** MCP server name whose tool cards this translator suppresses. */
  codeshellServerName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Map Claude's terminal reason onto CodeShell's.
 *
 * `error_max_turns` is distinct from a model error: reporting the wrong one sends
 * a reader looking for an outage that never happened.
 */
function terminalReasonFor(subtype: string | undefined, isError: boolean): TerminalReason {
  if (subtype === "error_max_turns") return "max_turns";
  if (subtype === "error_during_execution" || isError) return "model_error";
  return "completed";
}

export class ClaudeEventTranslator {
  private readonly codeshellServer: string;
  private turnNumber = 0;
  private sessionStarted = false;
  private terminal = false;
  /** Accumulates `input_json_delta` per tool block so args land as one object. */
  private readonly toolInput = new Map<string, { name: string; json: string }>();

  constructor(private readonly options: ClaudeEventTranslatorOptions) {
    this.codeshellServer = options.codeshellServerName ?? "codeshell_tools";
  }

  /** Reset turn-scoped state while preserving the durable Claude session id. */
  beginTurn(): void {
    this.terminal = false;
    this.toolInput.clear();
  }

  /** Claude session id, learned from the `system/init` line. */
  runtimeSessionId?: string;

  /**
   * Translate one NDJSON line. Zero events is a normal outcome (housekeeping,
   * unknown type). Deliberately total: an unrecognised or malformed line must not
   * take the session down.
   */
  translate(line: unknown): StreamEvent[] {
    const message = asRecord(line);
    if (!message) return [];
    switch (str(message.type)) {
      case "system":
        return this.onSystem(message);
      case "stream_event":
        return this.onStreamEvent(message);
      case "user":
        return this.onUser(message);
      case "result":
        return this.onResult(message);
      default:
        // `assistant` is deliberately ignored: it repeats the full message text,
        // which the content_block deltas have already delivered. Translating both
        // would double every character.
        return [];
    }
  }

  private onSystem(message: Record<string, unknown>): StreamEvent[] {
    if (str(message.subtype) !== "init") return [];
    const sessionId = str(message.session_id);
    if (sessionId) this.runtimeSessionId = sessionId;
    if (this.sessionStarted) return [];
    this.sessionStarted = true;
    // promptTokens is unknown at init; the field is required, and 0 is honest
    // here rather than a guess.
    return sessionId ? [{ type: "session_started", sessionId, promptTokens: 0 }] : [];
  }

  private onStreamEvent(message: Record<string, unknown>): StreamEvent[] {
    const event = asRecord(message.event);
    const type = str(event?.type);
    if (!event || !type) return [];

    if (type === "message_start") {
      this.turnNumber += 1;
      return [{ type: "stream_request_start", turnNumber: this.turnNumber }];
    }

    if (type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (str(block?.type) !== "tool_use") return [];
      const id = str(block?.id);
      const name = str(block?.name);
      if (!id || !name) return [];
      // Track it even when suppressed, so its input deltas do not leak into the
      // next block's arguments.
      this.toolInput.set(id, { name, json: "" });
      if (this.isCodeshellHostTool(name)) return [];
      return [{ type: "tool_use_start", toolCall: { id, toolName: name, args: {} } }];
    }

    if (type === "content_block_delta") {
      const delta = asRecord(event.delta);
      const deltaType = str(delta?.type);
      if (deltaType === "text_delta") {
        const text = str(delta?.text);
        return text ? [{ type: "text_delta", text }] : [];
      }
      if (deltaType === "input_json_delta") {
        // Arguments stream as JSON fragments; buffer and emit once complete.
        const partial = typeof delta?.partial_json === "string" ? delta.partial_json : "";
        const pending = this.currentTool();
        if (pending) pending.json += partial;
        return [];
      }
      return [];
    }

    if (type === "content_block_stop") {
      return this.flushToolArgs();
    }
    return [];
  }

  /** The most recently opened tool block — deltas belong to it. */
  private currentTool(): { name: string; json: string } | undefined {
    let last: { name: string; json: string } | undefined;
    for (const value of this.toolInput.values()) last = value;
    return last;
  }

  private flushToolArgs(): StreamEvent[] {
    const entries = [...this.toolInput.entries()];
    const latest = entries.at(-1);
    if (!latest) return [];
    const [id, pending] = latest;
    if (this.isCodeshellHostTool(pending.name)) return [];
    if (!pending.json) return [];
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(pending.json) as unknown;
      args = asRecord(parsed) ?? {};
    } catch {
      // A truncated fragment is not worth failing a turn over; the tool_use_start
      // already told the UI which tool is running.
      return [];
    }
    return [{ type: "tool_use_args_delta", toolCallId: id, args }];
  }

  /** Tool results arrive as a `user` message carrying `tool_result` blocks. */
  private onUser(message: Record<string, unknown>): StreamEvent[] {
    const inner = asRecord(message.message);
    const content = Array.isArray(inner?.content) ? inner.content : [];
    const events: StreamEvent[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (str(block?.type) !== "tool_result") continue;
      const id = str(block?.tool_use_id);
      if (!id) continue;
      const known = this.toolInput.get(id);
      // Suppress the CodeShell side; ToolExecutor already reported this call.
      if (known && this.isCodeshellHostTool(known.name)) continue;
      const text =
        typeof block?.content === "string"
          ? block.content
          : Array.isArray(block?.content)
            ? block.content
                .map((part) => str(asRecord(part)?.text) ?? "")
                .filter(Boolean)
                .join("\n")
            : undefined;
      events.push({
        type: "tool_result",
        result: {
          id,
          toolName: known?.name ?? "unknown",
          ...(text !== undefined ? { result: text } : {}),
          ...(block?.is_error === true ? { isError: true } : {}),
        },
      });
    }
    return events;
  }

  private onResult(message: Record<string, unknown>): StreamEvent[] {
    // `result` is the single terminal line. Guard against a duplicate closing the
    // turn twice — the same hazard Codex has with turn/completed.
    if (this.terminal) return [];
    this.terminal = true;
    const events: StreamEvent[] = [];
    const usage = asRecord(message.usage);
    const number = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const promptTokens = number(usage?.input_tokens);
    if (promptTokens !== undefined) {
      const completionTokens = number(usage?.output_tokens);
      const cacheReadTokens = number(usage?.cache_read_input_tokens);
      const cacheCreationTokens = number(usage?.cache_creation_input_tokens);
      events.push({
        type: "usage_update",
        promptTokens,
        promptTokensSource: "provider_usage",
        promptTokensConfidence: "high",
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      });
    }
    const reason = terminalReasonFor(str(message.subtype), message.is_error === true);
    if (reason === "model_error") {
      const detail = str(message.result) ?? str(message.error);
      if (detail) events.push({ type: "error", error: detail });
    }
    events.push({ type: "turn_complete", reason });
    return events;
  }

  private isCodeshellHostTool(toolName: string): boolean {
    return toolName.startsWith(`mcp__${this.codeshellServer}__`);
  }
}
