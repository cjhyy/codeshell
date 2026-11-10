import { describe, expect, test } from "bun:test";
import { parseLiveStreamEnvelope, parseSnapshotAppend } from "../parseStreamLine.js";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { parseWorkerLine } from "../worker-line.js";
import {
  annotateBrowserRuntimeStreamEvent,
  replaceStreamEventInLine,
} from "./stream-projection.js";

describe("Browser Runtime stream visibility annotation", () => {
  test("annotates browser tool starts and results without changing their payload", () => {
    expect(
      annotateBrowserRuntimeStreamEvent(
        {
          type: "tool_use_start",
          toolCall: { id: "b1", toolName: "browser_act", args: { action: "scroll" } },
        },
        "milestones",
      ),
    ).toEqual({
      type: "tool_use_start",
      toolCall: {
        id: "b1",
        toolName: "browser_act",
        args: { action: "scroll" },
        uiVisibility: "milestones",
      },
    });
    expect(
      annotateBrowserRuntimeStreamEvent(
        {
          type: "tool_result",
          result: { id: "b1", toolName: "browser_act", result: "Scrolled" },
        },
        "hidden",
      ),
    ).toMatchObject({ result: { result: "Scrolled", uiVisibility: "hidden" } });
  });

  test("leaves non-browser events untouched", () => {
    const event = {
      type: "tool_use_start",
      toolCall: { id: "r1", toolName: "Read", args: {} },
    };
    expect(annotateBrowserRuntimeStreamEvent(event, "hidden")).toBe(event);
  });

  test("rewrites the event for outbound JSON-RPC taps", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/streamEvent",
      params: { sessionId: "s1", event: { type: "old" } },
    });
    expect(JSON.parse(replaceStreamEventInLine(line, { type: "new" }))).toMatchObject({
      params: { sessionId: "s1", event: { type: "new" } },
    });
  });

  test("shared nested input stays unchanged through normalization, snapshot and projection", () => {
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    for (const event of [
      {
        type: "tool_use_start",
        toolCall: { id: "b1", toolName: "browser_act", args: { refs: ["ref-1"] } },
      },
      {
        type: "tool_result",
        result: { id: "b1", toolName: "browser_act", result: { items: ["Scrolled"] } },
      },
    ]) {
      const message = {
        jsonrpc: "2.0",
        method: "agent/streamEvent",
        params: { sessionId: "s1", event, seq: 91, epoch: "worker", metadata: { ids: ["keep"] } },
      };
      const line = JSON.stringify(message);
      const parsed = parseWorkerLine(line);
      freeze(parsed.message);
      const append = parseSnapshotAppend(line, parsed)!;
      const projected = annotateBrowserRuntimeStreamEvent(append.event, "milestones");
      const snapshots = new SessionSnapshotStore();
      const entry = snapshots.append(append.sessionId, projected);
      expect(projected).not.toBe(append.event);
      expect(snapshots.get("s1").events[0].event).toEqual(projected);
      expect(snapshots.get("s1").events[0].event).not.toBe(projected);
      expect(
        parseLiveStreamEnvelope(line, { seq: entry.seq, epoch: snapshots.epoch }, parsed),
      ).toEqual({ sessionId: "s1", event, seq: 1, epoch: snapshots.epoch });
      expect(JSON.parse(replaceStreamEventInLine(line, projected, parsed))).toEqual({
        ...message,
        params: { ...message.params, event: projected },
      });
      expect(JSON.stringify(parsed.message)).toBe(line);
      expect(parseSnapshotAppend(line, parsed)).toEqual({ sessionId: "s1", event });
    }
  });
});
