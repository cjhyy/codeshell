import { afterEach, describe, expect, test } from "bun:test";
import { compileComposition } from "../composition/compiler.js";
import { CONTRACTS } from "../contracts.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { createInProcessTransport } from "./transport.js";
import { ErrorCodes, Methods, type RpcMessage, type RpcResponse } from "./types.js";

const servers: AgentServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function fixture() {
  let enginesCreated = 0;
  const chatManager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory: () => {
      enginesCreated++;
      throw new Error("protocol controls must not create an engine");
    },
  });
  const [serverTransport, clientTransport] = createInProcessTransport();
  const sent: RpcMessage[] = [];
  clientTransport.onMessage((message) => sent.push(message));
  const server = new AgentServer({
    transport: serverTransport,
    chatManager,
    composition: compileComposition({
      modules: [
        {
          id: "dispatch-fixture",
          protocol: {
            queries: {
              echo: (params) => ({ received: params }),
              fail: async () => {
                throw new Error("extension failed");
              },
              [Methods.Initialize]: () => "extension must not replace initialize",
              [Methods.Cancel]: () => "extension must not replace cancel",
            },
          },
        },
      ],
    }),
  });
  servers.push(server);
  return {
    send: (id: string | number, method: string, params?: Record<string, unknown>) =>
      clientTransport.send({ jsonrpc: "2.0", id, method, params }),
    response: (id: string | number) =>
      sent.find((message) => "id" in message && message.id === id) as RpcResponse | undefined,
    get enginesCreated() {
      return enginesCreated;
    },
  };
}

describe("AgentServer request dispatch", () => {
  test("built-in controls keep their wire responses and synchronous effects ahead of aliases", () => {
    const f = fixture();
    f.send(0, Methods.Initialize, { protocolVersions: ["2"] });
    expect(f.response(0)?.result).toEqual({ protocolVersion: "1", contracts: CONTRACTS });

    f.send("cancel", Methods.Cancel, { sessionId: "missing" });
    expect(f.response("cancel")?.error).toEqual({
      code: ErrorCodes.SessionClosed,
      message: "No such session: missing",
    });

    f.send("background", Methods.BackgroundWork, {});
    expect(f.response("background")?.error).toEqual({
      code: ErrorCodes.InvalidParams,
      message: "sessionId is required",
    });
    expect(f.enginesCreated).toBe(0);
  });

  test("registered extension aliases preserve params, default params and classified errors", async () => {
    const f = fixture();
    f.send("echo", "echo", { value: [1, "two"] });
    f.send("default-params", "echo");
    f.send("failed", "fail");
    // Extension handlers may be asynchronous; transport replies settle on the next microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(f.response("echo")?.result).toEqual({ received: { value: [1, "two"] } });
    expect(f.response("default-params")?.result).toEqual({ received: {} });
    expect(f.response("failed")?.error).toEqual({
      code: ErrorCodes.InternalError,
      message: "extension failed",
    });
    expect(f.enginesCreated).toBe(0);
  });

  test("unknown and Object prototype method names return the legacy method-not-found error", () => {
    const f = fixture();
    for (const method of ["agent/not-registered", "toString", "constructor", "__proto__"]) {
      f.send(method, method);
      expect(f.response(method)?.error).toEqual({
        code: ErrorCodes.MethodNotFound,
        message: `Unknown method: ${method}`,
      });
    }
    expect(f.enginesCreated).toBe(0);
  });
});
