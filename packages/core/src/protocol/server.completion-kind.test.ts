import { describe, expect, test } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
import { AgentServer } from "./server.js";
import { AgentClient } from "./client.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { createInProcessTransport } from "./transport.js";

describe("RunResult completion kind", () => {
  for (const mode of ["interactive", "legacy"] as const) {
    test.each([undefined, "background_wait", "goal_control_stop", "limit_stop"] as const)(
      `${mode} serializes %s in the RPC response`,
      async (completionKind) => {
        const engine = {
          isHeadless: () => false,
          setAskUser() {},
          setBrowserBridge() {},
          setInjectCredential() {},
          setSessionMessageRouter() {},
          setPlanMode() {},
          async run(): Promise<EngineResult> {
            return {
              text: "launching",
              reason: "completed",
              ...(completionKind ? { completionKind } : {}),
              sessionId: "work",
              turnCount: 1,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
          },
        } as unknown as Engine;
        const [clientTransport, serverTransport] = createInProcessTransport();
        const server = new AgentServer({
          transport: serverTransport,
          ...(mode === "legacy"
            ? { engine }
            : {
                chatManager: new ChatSessionManager({
                  runtime: {} as never,
                  engineFactory: () => engine,
                }),
              }),
        });
        const client = new AgentClient({ transport: clientTransport });
        try {
          const result = await client.run({ sessionId: "work", task: "start background work" });
          expect(JSON.parse(JSON.stringify(result))).toMatchObject({
            reason: "completed",
            ...(completionKind ? { completionKind } : {}),
          });
          expect(result.completionKind).toBe(completionKind);
        } finally {
          server.close();
          client.close();
        }
      },
    );
  }
});
