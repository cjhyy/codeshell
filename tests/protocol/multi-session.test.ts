/**
 * AgentServer multi-session tests.
 *
 * Verifies that the rewritten AgentServer dispatches through ChatSessionManager:
 *   1. Two sessions run concurrently without cross-talk.
 *   2. Missing sessionId → -32602 InvalidParams.
 *   3. Same-session second send queues behind the first.
 */
import { describe, it, expect } from "bun:test";
import { AgentServer } from "../../packages/core/src/protocol/server.ts";
import { ChatSessionManager } from "../../packages/core/src/protocol/chat-session-manager.ts";
import { createInProcessTransport } from "../../packages/core/src/protocol/transport.ts";
import { AgentClient } from "../../packages/core/src/protocol/client.ts";
import type { AgentStreamEventNotification } from "../../packages/core/src/protocol/types.ts";

function fakeRuntime(): any {
  return {};
}

/**
 * Returns a ChatSessionManager whose engineFactory creates a fake engine.
 * Each fake engine records onStream callbacks and simulates a short async run.
 */
function makeManager(maxSessions = 8) {
  return new ChatSessionManager({
    runtime: fakeRuntime(),
    engineFactory: (_slice: any) => ({
      permissionMode: "default",
      planMode: false,
      setPlanMode: (_v: boolean) => {},
      setPermissionMode: (_m: string) => {},
      setAskUser: (_fn: any) => {},
      setBrowserBridge: (_bridge: any) => {},
      setInjectCredential: (_fn: any) => {},
      isHeadless: () => false,
      run: async (task: string, opts: any) => {
        opts.onStream?.({ type: "text_delta", text: `t:${task}` });
        await new Promise((r) => setTimeout(r, 20));
        opts.onStream?.({ type: "turn_complete" });
        return {
          text: `done:${task}`,
          reason: "completed" as const,
          sessionId: opts.sessionId ?? "test",
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    }),
    maxSessions,
    idleTtlMs: 60_000,
  });
}

describe("AgentServer multi-session", () => {
  it("runs two sessions in parallel without cross-talk", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const cm = makeManager();
    new AgentServer({ chatManager: cm, transport: serverT });
    const client = new AgentClient({ transport: clientT });

    const eventsA: any[] = [];
    const eventsB: any[] = [];
    client.onStreamEvent((env: AgentStreamEventNotification) => {
      if (env.sessionId === "A") eventsA.push(env.event);
      if (env.sessionId === "B") eventsB.push(env.event);
    });

    const [a, b] = await Promise.all([
      client.run({ sessionId: "A", task: "hello-a" }),
      client.run({ sessionId: "B", task: "hello-b" }),
    ]);

    expect(a.text).toBe("done:hello-a");
    expect(b.text).toBe("done:hello-b");
    expect(eventsA.some((e) => e.type === "text_delta" && e.text === "t:hello-a")).toBe(true);
    expect(eventsB.some((e) => e.type === "text_delta" && e.text === "t:hello-b")).toBe(true);
    // Each session only sees its own text_delta events
    const aCrossEvents = eventsA.filter(
      (e) => e.type === "text_delta" && e.text !== "t:hello-a",
    );
    expect(aCrossEvents).toHaveLength(0);
  });

  it("agent/run without sessionId returns -32602", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const cm = makeManager();
    new AgentServer({ chatManager: cm, transport: serverT });
    const client = new AgentClient({ transport: clientT });

    // task only, no sessionId — should reject with InvalidParams
    await expect(
      client.run({ task: "x", sessionId: "" } as any),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("same-session second send queues behind the first", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const cm = makeManager();
    new AgentServer({ chatManager: cm, transport: serverT });
    const client = new AgentClient({ transport: clientT });

    const order: string[] = [];
    const a = client.run({ sessionId: "A", task: "a" }).then((r) => {
      order.push(r.text);
    });
    const b = client.run({ sessionId: "A", task: "b" }).then((r) => {
      order.push(r.text);
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["done:a", "done:b"]);
  });
});
