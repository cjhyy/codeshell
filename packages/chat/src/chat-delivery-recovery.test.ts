import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatGateway, createAllowlistMiddleware } from "./chat-gateway.ts";
import { TelegramAdapter } from "./telegram.ts";
import { createMimiPetChat } from "./gateway.ts";
const waitUntil = async (check: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const waitAbort = (signal: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal.aborted) r();
    else signal.addEventListener("abort", () => r(), { once: true });
  });
test("rejects non-allowlisted Telegram attachments before getFile or download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-telegram-review-"));
  const ac = new AbortController();
  let polls = 0,
    getFile = 0,
    download = 0,
    delivered = 0;
  const adapter = new TelegramAdapter(
    { botToken: "fake-fixture-token", apiBaseUrl: "https://telegram.invalid" },
    {
      fetch: async (input, init) => {
        const url = String(input);
        const ok = (result: any) => Response.json({ ok: true, result });
        if (url.endsWith("/getUpdates")) {
          polls++;
          if (polls === 1)
            return ok([
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 999, type: "private" },
                  from: { id: 999 },
                  document: { file_id: "fake-document", file_name: "x.bin" },
                },
              },
            ]);
          await waitAbort(init!.signal as AbortSignal);
          throw Error("fixture aborted");
        }
        if (url.endsWith("/getFile")) {
          getFile++;
          return ok({ file_path: "fake-document.bin" });
        }
        if (url === "https://telegram.invalid/file/botfake-fixture-token/fake-document.bin") {
          download++;
          return new Response(new Uint8Array([1, 2, 3]));
        }
        throw Error("UNEXPECTED NETWORK " + url);
      },
    },
  );
  const gateway = new ChatGateway({
    adapters: [adapter],
    delivery: { path: join(dir, "inbox.json") },
  });
  gateway.use(
    createAllowlistMiddleware({ telegram: { targetIds: ["owner"], userIds: ["owner"] } }),
  );
  gateway.use(async () => {
    delivered++;
  });
  const run = gateway.run(ac.signal);
  try {
    await waitUntil(() => polls >= 2 && gateway.healthSnapshot().inbox.pending === 0);
    expect(getFile).toBe(0);
    expect(download).toBe(0);
    expect(delivered).toBe(0);
  } finally {
    ac.abort();
    await run;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("replies independently to two accounts with the same platform message ID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-accounts-review-"));
  const path = join(dir, "inbox.json");
  const ac = new AbortController();
  const handlers: any[] = [];
  const sends = [0, 0];
  let calls = 0,
    release: any;
  const answer = new Promise<any>((r) => (release = r));
  const adapters = [0, 1].map((i) => ({
    channel: "telegram",
    accountId: "bot-" + i,
    run: async (h: any, signal: AbortSignal) => {
      handlers[i] = h;
      await waitAbort(signal);
    },
    send: async () => {
      sends[i]++;
    },
  }));
  const gateway = new ChatGateway({
    adapters,
    delivery: { path, maxConcurrent: 4, maxPerTarget: 4 },
  });
  gateway.use(
    createMimiPetChat({
      desktop: {
        petChat: async () => {
          calls++;
          return answer;
        },
      },
    }),
  );
  const run = gateway.run(ac.signal);
  try {
    await waitUntil(() => handlers.length === 2);
    const message = {
      channel: "telegram",
      target: "same-group",
      senderId: "same-user",
      messageId: "same-message",
      text: "hello",
    };
    await Promise.all(handlers.map((h) => h(message)));
    await waitUntil(() => calls === 2 && gateway.healthSnapshot().inbox.inFlight === 2);
    release({ text: "answer" });
    await waitUntil(() => gateway.healthSnapshot().inbox.pending === 0);
    const completed = Object.keys(JSON.parse(readFileSync(path, "utf8")).completed).length;
    expect(sends).toEqual([1, 1]);
    expect(completed).toBe(2);
  } finally {
    release?.({ text: "answer" });
    ac.abort();
    await run;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DeliveryQueue } from "./delivery-queue.js";
const queueConfig = (path: string) => ({
  path,
  maxPending: 1000,
  maxConcurrent: 1,
  maxPerTarget: 1,
  retryBaseMs: 100000,
  retryMaxMs: 100000,
  completedTtlMs: 604800000,
});
const incoming = (id: string) => ({
  channel: "telegram",
  target: "chat",
  senderId: "owner",
  messageId: id,
  text: "hello",
});
test("durable retries beyond 10000 survive restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-retry-fixed-"));
  const path = join(root, "inbox.json");
  let first: DeliveryQueue | undefined, second: DeliveryQueue | undefined;
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        pending: [
          {
            id: randomUUID(),
            adapterId: "telegram@bot-a",
            message: incoming("retry"),
            attempts: 10000,
            nextAttemptAt: 0,
          },
        ],
        completed: {},
      }),
    );
    first = new DeliveryQueue(
      queueConfig(path),
      async () => {
        throw Error("fixture offline");
      },
      () => {},
    );
    await first.start();
    await waitUntil(() => JSON.parse(readFileSync(path, "utf8")).pending[0]?.attempts === 10001);
    await first.stop();
    second = new DeliveryQueue(
      { ...queueConfig(path), maxConcurrent: 0 },
      async () => {},
      () => {},
    );
    await second.start();
    expect(second.status().pending).toBe(1);
  } finally {
    await first?.stop();
    await second?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test("over-cap completion history recovers and retains newest dedupe keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-completed-fixed-"));
  const path = join(root, "inbox.json");
  let queue: DeliveryQueue | undefined, restarted: DeliveryQueue | undefined;
  try {
    const now = Date.now();
    const completed = Object.fromEntries(
      Array.from({ length: 100001 }, (_, i) => ["key-" + i, now - 100001 + i]),
    );
    writeFileSync(path, JSON.stringify({ version: 1, pending: [], completed }));
    let delivered = 0;
    queue = new DeliveryQueue(
      queueConfig(path),
      async () => {
        delivered++;
      },
      () => {},
    );
    await queue.start();
    await queue.enqueue("telegram@bot-a", incoming("new"));
    await waitUntil(() => delivered === 1 && queue!.status().pending === 0);
    await queue.stop();
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(saved.completed)).toHaveLength(100000);
    expect(saved.completed["key-0"]).toBeUndefined();
    expect(saved.completed["key-100000"]).toBeNumber();
    restarted = new DeliveryQueue(
      queueConfig(path),
      async () => {
        delivered++;
      },
      () => {},
    );
    await restarted.start();
    await restarted.enqueue("telegram@bot-a", incoming("new"));
    await restarted.stop();
    expect(delivered).toBe(1);
  } finally {
    await queue?.stop();
    await restarted?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
