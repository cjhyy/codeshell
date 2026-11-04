import { expect, test } from "bun:test";
import { ChatGateway, type AdapterRuntimeState } from "./chat-gateway.js";
import type { ChannelAdapter, ChannelRunLifecycle } from "./channel.js";
import { waitForAbort } from "./lifecycle.js";
import { TelegramAdapter } from "./telegram.js";

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error("fixture timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("readiness requires transport confirmation and is revoked during reconnect", async () => {
  let lifecycle: ChannelRunLifecycle | undefined;
  const adapter: ChannelAdapter = {
    channel: "fixture",
    async run(_handler, signal, observer) {
      lifecycle = observer;
      await waitForAbort(signal);
    },
    async send() {},
  };
  const gateway = new ChatGateway({ adapters: [adapter] });
  expect(gateway.healthSnapshot().status).toBe("degraded");
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  try {
    await until(() => !!lifecycle);
    expect(gateway.healthSnapshot().status).toBe("degraded");
    lifecycle!.ready();
    expect(gateway.healthSnapshot().status).toBe("ready");
    lifecycle!.unavailable("reconnecting");
    expect(gateway.healthSnapshot().status).toBe("degraded");
    lifecycle!.ready();
    expect(gateway.healthSnapshot().status).toBe("ready");
  } finally {
    stop.abort();
    await running;
  }
  lifecycle!.ready();
  expect(gateway.healthSnapshot().status).toBe("degraded");
});

test("an immediate failure never reports ready and a healthy run resets retry backoff", async () => {
  const states: AdapterRuntimeState[] = [];
  let runs = 0;
  let oldReady: (() => void) | undefined;
  let current: ChannelRunLifecycle | undefined;
  let disconnect!: () => void;
  const adapter: ChannelAdapter = {
    channel: "fixture",
    async run(_handler, signal, lifecycle) {
      runs++;
      if (runs === 1) {
        oldReady = lifecycle!.ready;
        throw new Error("startup failed");
      }
      if (runs === 2) {
        current = lifecycle;
        await new Promise<void>((_resolve, reject) => {
          disconnect = () => reject(new Error("disconnected"));
        });
        return;
      }
      lifecycle!.ready();
      await waitForAbort(signal);
    },
    async send() {},
  };
  const gateway = new ChatGateway({
    adapters: [adapter],
    adapterRestart: { baseMs: 2, maxMs: 10, healthyResetMs: 10 },
    onAdapterState: (state) => states.push(state),
  });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  try {
    await until(() => !!current);
    expect(states.some((state) => state.state === "running")).toBe(false);
    oldReady!();
    expect(gateway.healthSnapshot().status).toBe("degraded");
    current!.ready();
    await new Promise((r) => setTimeout(r, 20));
    disconnect();
    await until(() => runs === 3);
    expect(
      states.filter((state) => state.state === "backoff").map((state) => state.attempts),
    ).toEqual([1, 1]);
  } finally {
    stop.abort();
    disconnect?.();
    await running;
  }
});

test("a legacy two-argument adapter becomes ready on its first inbound event", async () => {
  let emit!: () => Promise<void>;
  const adapter: ChannelAdapter = {
    channel: "fixture",
    async run(handler, signal) {
      emit = () => handler({ channel: "fixture", target: "room", text: "hello" });
      await waitForAbort(signal);
    },
    async send() {},
  };
  const gateway = new ChatGateway({ adapters: [adapter] });
  const stop = new AbortController();
  const running = gateway.run(stop.signal);
  try {
    await until(() => !!emit);
    expect(gateway.healthSnapshot().status).toBe("degraded");
    await emit();
    expect(gateway.healthSnapshot().status).toBe("ready");
  } finally {
    stop.abort();
    await running;
  }
});

test("Telegram reports ready only after a successful poll, even with an empty batch", async () => {
  let resolve!: (response: Response) => void;
  let ready = 0;
  const stop = new AbortController();
  const adapter = new TelegramAdapter({ botToken: "fixture" }, {
    fetch: async () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  });
  const running = adapter.run(async () => {}, stop.signal, {
    ready() {
      ready++;
      stop.abort();
    },
    unavailable() {},
  });
  await until(() => !!resolve);
  expect(ready).toBe(0);
  resolve(Response.json({ ok: true, result: [] }));
  await running;
  expect(ready).toBe(1);
});
