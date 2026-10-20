import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatGateway, createRateLimitMiddleware } from "./chat-gateway.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  OutgoingMessage,
} from "./channel.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe("ChatGateway durable account identity", () => {
  const delivery = (path: string, maxConcurrent: number) => ({
    path,
    maxPending: 10,
    maxConcurrent,
    maxPerTarget: 1,
    retryBaseMs: 5,
    retryMaxMs: 10,
    completedTtlMs: 60_000,
  });
  const input: ChannelMessage = {
    channel: "custom",
    target: "room",
    senderId: "user",
    messageId: "m-1",
    text: "account B input",
  };

  test("replays a durable record through its own account after the adapters are reordered", async () => {
    const path = inboxPath();
    const a = emittingAdapter("custom", "A");
    const b = emittingAdapter("custom", "B");
    const stopFirst = new AbortController();
    const first = new ChatGateway({ adapters: [a, b], delivery: delivery(path, 0) });
    const firstRun = first.run(stopFirst.signal);
    await waitUntil(() => b.ready());
    await b.emit(input);
    stopFirst.abort();
    await firstRun;

    const a2 = emittingAdapter("custom", "A");
    const b2 = emittingAdapter("custom", "B");
    const stopSecond = new AbortController();
    const second = new ChatGateway({ adapters: [b2, a2], delivery: delivery(path, 1) });
    second.use(async ({ message, reply }) => reply({ text: message.text }));
    const secondRun = second.run(stopSecond.signal);
    await waitUntil(() => a2.replies.length + b2.replies.length > 0);
    stopSecond.abort();
    await secondRun;
    expect(b2.replies.map(({ message }) => message.text)).toEqual(["account B input"]);
    expect(a2.replies).toEqual([]);
  });

  test("refuses a durable multi-account channel whose adapters have no stable identity", async () => {
    const gateway = new ChatGateway({
      adapters: [emittingAdapter("custom"), emittingAdapter("custom")],
      delivery: delivery(inboxPath(), 0),
    });
    await expect(gateway.run(new AbortController().signal)).rejects.toThrow(/accountId/);
  });

  test("refuses duplicate account identities on one channel", async () => {
    const gateway = new ChatGateway({
      adapters: [emittingAdapter("custom", "A"), emittingAdapter("custom", "A")],
    });
    await expect(gateway.run(new AbortController().signal)).rejects.toThrow(/accountId/);
  });

  test("routes a legacy ordinal record to the channel's sole adapter", async () => {
    const path = inboxPath();
    writeLegacyRecord(path, "custom:0");
    const only = emittingAdapter("custom", "A");
    const stop = new AbortController();
    const gateway = new ChatGateway({ adapters: [only], delivery: delivery(path, 1) });
    gateway.use(async ({ message, reply }) => reply({ text: message.text }));
    const running = gateway.run(stop.signal);
    await waitUntil(() => only.replies.length > 0);
    stop.abort();
    await running;
    expect(only.replies.map(({ message }) => message.text)).toEqual(["legacy input"]);
  });

  test("keeps an ambiguous legacy ordinal record instead of guessing an account", async () => {
    const path = inboxPath();
    writeLegacyRecord(path, "custom:1");
    const a = emittingAdapter("custom", "A");
    const b = emittingAdapter("custom", "B");
    const errors: unknown[] = [];
    const stop = new AbortController();
    const gateway = new ChatGateway({
      adapters: [a, b],
      delivery: delivery(path, 1),
      onError: (error) => void errors.push(error),
    });
    gateway.use(async ({ message, reply }) => reply({ text: message.text }));
    const running = gateway.run(stop.signal);
    await waitUntil(() => errors.length > 0);
    stop.abort();
    await running;
    expect(a.replies).toEqual([]);
    expect(b.replies).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).pending).toHaveLength(1);
  });
});

function inboxPath(): string {
  const root = mkdtempSync(join(tmpdir(), "codeshell-chat-gateway-"));
  roots.push(root);
  return join(root, "state", "inbox.json");
}

function writeLegacyRecord(path: string, adapterId: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      pending: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          dedupeKey: "custom\0room\0user\0legacy",
          adapterId,
          message: {
            channel: "custom",
            target: "room",
            senderId: "user",
            messageId: "legacy",
            text: "legacy input",
          },
          attempts: 0,
          nextAttemptAt: 0,
        },
      ],
      completed: {},
    }),
  );
}

function emittingAdapter(
  channel: string,
  accountId?: string,
): ChannelAdapter & {
  replies: Array<{ target: string; message: OutgoingMessage }>;
  ready(): boolean;
  emit(message: ChannelMessage): Promise<void>;
} {
  const replies: Array<{ target: string; message: OutgoingMessage }> = [];
  let handler: ChannelMessageHandler | undefined;
  return {
    channel,
    ...(accountId ? { accountId } : {}),
    replies,
    ready: () => handler !== undefined,
    emit: (message) => handler!(message),
    run: async (incoming, signal) => {
      handler = incoming;
      await waitForSignal(signal);
    },
    send: async (target, message) => void replies.push({ target, message }),
  };
}

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
