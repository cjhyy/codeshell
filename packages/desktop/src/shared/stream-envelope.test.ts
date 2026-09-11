import { describe, expect, test } from "bun:test";
import { normalizeStreamEnvelope } from "./stream-envelope";

describe("host stream envelope", () => {
  test("preserves the sequence and Main epoch together across preload", () => {
    const event = { type: "text_delta", text: "hello" };
    const normalized = normalizeStreamEnvelope({
      sessionId: "saved",
      event,
      seq: 11,
      epoch: "main-2",
    });
    expect(normalized).toEqual({ sessionId: "saved", event, seq: 11, epoch: "main-2" });
    expect(normalized?.event).toBe(event);
  });
  test("keeps legacy live-only events without inventing a cursor", () => {
    expect(normalizeStreamEnvelope({ event: { type: "steer_injected", text: "go" } })).toEqual({
      sessionId: "",
      event: { type: "steer_injected", text: "go" },
    });
  });
  test("rejects malformed envelopes and payloads before reaching renderer listeners", () => {
    for (const value of [
      null,
      false,
      [],
      "text",
      {},
      { event: null },
      { event: [] },
      { event: {} },
      { event: { type: 1 } },
    ]) {
      expect(normalizeStreamEnvelope(value)).toBeNull();
    }
  });
  test("invalid metadata cannot poison a valid stream cursor", () => {
    for (const seq of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        normalizeStreamEnvelope({
          sessionId: 4,
          event: { type: "text_delta", text: "hello" },
          seq,
          epoch: {},
        }),
      ).toEqual({ sessionId: "", event: { type: "text_delta", text: "hello" } });
    }
  });
});
