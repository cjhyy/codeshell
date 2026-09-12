import { describe, expect, test } from "bun:test";
import {
  appendProcessEvent,
  ProcessReceipts,
  processLimits,
  type ProcessRecord,
} from "./process-state.js";

function record(id: string, guestId = 1): ProcessRecord {
  return {
    owner: { guestId, appId: "fixture", revision: "r1" },
    processId: id,
    status: "exited",
    startedAt: 0,
    exitedAt: 1,
    cancelRequested: false,
    sequence: 0,
    events: [],
    eventBytes: 0,
  };
}

describe("bounded process receipts", () => {
  test("expires terminal receipts and bounds each guest and the complete service", () => {
    let now = 1_000;
    const receipts = new ProcessReceipts(() => now);
    try {
      for (let i = 0; i < 40; i++) receipts.add(record(`one-${i}`));
      expect(receipts.get("one-0")).toBeUndefined();
      expect(receipts.get("one-8")).toBeDefined();
      for (let i = 0; i < 128; i++) receipts.add(record(`many-${i}`, i + 2));
      expect(receipts.get("one-39")).toBeUndefined();
      expect(receipts.get("many-0")).toBeDefined();
      receipts.revokeGuest(2);
      expect(receipts.get("many-0")).toBeUndefined();
      now += processLimits.receiptTtlMs;
      expect(receipts.get("many-127")).toBeUndefined();
    } finally {
      receipts.close();
    }
  });

  test("event retention has independent event and byte bounds and preserves terminal sequence", () => {
    const item = record("output");
    for (let i = 0; i < 300; i++) appendProcessEvent(item, "process.output", { text: "x" });
    expect(item.events).toHaveLength(processLimits.maxEventsPerProcess);
    expect(item.events[0]!.sequence).toBe(45);
    for (let i = 0; i < 30; i++)
      appendProcessEvent(item, "process.output", { text: "中".repeat(16_384) });
    appendProcessEvent(item, "process.exit", { code: 0, signal: null });
    expect(item.eventBytes).toBeLessThanOrEqual(processLimits.maxRetainedOutputBytes);
    expect(item.events.at(-1)).toMatchObject({ sequence: 331, event: "process.exit" });
    expect(item.events.at(-1)!.payload.sequence).toBe(331);
  });
});
