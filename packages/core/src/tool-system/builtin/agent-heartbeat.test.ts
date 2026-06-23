import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AgentHeartbeatPinger } from "./agent-heartbeat.js";
import { asyncAgentRegistry } from "./agent-registry.js";

/**
 * B: while background agents are running, a pinger publishes periodic
 * `agent_heartbeat` events (per parent session) so the UI knows the agents are
 * alive even during long LLM-request silence where no other event fires. The
 * pinger stops itself when no agent is running (no idle spin).
 */
describe("AgentHeartbeatPinger", () => {
  let published: Array<{ sessionId: string; agentIds: string[]; ts: number }>;
  let pinger: AgentHeartbeatPinger;

  beforeEach(() => {
    asyncAgentRegistry.reset();
    published = [];
    pinger = new AgentHeartbeatPinger({
      intervalMs: 5,
      publish: (sessionId, event) => {
        if (event.type === "agent_heartbeat") {
          published.push({ sessionId, agentIds: event.agentIds, ts: event.ts });
        }
      },
      now: () => 1000,
    });
  });
  afterEach(() => {
    pinger.stop();
    asyncAgentRegistry.reset();
  });

  function register(agentId: string, sessionId: string) {
    asyncAgentRegistry.register({
      agentId,
      description: "d",
      sessionId,
      status: "running",
      startedAt: 0,
      abort: () => {},
    });
  }

  async function tick(ms = 20) {
    await new Promise((r) => setTimeout(r, ms));
  }

  it("publishes agent_heartbeat per session for running agents", async () => {
    register("a1", "s-1");
    register("a2", "s-1");
    register("b1", "s-2");
    pinger.start();
    await tick();
    pinger.stop();

    const s1 = published.find((p) => p.sessionId === "s-1");
    const s2 = published.find((p) => p.sessionId === "s-2");
    expect(s1).toBeDefined();
    expect(s1!.agentIds.sort()).toEqual(["a1", "a2"]);
    expect(s1!.ts).toBe(1000);
    expect(s2).toBeDefined();
    expect(s2!.agentIds).toEqual(["b1"]);
  });

  it("does not publish when no agent is running (no idle spin)", async () => {
    pinger.start();
    await tick();
    expect(published).toHaveLength(0);
  });

  it("excludes completed/failed agents from the heartbeat", async () => {
    register("a1", "s-1");
    register("a2", "s-1");
    asyncAgentRegistry.markCompleted("a2");
    pinger.start();
    await tick();
    pinger.stop();
    const s1 = published.find((p) => p.sessionId === "s-1");
    expect(s1!.agentIds).toEqual(["a1"]);
  });

  it("stop() halts further heartbeats", async () => {
    register("a1", "s-1");
    pinger.start();
    await tick();
    const countAfterStart = published.length;
    expect(countAfterStart).toBeGreaterThan(0);
    pinger.stop();
    const countAtStop = published.length;
    await tick();
    expect(published.length).toBe(countAtStop);
  });

  it("start() is idempotent (no double timer)", async () => {
    register("a1", "s-1");
    pinger.start();
    pinger.start(); // second start must not stack a second interval
    await tick(12); // ~2 intervals
    pinger.stop();
    // With one 5ms timer over ~12ms we expect ~2 ticks, not ~4. Allow slack but
    // assert it's not doubled.
    expect(published.length).toBeLessThanOrEqual(3);
  });
});
