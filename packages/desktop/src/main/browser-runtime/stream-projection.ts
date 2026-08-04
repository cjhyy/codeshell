import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { BrowserRuntimeVisibility } from "./runtime.js";

const BROWSER_TOOL_NAMES = new Set([
  "browser_observe",
  "browser_act",
  "browser_navigate",
]);

export function isBrowserRuntimeToolName(name: unknown): name is string {
  return typeof name === "string" && BROWSER_TOOL_NAMES.has(name.toLowerCase());
}

/**
 * Attach host-owned visibility metadata without dropping the underlying event.
 * The Engine's on-disk transcript remains the complete audit trace; renderer
 * projection decides which annotated calls become ordinary chat cards.
 */
export function annotateBrowserRuntimeStreamEvent(
  event: unknown,
  visibility: BrowserRuntimeVisibility,
): unknown {
  const stream = event as StreamEvent;
  if (stream?.type === "tool_use_start" && isBrowserRuntimeToolName(stream.toolCall?.toolName)) {
    return {
      ...stream,
      toolCall: { ...stream.toolCall, uiVisibility: visibility },
    } satisfies StreamEvent;
  }
  if (stream?.type === "tool_result" && isBrowserRuntimeToolName(stream.result?.toolName)) {
    return {
      ...stream,
      result: { ...stream.result, uiVisibility: visibility },
    } satisfies StreamEvent;
  }
  return event;
}

/** Replace only params.event in a JSON-RPC stream line for non-renderer taps. */
export function replaceStreamEventInLine(line: string, event: unknown): string {
  try {
    const parsed = JSON.parse(line) as {
      params?: Record<string, unknown>;
    };
    if (!parsed.params) return line;
    return JSON.stringify({
      ...parsed,
      params: { ...parsed.params, event },
    });
  } catch {
    return line;
  }
}
