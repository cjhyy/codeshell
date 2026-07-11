import { describe, test, expect } from "bun:test";
import type { Engine } from "../engine/engine.js";
import { ChatSessionManager } from "./chat-session-manager.js";

describe("ChatSessionManager MCP owner lifecycle", () => {
  test("close unregisters the session engine from the shared MCP pool", async () => {
    const engine = {} as Engine;
    const unregistered: unknown[] = [];
    const manager = new ChatSessionManager({
      runtime: {
        mcpPool: {
          unregisterOwner: async (owner: unknown) => {
            unregistered.push(owner);
          },
        },
      } as never,
      engineFactory: () => engine,
    });

    await manager.getOrCreate("s1", {} as never);
    await manager.close("s1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unregistered).toEqual([engine]);
  });
});
