import type { StreamEvent } from "../types.js";

/** Reassemble only a complete, already chain-verified journal; never skip a damaged group. */
export function outputHistoryEvents(records: Array<Record<string, any>>): StreamEvent[] {
  const events: StreamEvent[] = [];
  let group:
    | { id: string; total: number; index: number; chunks: Buffer[]; bytes: number }
    | undefined;
  const invalid = () => new Error("Invalid history fragment");
  const push = (event: unknown) => {
    if (!event || typeof event !== "object" || typeof (event as StreamEvent).type !== "string")
      throw invalid();
    events.push(event as StreamEvent);
  };
  for (const record of records) {
    if (record.event) {
      if (group || record.fragment) throw invalid();
      push(record.event);
      continue;
    }
    const part = record.fragment;
    if (
      !part ||
      typeof part.id !== "string" ||
      !Number.isSafeInteger(part.total) ||
      part.total < 2 ||
      part.total > 256 ||
      !Number.isSafeInteger(part.index) ||
      part.index < 0 ||
      part.index >= part.total ||
      typeof part.data !== "string" ||
      part.data.length > Math.ceil(65536 / 3) * 4
    )
      throw invalid();
    if (!group) {
      if (part.index !== 0) throw invalid();
      group = { id: part.id, total: part.total, index: 0, chunks: [], bytes: 0 };
    }
    if (part.id !== group.id || part.total !== group.total || part.index !== group.index)
      throw invalid();
    const chunk = Buffer.from(part.data, "base64");
    if (!chunk.length || chunk.length > 65536 || chunk.toString("base64") !== part.data)
      throw invalid();
    group.chunks.push(chunk);
    group.bytes += chunk.length;
    group.index++;
    if (group.bytes > 16 * 1024 * 1024) throw invalid();
    if (group.index === group.total) {
      push(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(group.chunks, group.bytes),
          ),
        ),
      );
      group = undefined;
    }
  }
  if (group) throw invalid();
  return events;
}
