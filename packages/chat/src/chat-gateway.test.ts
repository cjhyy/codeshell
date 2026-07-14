import { describe, expect, test } from "bun:test";
import { ChatGateway, createRateLimitMiddleware } from "./chat-gateway.js";
import type { ChannelAdapter, OutgoingMessage } from "./channel.js";

describe("ChatGateway standalone runtime", () => {
  test("runs generic middleware and replies through the source adapter", async () => {
    const adapter = fakeAdapter("custom");
    const gateway = new ChatGateway({ adapters: [adapter] });
    const visited: string[] = [];
    gateway.use(async (_context, next) => {
      visited.push("before");
      await next();
      visited.push("after");
    });
    gateway.use(async ({ message, reply }) => {
      visited.push(message.text);
      await reply({ text: `echo: ${message.text}` });
    });

    await gateway.dispatch(adapter, {
      channel: "custom",
      target: "room-1",
      senderId: "user-1",
      text: "hello",
    });

    expect(visited).toEqual(["before", "hello", "after"]);
    expect(adapter.replies).toEqual([{ target: "room-1", message: { text: "echo: hello" } }]);
  });

  test("supports multiple accounts for the same platform", async () => {
    const first = fakeAdapter("telegram");
    const second = fakeAdapter("telegram");
    const gateway = new ChatGateway({ adapters: [first, second] });
    gateway.use(async ({ reply }) => reply({ text: "ok" }));

    await gateway.dispatch(second, {
      channel: "telegram",
      target: "room-2",
      senderId: "user-2",
      text: "hello",
    });

    expect(first.replies).toEqual([]);
    expect(second.replies).toEqual([{ target: "room-2", message: { text: "ok" } }]);
  });

  test("restarts one failed adapter without stopping healthy channels", async () => {
    const abort = new AbortController();
    let failingRuns = 0;
    let healthyStopped = false;
    const states: string[] = [];
    const failing: ChannelAdapter = {
      channel: "failing",
      run: async (_handler, signal) => {
        failingRuns += 1;
        if (failingRuns === 1) throw new Error("boom");
        await waitForSignal(signal);
      },
      send: async () => undefined,
    };
    const healthy: ChannelAdapter = {
      channel: "healthy",
      run: async (_handler, signal) => {
        await waitForSignal(signal);
        healthyStopped = true;
      },
      send: async () => undefined,
    };
    const gateway = new ChatGateway({
      adapters: [failing, healthy],
      webhook: { port: 0 },
      adapterRestart: { baseMs: 5, maxMs: 5 },
      onAdapterState: ({ channel, state }) => states.push(`${channel}:${state}`),
    });
    const running = gateway.run(abort.signal);
    await waitUntil(() => failingRuns === 2);
    expect(healthyStopped).toBe(false);
    expect(states).toContain("failing:backoff");
    expect(gateway.healthSnapshot().status).toBe("ready");
    abort.abort();
    await running;
    expect(healthyStopped).toBe(true);
  });

  test("does not bind the webhook port when no channel needs a webhook route", async () => {
    // Two polling-only gateways sharing the same webhook host:port must both
    // run: a polling-only config must open no HTTP listener, so there is no
    // port to collide on. If either bound the port, the second run would reject.
    const abort = new AbortController();
    const polling = (): ChannelAdapter => ({
      channel: "telegram",
      run: async (_handler, signal) => void (await waitForSignal(signal)),
      send: async () => undefined,
    });
    const webhook = { host: "127.0.0.1", port: 8791 };
    const first = new ChatGateway({ adapters: [polling()], webhook });
    const second = new ChatGateway({ adapters: [polling()], webhook });
    const firstRun = first.run(abort.signal);
    const secondRun = second.run(abort.signal);
    // Give both a turn to reach steady state; neither should have thrown.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.healthSnapshot().status).toBe("ready");
    expect(second.healthSnapshot().status).toBe("ready");
    abort.abort();
    await Promise.all([firstRun, secondRun]);
  });

  test("rate limits each channel/sender independently", async () => {
    const adapter = fakeAdapter("custom");
    const gateway = new ChatGateway({ adapters: [adapter] });
    const accepted: string[] = [];
    gateway.use(createRateLimitMiddleware(1));
    gateway.use(async ({ message }) => void accepted.push(message.text));
    await gateway.dispatch(adapter, {
      channel: "custom",
      target: "room",
      senderId: "user",
      text: "first",
    });
    await gateway.dispatch(adapter, {
      channel: "custom",
      target: "room",
      senderId: "user",
      text: "second",
    });
    expect(accepted).toEqual(["first"]);
  });
});

async function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeAdapter(channel: string): ChannelAdapter & {
  replies: Array<{ target: string; message: OutgoingMessage }>;
} {
  const replies: Array<{ target: string; message: OutgoingMessage }> = [];
  return {
    channel,
    replies,
    run: async () => undefined,
    send: async (target, message) => void replies.push({ target, message }),
  };
}
