import type { StreamEvent } from "@cjhyy/code-shell-core";

type Flush = (event: StreamEvent) => void;

interface PendingText {
  agentId: string | undefined;
  text: string;
  tokens?: number;
}

interface PendingArgs {
  agentId: string | undefined;
  toolCallId: string;
  args: Record<string, unknown>;
}

/**
 * Coalesce rapid `text_delta` and `tool_use_args_delta` bursts before
 * they reach the reducer. Mirrors the TUI's 50 ms `flushTextBuffer`
 * pattern (`packages/tui/src/ui/App.tsx`) at the renderer ingress.
 *
 * Pass-through events (everything else) emit immediately. The pending
 * buffer is also drained immediately on `tool_use_start`, `tool_result`,
 * `turn_complete`, `agent_start`, `agent_end`, and `error` — boundaries
 * the user must see in real time.
 *
 * Pure logic, no React. Callers (App.tsx) wire `push` to the stream
 * source and provide an `onFlush` that dispatches into the reducer.
 */
export function createEventCoalescer(onFlush: Flush, intervalMs = 50) {
  // Key shape: `${eventType}|${agentId ?? ""}|${toolCallId ?? ""}`
  const textBuf = new Map<string, PendingText>();
  const argsBuf = new Map<string, PendingArgs>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Drain in insertion order: text first, then args. Both maps preserve
    // insertion order per spec; cross-type ordering is not preserved
    // (text_delta and tool_use_args_delta should never interleave for the
    // same tool since args precedes the tool's text output).
    for (const [, p] of textBuf) {
      const ev: StreamEvent =
        p.tokens !== undefined
          ? ({ type: "text_delta", text: p.text, tokens: p.tokens, agentId: p.agentId } as any)
          : ({ type: "text_delta", text: p.text, agentId: p.agentId } as any);
      onFlush(ev);
    }
    textBuf.clear();
    for (const [, p] of argsBuf) {
      onFlush({
        type: "tool_use_args_delta",
        toolCallId: p.toolCallId,
        args: p.args,
        agentId: p.agentId,
      } as any);
    }
    argsBuf.clear();
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, intervalMs);
  }

  function push(event: StreamEvent): void {
    const t = event.type;
    if (t === "text_delta") {
      const agentId = (event as any).agentId as string | undefined;
      const key = `text|${agentId ?? ""}`;
      const prev = textBuf.get(key);
      if (prev) {
        prev.text += (event as any).text;
        if ((event as any).tokens !== undefined) {
          prev.tokens = (prev.tokens ?? 0) + ((event as any).tokens as number);
        }
      } else {
        textBuf.set(key, {
          agentId,
          text: (event as any).text,
          tokens: (event as any).tokens,
        });
      }
      scheduleFlush();
      return;
    }
    if (t === "tool_use_args_delta") {
      const agentId = (event as any).agentId as string | undefined;
      const toolCallId = (event as any).toolCallId as string;
      const key = `args|${agentId ?? ""}|${toolCallId}`;
      const prev = argsBuf.get(key);
      if (prev) {
        Object.assign(prev.args, (event as any).args);
      } else {
        argsBuf.set(key, {
          agentId,
          toolCallId,
          args: { ...((event as any).args as Record<string, unknown>) },
        });
      }
      scheduleFlush();
      return;
    }
    // Boundary events: flush first to preserve ordering, then pass through.
    if (
      t === "tool_use_start" ||
      t === "tool_result" ||
      t === "turn_complete" ||
      t === "agent_start" ||
      t === "agent_end" ||
      t === "error"
    ) {
      flush();
      onFlush(event);
      return;
    }
    // Everything else passes straight through.
    onFlush(event);
  }

  function dispose(): void {
    flush();
  }

  return { push, flush, dispose };
}
