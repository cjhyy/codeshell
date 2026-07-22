import { describe, expect, test } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { EngineRunOptions } from "../engine/run-types.js";
import type { RouteSessionMessageInput } from "../session/session-message.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";

function makeTransport() {
  const sent: unknown[] = [];
  return {
    sent,
    transport: {
      send(message: unknown) {
        sent.push(message);
      },
      onMessage() {},
      close() {},
    } as never,
  };
}

describe("AgentServer cross-Session message routing", () => {
  test("enqueues the text as the target Session's ordinary user turn", async () => {
    const received: Array<{ task: string; options: EngineRunOptions }> = [];
    const engine = {
      isHeadless: () => true,
      sessionExistsOnDisk: () => false,
      async run(task: string, options: EngineRunOptions): Promise<EngineResult> {
        received.push({ task, options });
        return {
          text: "done",
          reason: "completed",
          sessionId: options.sessionId!,
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const transport = makeTransport();
    const server = new AgentServer({ transport: transport.transport, chatManager: manager });
    const catalog = [
      { sessionId: "prd", title: "Write PRD", workspaceRoot: "/project" },
      {
        sessionId: "ui",
        title: "Design UI",
        workspaceRoot: "/project",
        workspaceProfile: "designer",
      },
    ];
    const message = "  Read docs/prd.md and design the UI.  ";
    const input: RouteSessionMessageInput = {
      sourceSessionId: "prd",
      target: catalog[1]!,
      message,
      catalog,
    };

    try {
      await (
        server as unknown as {
          routeSessionMessage(value: RouteSessionMessageInput): Promise<void>;
        }
      ).routeSessionMessage(input);
      await manager.get("ui")?.settled;

      expect(received[0]?.task).toBe(message);
      expect(received[0]?.options.sessionId).toBe("ui");
      expect(received[0]?.options.workspaceProfile).toBe("designer");
      expect(received[0]?.options.sessionMessageTargets).toBe(catalog);
      expect(received[0]?.options.injected).toBeUndefined();
      expect(manager.get("ui")?.isBusy()).toBe(false);
      expect(transport.sent).toContainEqual({
        jsonrpc: "2.0",
        method: "agent/streamEvent",
        params: {
          sessionId: "ui",
          event: { type: "session_user_message", text: message },
        },
      });

      await (
        server as unknown as {
          routeSessionMessage(value: RouteSessionMessageInput): Promise<void>;
        }
      ).routeSessionMessage({ ...input, message: "follow-up" });
      await manager.get("ui")?.settled;
      expect(received[1]?.task).toBe("follow-up");
      expect(received[1]?.options.workspaceProfile).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
