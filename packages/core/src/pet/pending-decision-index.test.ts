import { describe, expect, test } from "bun:test";
import { PendingDecisionIndex, safePendingTitle } from "./pending-decision-index.js";

describe("PendingDecisionIndex", () => {
  test("indexes tool approvals and AskUser by session without sensitive payloads", () => {
    const index = new PendingDecisionIndex();
    index.created({
      sessionId: "session-a",
      requestId: "same-id",
      routeGeneration: 3,
      workerGeneration: 8,
      kind: "tool_approval",
      title: "等待批准 Write",
      toolName: "Write",
      riskLevel: "high",
      createdAt: 100,
      surfaceable: true,
    });
    index.created({
      sessionId: "session-b",
      requestId: "same-id",
      routeGeneration: 4,
      workerGeneration: 8,
      kind: "ask_user",
      title: safePendingTitle("选择方案\noptions: secret-token-123456"),
      createdAt: 110,
      surfaceable: true,
    });

    const snapshot = index.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot).toContainEqual(
      expect.objectContaining({
        agentSessionId: "session-a",
        kind: "tool_approval",
        toolName: "Write",
        riskLevel: "high",
        status: "pending",
      }),
    );
    expect(snapshot).toContainEqual(
      expect.objectContaining({ agentSessionId: "session-b", kind: "ask_user" }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("options");
    expect(JSON.stringify(snapshot)).not.toContain("resolver");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
  });

  test("does not surface internal bridge waits", () => {
    const index = new PendingDecisionIndex();
    for (const toolName of [
      "__browser_action__",
      "__credential_action__",
      "__workspace_action__",
    ]) {
      index.created({
        sessionId: "session-a",
        requestId: toolName,
        workerGeneration: 1,
        kind: "internal",
        title: "internal",
        toolName,
        createdAt: 100,
        surfaceable: false,
      });
    }
    expect(index.snapshot()).toEqual([]);
  });

  test("terminal transitions are session-scoped, generation-fenced and idempotent", () => {
    const index = new PendingDecisionIndex();
    for (const sessionId of ["session-a", "session-b"]) {
      index.created({
        sessionId,
        requestId: "same-id",
        routeGeneration: 2,
        workerGeneration: 5,
        kind: "ask_user",
        title: "需要回答",
        createdAt: 100,
        surfaceable: true,
      });
    }

    expect(
      index.transition({
        sessionId: "session-a",
        requestId: "same-id",
        routeGeneration: 1,
        status: "resolved",
        terminalAt: 120,
      }),
    ).toBe(false);
    expect(index.get("session-a", "same-id")?.status).toBe("pending");

    expect(
      index.transition({
        sessionId: "session-a",
        requestId: "same-id",
        routeGeneration: 2,
        status: "resolved",
        terminalAt: 121,
      }),
    ).toBe(true);
    expect(
      index.transition({
        sessionId: "session-a",
        requestId: "same-id",
        routeGeneration: 2,
        status: "cancelled",
        terminalAt: 122,
      }),
    ).toBe(false);
    expect(index.get("session-a", "same-id")?.status).toBe("resolved");
    expect(index.get("session-b", "same-id")?.status).toBe("pending");
  });

  test("reconcile cancels old generation pending entries", () => {
    const index = new PendingDecisionIndex();
    index.created({
      sessionId: "session-a",
      requestId: "old",
      workerGeneration: 1,
      kind: "tool_approval",
      title: "等待批准 Bash",
      createdAt: 100,
      surfaceable: true,
    });
    index.reconcileGeneration(2, [], 200);
    expect(index.get("session-a", "old")).toMatchObject({
      status: "cancelled",
      terminalAt: 200,
    });
  });
});
