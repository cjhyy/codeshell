import { describe, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { AgentClient } from "./client.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { createInProcessTransport } from "./transport.js";
import { compileComposition } from "../composition/compiler.js";
import { LifetimeScope } from "../composition/lifetime.js";
import type { Engine } from "../engine/engine.js";

describe("AgentServer module lifetime", () => {
  test("close cancels pending host activation before waiting for the factory", async () => {
    const events: string[] = [];
    let cancel!: () => void;
    const composition = compileComposition({
      modules: [
        {
          id: "pending",
          async activateHost(ctx) {
            ctx.own(() => {
              events.push("cancel");
              cancel();
            });
            await new Promise<void>((resolve) => {
              cancel = resolve;
            });
            return () => {
              events.push("late-release");
            };
          },
        },
      ],
    });
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => ({}) as Engine,
    });
    const [transport] = createInProcessTransport();
    const server = new AgentServer({ transport, chatManager: manager, composition });
    await server.close();
    expect(events).toEqual(["cancel", "late-release"]);
  });

  test("disconnect releases only its observer/query/activation; a sibling transport keeps the shared Session", async () => {
    const host = new LifetimeScope("host", "tcp");
    let enginesReleased = 0;
    let observersClosed = 0;
    let resourcesReleased = 0;
    const manager = new ChatSessionManager({
      runtime: { lifetime: host } as never,
      engineFactory: () =>
        ({
          setAskUser() {},
          setSessionMessageRouter() {},
          isHeadless: () => false,
          async dispose() {
            enginesReleased++;
          },
        }) as unknown as Engine,
    });
    await manager.getOrCreate("shared", {});
    const composition = compileComposition({
      modules: [
        {
          id: "observer",
          protocol: {
            queries: { owned: () => "fallback" },
            createObserver(ctx) {
              ctx.registerQuery("owned", () => "active");
              return {
                onServerClose() {
                  observersClosed++;
                },
              };
            },
          },
          activateHost(ctx) {
            ctx.own(async () => {
              await Promise.resolve();
              resourcesReleased++;
            });
          },
        },
      ],
    });
    const [aTransport, aClientTransport] = createInProcessTransport();
    const [bTransport, bClientTransport] = createInProcessTransport();
    const a = new AgentServer({
      transport: aTransport,
      chatManager: manager,
      composition,
      connectionId: "a",
    });
    const b = new AgentServer({
      transport: bTransport,
      chatManager: manager,
      composition,
      connectionId: "b",
    });
    const aClient = new AgentClient({ transport: aClientTransport });
    const bClient = new AgentClient({ transport: bClientTransport });
    expect(await (aClient as any).request("owned")).toBe("active");
    a.disconnect();
    await (a as any).moduleScope.dispose();
    expect(resourcesReleased).toBe(1);
    expect(observersClosed).toBe(1);
    expect((a as any).protocolQueryHandlers.size).toBe(0);
    expect(manager.get("shared")).toBeDefined();
    expect(enginesReleased).toBe(0);
    expect(await (bClient as any).request("owned")).toBe("active");
    await b.close();
    await a.close();
    await host.dispose();
    expect(resourcesReleased).toBe(2);
    expect(observersClosed).toBe(2);
    expect(enginesReleased).toBe(1);
  });

  test("requests wait for host activation and close awaits asynchronous module disposal", async () => {
    let activate!: () => void;
    let release!: () => void;
    let disposing!: () => void;
    const disposalStarted = new Promise<void>((resolve) => {
      disposing = resolve;
    });
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => ({}) as Engine,
    });
    const composition = compileComposition({
      modules: [
        {
          id: "async",
          protocol: { queries: { owned: () => "ready" } },
          async activateHost() {
            await new Promise<void>((resolve) => {
              activate = resolve;
            });
            return () =>
              new Promise<void>((resolve) => {
                release = resolve;
                disposing();
              });
          },
        },
      ],
    });
    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({
      transport: serverTransport,
      chatManager: manager,
      composition,
    });
    const client = new AgentClient({ transport: clientTransport });
    let replied = false;
    const query = (client as any).request("owned").then((result) => {
      replied = true;
      return result;
    });
    await Promise.resolve();
    expect(replied).toBe(false);
    activate();
    expect(await query).toBe("ready");
    let closed = false;
    const closing = server.close();
    expect(server.close()).toBe(closing);
    void closing.then(() => {
      closed = true;
    });
    await disposalStarted;
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect((server as any).protocolQueryHandlers.size).toBe(0);
  });
});
