import { describe, expect, it } from "bun:test";
import { AgentClient } from "./client.js";
import { createInProcessTransport } from "./transport.js";
import {
  createErrorResponse,
  createNotification,
  createResponse,
  ErrorCodes,
  Methods,
  type RpcRequest,
} from "./types.js";
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

  it("round-trips connectionId and generation through the standard approve API", async () => {
    const { client, serverSide } = setup();
    const request: ApprovalRequest = {
      toolName: "Bash",
      args: { command: "rm protected.txt" },
      description: "Delete a protected file",
      riskLevel: "high",
    };
    let approvePromise: Promise<void> | undefined;
    let approveParams: Record<string, unknown> | undefined;

    serverSide.onMessage((message) => {
      const rpc = message as RpcRequest;
      if (rpc.method !== Methods.Approve) return;
      approveParams = rpc.params;
      const matches =
        rpc.params?.connectionId === "connection-a" &&
        rpc.params?.sessionId === "session-a" &&
        rpc.params?.generation === 7 &&
        rpc.params?.requestId === "approval-1";
      serverSide.send(
        matches
          ? createResponse(rpc.id, { ok: true })
          : createErrorResponse(rpc.id, ErrorCodes.InvalidParams, "approval tuple mismatch"),
      );
    });

    client.onApprovalRequest((requestId, _request, meta) => {
      expect(meta).toEqual({
        connectionId: "connection-a",
        sessionId: "session-a",
        generation: 7,
      });
      approvePromise = client.approve("session-a", requestId, { approved: true });
    });

    serverSide.send(
      createNotification(Methods.ApprovalRequest, {
        connectionId: "connection-a",
        sessionId: "session-a",
        generation: 7,
        requestId: "approval-1",
        request,
      }),
    );

    expect(approvePromise).toBeDefined();
    await approvePromise;
    expect(approveParams).toMatchObject({
      connectionId: "connection-a",
      sessionId: "session-a",
      generation: 7,
      requestId: "approval-1",
      decision: { approved: true },
    });
  });
});
