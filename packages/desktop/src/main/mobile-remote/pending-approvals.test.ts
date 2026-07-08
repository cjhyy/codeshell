import { describe, expect, test } from "bun:test";
import { PendingMobileApprovals } from "./pending-approvals.js";

function approvalRequestLine(sessionId: string, requestId: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: {
      sessionId,
      requestId,
      request: {
        toolName: "AskUserQuestion",
        description: "Pick a deployment target",
        args: {
          question: "Deploy where?",
          options: ["staging", "production"],
          optionsOnly: true,
        },
        riskLevel: "low",
      },
    },
  });
}

describe("PendingMobileApprovals", () => {
  test("replays pending approval requests only for the selected session", () => {
    const pending = new PendingMobileApprovals();
    const line = approvalRequestLine("s2", "ask-1");

    pending.observeOutboundLine(line);

    expect(pending.replayLines("s1")).toEqual([]);
    expect(pending.replayLines("s2")).toEqual([line]);
  });

  test("does not replay an approval after it resolves", () => {
    const pending = new PendingMobileApprovals();
    pending.observeOutboundLine(approvalRequestLine("s2", "ask-1"));

    pending.observeOutboundLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/approvalResolved",
        params: { sessionId: "s2", requestId: "ask-1", approved: true },
      }),
    );

    expect(pending.replayLines("s2")).toEqual([]);
  });

  test("direct resolve clears approvals resolved through the typed mobile path", () => {
    const pending = new PendingMobileApprovals();
    pending.observeOutboundLine(approvalRequestLine("s2", "ask-1"));

    pending.resolve("ask-1");

    expect(pending.replayLines("s2")).toEqual([]);
  });
});
