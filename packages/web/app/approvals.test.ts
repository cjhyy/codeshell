import { describe, expect, test } from "bun:test";
import { reduceApprovals } from "./approvals.js";
const a = { requestId: "a", sessionId: "session-1", request: { toolName: "Bash", args: {} } };
const b = { requestId: "b", sessionId: "session-2", request: { toolName: "Read", args: {} } };

describe("Hub approval synchronization", () => {
  test("reconnect snapshot replaces stale approvals and restores every session", () => {
    let state = reduceApprovals({}, { method: "agent/approvalRequest", params: a });
    state = reduceApprovals(state, {
      method: "serve/approvalLease",
      params: { requestId: "a", holderId: "tab1", expiresAt: 900 },
    });
    state = reduceApprovals(state, {
      method: "serve/approvalSnapshot",
      params: { approvals: [a, b] },
    });
    expect(Object.keys(state)).toEqual(["a", "b"]);
    expect(state.a.lease).toBeUndefined();
    state = reduceApprovals(state, {
      method: "serve/approvalSnapshot",
      params: { approvals: [b] },
    });
    expect(Object.keys(state)).toEqual(["b"]);
  });
  test("leases retain the card and release it for another decision after failure", () => {
    let state = reduceApprovals({}, { method: "agent/approvalRequest", params: a });
    state = reduceApprovals(state, {
      method: "serve/approvalLease",
      params: { requestId: "a", holderId: "tab1", expiresAt: 900 },
    });
    expect(state.a.payload).toEqual(a);
    expect(state.a.lease?.holderId).toBe("tab1");
    state = reduceApprovals(state, {
      method: "serve/approvalLease",
      params: { requestId: "a", holderId: null, expiresAt: null },
    });
    expect(state.a.payload).toEqual(a);
    state = reduceApprovals(state, {
      method: "agent/approvalResolved",
      params: { requestId: "a" },
    });
    expect(state).toEqual({});
  });
  test("late leases cannot resurrect an approval already resolved elsewhere", () => {
    const state = reduceApprovals(
      {},
      {
        method: "serve/approvalLease",
        params: { requestId: "a", holderId: "tab1", expiresAt: 900 },
      },
    );
    expect(state).toEqual({});
  });
});
