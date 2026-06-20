/**
 * parseSnapshotAppend — decides which worker→renderer lines feed the snapshot.
 *
 * Extracted from AgentBridge's readline handler so the decision is testable
 * without spawning a subprocess. Only agent/streamEvent notifications carry a
 * (sessionId, event) pair worth retaining; everything else is forwarded but
 * not snapshotted.
 */
import { describe, it, expect } from "bun:test";
import { parseSnapshotAppend } from "./parseStreamLine";

const line = (obj: unknown): string => JSON.stringify(obj);

describe("parseSnapshotAppend", () => {
  it("extracts sessionId + event from an agent/streamEvent notification", () => {
    const result = parseSnapshotAppend(
      line({
        jsonrpc: "2.0",
        method: "agent/streamEvent",
        params: { sessionId: "s1", event: { type: "text_delta", text: "hi" } },
      }),
    );
    expect(result).toEqual({ sessionId: "s1", event: { type: "text_delta", text: "hi" } });
  });

  it("returns null for a JSON-RPC response (has id, no method)", () => {
    expect(parseSnapshotAppend(line({ jsonrpc: "2.0", id: 7, result: {} }))).toBeNull();
  });

  it("returns null for a different method", () => {
    expect(
      parseSnapshotAppend(line({ method: "agent/approvalRequest", params: { sessionId: "s1" } })),
    ).toBeNull();
  });

  it("returns null when sessionId is missing or empty", () => {
    expect(
      parseSnapshotAppend(line({ method: "agent/streamEvent", params: { event: { type: "x" } } })),
    ).toBeNull();
    expect(
      parseSnapshotAppend(
        line({ method: "agent/streamEvent", params: { sessionId: "", event: { type: "x" } } }),
      ),
    ).toBeNull();
  });

  it("returns null when event is absent", () => {
    expect(
      parseSnapshotAppend(line({ method: "agent/streamEvent", params: { sessionId: "s1" } })),
    ).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseSnapshotAppend("{not json")).toBeNull();
  });

  it("excludes steer_injected (live-only marker; transcript already has the user msg)", () => {
    // If snapshotted, a resume would replay it AND rebuild the same user msg
    // from the transcript → the steered message renders twice (s-mqjl1uap bug).
    expect(
      parseSnapshotAppend(
        line({
          method: "agent/streamEvent",
          params: { sessionId: "s1", event: { type: "steer_injected", text: "也看收藏" } },
        }),
      ),
    ).toBeNull();
  });
});
