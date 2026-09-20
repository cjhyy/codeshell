/**
 * L2 disclosure: the newest assistant text of one session, straight from the
 * transcript tail. No generated summaries — the latest turn result IS the
 * session's current "content". Callers cache by transcript mtime.
 */
import { join } from "node:path";
import { readTranscriptTail, textOfContent } from "./jsonl.js";

export interface LatestAssistantText {
  text: string;
  truncated: boolean;
  timestamp?: number;
}

export interface LatestWorkContext {
  latestRequest: LatestAssistantText | null;
  latestResult: LatestAssistantText | null;
}

/** Recent transcript evidence, never instructions or a generated task title. */
export async function readLatestWorkContext(
  sessionDir: string,
  options: { maxChars: number },
): Promise<LatestWorkContext> {
  const events = await readTranscriptTail(join(sessionDir, "transcript.jsonl"));
  const context: LatestWorkContext = { latestRequest: null, latestResult: null };
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "message") continue;
    const data = event.data ?? {};
    const key = data.role === "assistant" ? "latestResult" : "latestRequest";
    if (
      context[key] ||
      (data.role !== "assistant" && data.role !== "user") ||
      data.injected === true ||
      (data.role === "user" && data.authority !== undefined && data.authority !== "user")
    )
      continue;
    const text = textOfContent(data.content).trim();
    if (!text) continue;
    context[key] = {
      text: truncateSafely(text, options.maxChars),
      truncated: text.length > options.maxChars,
      ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
    };
    if (context.latestRequest && context.latestResult) break;
  }
  return context;
}

/** Truncate to maxChars without splitting a UTF-16 surrogate pair in two. */
function truncateSafely(text: string, maxChars: number): string {
  const sliced = text.slice(0, maxChars);
  if (/[\uD800-\uDBFF]$/.test(sliced)) return sliced.slice(0, -1);
  return sliced;
}

export async function readLatestAssistantText(
  sessionDir: string,
  options: { maxChars: number },
): Promise<LatestAssistantText | null> {
  const events = await readTranscriptTail(join(sessionDir, "transcript.jsonl"));
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "message") continue;
    const data = event.data ?? {};
    if (data.role !== "assistant") continue;
    const text = textOfContent(data.content).trim();
    if (!text) continue;
    const truncated = text.length > options.maxChars;
    return {
      text: truncated ? truncateSafely(text, options.maxChars) : text,
      truncated,
      ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
    };
  }
  return null;
}
