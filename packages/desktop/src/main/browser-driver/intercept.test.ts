import { describe, expect, test } from "bun:test";
import { parseBrowserActionLine, buildBrowserActionReply } from "./intercept";

const browserActionLine = (args: Record<string, unknown>, requestId = "rq1", sessionId = "s1") =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: { sessionId, requestId, request: { toolName: "__browser_action__", args } },
  });

describe("parseBrowserActionLine", () => {
  test("parses a browser action request", () => {
    const p = parseBrowserActionLine(browserActionLine({ action: "click", ref: "e3" }));
    expect(p).toEqual({
      sessionId: "s1",
      requestId: "rq1",
      request: { action: "click", ref: "e3", text: undefined, url: undefined, dir: undefined, amount: undefined },
    });
  });

  test("returns null for a normal ask-user approval request (not browser)", () => {
    const line = JSON.stringify({
      method: "agent/approvalRequest",
      params: { requestId: "x", request: { toolName: "__ask_user__", args: { question: "?" } } },
    });
    expect(parseBrowserActionLine(line)).toBeNull();
  });

  test("returns null for stream events / other methods / malformed json", () => {
    expect(parseBrowserActionLine(JSON.stringify({ method: "agent/streamEvent", params: {} }))).toBeNull();
    expect(parseBrowserActionLine("not json")).toBeNull();
    expect(parseBrowserActionLine(JSON.stringify({ method: "agent/approvalRequest" }))).toBeNull();
  });

  test("returns null when args.action missing", () => {
    const line = JSON.stringify({
      method: "agent/approvalRequest",
      params: { requestId: "x", request: { toolName: "__browser_action__", args: {} } },
    });
    expect(parseBrowserActionLine(line)).toBeNull();
  });
});

describe("buildBrowserActionReply", () => {
  test("wraps the result json in an agent/approve resolving the requestId", () => {
    const parsed = { sessionId: "s1", requestId: "rq1", request: { action: "snapshot" as const } };
    const reply = JSON.parse(buildBrowserActionReply(parsed, '{"ok":true}'));
    expect(reply.method).toBe("agent/approve");
    expect(reply.params.sessionId).toBe("s1");
    expect(reply.params.requestId).toBe("rq1");
    expect(reply.params.decision).toEqual({ approved: true, answer: '{"ok":true}' });
    expect(typeof reply.id).toBe("number");
  });
});
