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
  test("replays an asynchronous question after its run ends until it is answered or cancelled", () => {
    const pending = new PendingMobileApprovals();
    const request = JSON.parse(approvalRequestLine("s1", "ask-later"));
    request.params.request.toolName = "__ask_user__";
    request.params.request.args.asynchronous = true;
    const line = JSON.stringify(request);
    pending.observeOutboundLine(line);

    for (const event of [
      { type: "turn_complete", reason: "completed" },
      { type: "error", message: "later run failed" },
    ]) {
      pending.observeOutboundLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "agent/streamEvent",
          params: { sessionId: "s1", event },
        }),
      );
      expect(pending.replayLines("s1")).toEqual([line]);
      expect(pending.replayAllLines()).toEqual([line]);
    }

    pending.observeOutboundLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/approvalResolved",
        params: { sessionId: "s1", requestId: "ask-later", approved: true, answer: "staging" },
      }),
    );
    expect(pending.replayAllLines()).toEqual([]);

    pending.observeOutboundLine(line);
    pending.observeOutboundLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/approvalResolved",
        params: { sessionId: "s1", requestId: "ask-later", approved: false },
      }),
    );
    expect(pending.replayAllLines()).toEqual([]);
  });

  test("snapshots all unresolved sessions without replaying resolved or closed requests", () => {
    const pending = new PendingMobileApprovals();
    const first = approvalRequestLine("s1", "one");
    const second = approvalRequestLine("s2", "two");
    pending.observeOutboundLine(first);
    pending.observeOutboundLine(second);
    pending.observeOutboundLine(second);
    expect(pending.replayAllLines()).toEqual([first, second]);
    const snapshot = pending.replayAllLines();
    pending.resolve("one");
    pending.forgetSession("s2");
    expect(pending.replayAllLines()).toEqual([]);
    expect(snapshot).toEqual([first, second]);
  });

  test("a dead worker or a new generation cannot replay the previous worker's approvals", () => {
    const pending = new PendingMobileApprovals();
    const old = approvalRequestLine("same-session", "reused-id");
    pending.setWorkerState(1, true);
    pending.observeOutboundLine(old);
    pending.setWorkerState(1, true);
    expect(pending.replayAllLines()).toEqual([old]);
    pending.setWorkerState(1, false);
    expect(pending.replayAllLines()).toEqual([]);
    pending.setWorkerState(2, true);
    pending.observeOutboundLine(old);
    pending.setWorkerState(3, true);
    expect(pending.replayAllLines()).toEqual([]);
    const current = approvalRequestLine("current-session", "reused-id");
    pending.observeOutboundLine(current);
    expect(pending.replayAllLines()).toEqual([current]);
    expect(pending.replayLines("same-session")).toEqual([]);
  });

  test("ignores JSON scalars and malformed records without losing a pending approval", () => {
    const pending = new PendingMobileApprovals();
    const line = approvalRequestLine("session", "pending");
    pending.observeOutboundLine(line);

    for (const invalid of ["null", "[]", "42", '"noise"', "broken", '{"params":null}']) {
      expect(() => pending.observeOutboundLine(invalid)).not.toThrow();
    }
    expect(pending.replayLines("session")).toEqual([line]);
  });

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
