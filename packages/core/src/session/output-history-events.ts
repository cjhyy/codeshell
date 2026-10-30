import type { StreamEvent } from "../types.js";

/** Reassemble only a complete, already chain-verified journal; never skip a damaged group. */
export function outputHistoryEvents(records: Array<Record<string, any>>): StreamEvent[] {
  return outputHistoryEventGroups(records).map((group) => group.event);
}
export function outputHistoryEventGroups(
  records: Array<Record<string, any>>,
): Array<{ event: StreamEvent; records: Array<Record<string, any>> }> {
  const events: Array<{ event: StreamEvent; records: Array<Record<string, any>> }> = [];
  let source: Array<Record<string, any>> = [];
  let group:
    | { id: string; total: number; index: number; chunks: Buffer[]; bytes: number }
    | undefined;
  const invalid = () => new Error("Invalid history fragment");
  const push = (event: unknown) => {
    if (!event || typeof event !== "object" || typeof (event as StreamEvent).type !== "string")
      throw invalid();
    events.push({ event: event as StreamEvent, records: source });
    source = [];
  };
  for (const record of records) {
    source.push(record);
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

/** Only the trusted verifier can propose additions; client requests carry only a plan ID. */
export function checkpointOutputHistoryRecords(
  groups: ReturnType<typeof outputHistoryEventGroups>,
  proposed: StreamEvent[],
  sessionId?: string,
): Array<Record<string, any>> {
  const originals = new Set(groups.map((group) => group.event));
  const records: Array<Record<string, any>> = [];
  let index = 0;
  for (const event of proposed) {
    if (originals.has(event)) {
      if (groups[index]?.event !== event)
        throw new Error("Checkpoint changed original event order");
      records.push(...groups[index++]!.records);
      continue;
    }
    const acceptedFailedInput =
      event.type === "session_user_message" &&
      sessionId !== undefined &&
      event.sessionId === sessionId &&
      event.injected !== true &&
      (event.authority === undefined || event.authority === "user") &&
      typeof event.clientMessageId === "string" &&
      !!event.clientMessageId.trim() &&
      event.clientMessageId.length <= 512;
    const permitted =
      acceptedFailedInput ||
      event.type === "error" ||
      event.type === "turn_complete" ||
      (event.type === "tool_result" && typeof event.result?.error === "string");
    if (
      !permitted ||
      event.outputCursor !== undefined ||
      event.outputRecovery !== undefined ||
      Buffer.byteLength(JSON.stringify(event)) > 65536
    )
      throw new Error("Checkpoint addition is not a bounded verified display event");
    records.push({ version: 2, producer: { kind: "host", id: "output-history-recovery" }, event });
  }
  if (index !== groups.length) throw new Error("Checkpoint omitted original output");
  return records;
}
