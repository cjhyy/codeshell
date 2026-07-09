import { describe, expect, it } from "bun:test";
import { AgentClient } from "./client.js";
import { createInProcessTransport } from "./transport.js";
import { createNotification, Methods } from "./types.js";
import type { ApprovalRequest } from "../types.js";

describe("AgentClient approval notifications", () => {
  function setup() {
    const [clientSide, serverSide] = createInProcessTransport();
    const client = new AgentClient({ transport: clientSide });
    return { client, serverSide };
  }

  it("exposes the approvalRequest envelope sessionId to SDK listeners", () => {
    const { client, serverSide } = setup();
    const request: ApprovalRequest = {
      toolName: "__ask_user__",
      args: { question: "Continue?" },
      description: "Ask the user",
      riskLevel: "low",
    };
    let seen:
      | {
          requestId: string;
          request: ApprovalRequest;
          meta: { sessionId?: string } | undefined;
        }
      | undefined;

    client.onApprovalRequest((requestId, receivedRequest, meta) => {
      seen = { requestId, request: receivedRequest, meta };
    });

    serverSide.send(
      createNotification(Methods.ApprovalRequest, {
        sessionId: "session-a",
        requestId: "approval-1",
        request,
      }),
    );

    expect(seen).toEqual({
      requestId: "approval-1",
      request,
      meta: { sessionId: "session-a" },
    });
  });

  it("emits approvalResolved with sessionId and requestId", () => {
    const { client, serverSide } = setup();
    let seen: { sessionId?: string; requestId: string } | undefined;

    client.onApprovalResolved((event) => {
      seen = event;
    });

    serverSide.send(
      createNotification(Methods.ApprovalResolved, {
        sessionId: "session-a",
        requestId: "approval-1",
      }),
    );

    expect(seen).toEqual({
      sessionId: "session-a",
      requestId: "approval-1",
    });
  });
});
