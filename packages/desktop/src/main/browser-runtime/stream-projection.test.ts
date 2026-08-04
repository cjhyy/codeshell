import { describe, expect, test } from "bun:test";
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
});
