/** Native stream projection and durable notification publication. */
import type { StreamEvent } from "../types.js";
import { SessionOutputPublisher } from "../session/output-publisher.js";
import type { Transport } from "./transport.js";
import { Methods, createNotification } from "./types.js";
export { SessionOutputPublisher } from "../session/output-publisher.js";

type ContextCompactStreamEvent = Extract<StreamEvent, { type: "context_compact" }>;

const COMPACT_STREAM_STRATEGIES = new Set<ContextCompactStreamEvent["strategy"]>([
  "micro",
  "summary",
  "window",
  "snip",
  "emergency",
  "compacted",
  // Range archival (archive_range query) emits its boundary through this map;
  // without "range" here it would be silently downgraded to "compacted".
  "range",
  "notes",
]);

export function toCompactStreamStrategy(strategy: string): ContextCompactStreamEvent["strategy"] {
  return COMPACT_STREAM_STRATEGIES.has(strategy as ContextCompactStreamEvent["strategy"])
    ? (strategy as ContextCompactStreamEvent["strategy"])
    : "compacted";
}

export function publishProtocolNotification(
  publisher: SessionOutputPublisher,
  transport: Transport,
  method: string,
  params: Record<string, unknown>,
  source?: object,
): void {
  if (method === Methods.StreamEvent && typeof params.sessionId === "string") {
    try {
      params = { ...params, event: publisher.project(params.sessionId, params.event, source) };
    } catch {
      params = {
        ...params,
        event: {
          ...(params.event as object),
          outputCursor: undefined,
          outputRecovery: "incomplete",
        },
      };
    }
  }
  transport.send(createNotification(method, params));
}
