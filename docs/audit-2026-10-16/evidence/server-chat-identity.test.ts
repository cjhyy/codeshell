import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryQueue } from "../../../packages/chat/src/delivery-queue.ts";
import { ChatGateway } from "../../../packages/chat/src/chat-gateway.ts";
import type { ChannelAdapter, ChannelMessage, ChannelMessageHandler } from "../../../packages/chat/src/channel.ts";

// These fake adapters never call a platform, model, or network endpoint.
globalThis.fetch = (() => { throw new Error("Audit fixture denies all fetch"); }) as typeof fetch;
const settings = {
  maxPending: 10, maxConcurrent: 0, maxPerTarget: 1,
  retryBaseMs: 10, retryMaxMs: 20, completedTtlMs: 60_000,
};
const input: ChannelMessage = {
  channel: "custom", target: "local-target", senderId: "local-user",
  messageId: "local-message", text: "private account B content",
};
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 2_000;
  while (!await check()) {
    if (Date.now() > end) throw new Error("fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
function adapter(account: string) {
  let handler: ChannelMessageHandler | undefined;
  const sends: string[] = [];
  const instance: ChannelAdapter = {
    channel: "custom",
    run: async (incoming, signal) => {
      handler = incoming;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    send: async (_target, outgoing) => { sends.push(`${account}:${outgoing.text}`); },
  };
  return { instance, sends, ready: () => Boolean(handler), emit: (message: ChannelMessage) => handler!(message) };
}

test("durable same-channel ordinal replays account B input through account A after reorder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-audit-chat-ordinal-"));
  const path = join(dir, "inbox.json");
  const a = adapter("A"), b = adapter("B");
  const stop1 = new AbortController();
  const first = new ChatGateway({ adapters: [a.instance, b.instance], delivery: { ...settings, path } });
  const running1 = first.run(stop1.signal);
  try {
    await waitUntil(() => b.ready());
    await b.emit(input);
    expect(JSON.parse(await readFile(path, "utf8")).pending[0].adapterId).toBe("custom:1");
  } finally { stop1.abort(); await running1; }
  const a2 = adapter("A"), b2 = adapter("B");
  const stop2 = new AbortController();
  const second = new ChatGateway({ adapters: [b2.instance, a2.instance], delivery: { ...settings, maxConcurrent: 1, path } });
  second.use(async ({ message, reply }) => { await reply({ text: message.text }); });
  const running2 = second.run(stop2.signal);
  try {
    await waitUntil(() => a2.sends.length > 0 || b2.sends.length > 0);
    expect(a2.sends).toEqual(["A:private account B content"]);
    expect(b2.sends).toEqual([]);
    console.log("AUDIT ordinal account B durable input was sent through account A");
  } finally { stop2.abort(); await running2; await rm(dir, { recursive: true, force: true }); }
});

test("same-channel dedupe suppresses the second distinct adapter's input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-audit-chat-dedupe-"));
  const path = join(dir, "inbox.json");
  const a = adapter("A"), b = adapter("B");
  const stop = new AbortController();
  const gateway = new ChatGateway({ adapters: [a.instance, b.instance], delivery: { ...settings, path } });
  const running = gateway.run(stop.signal);
  try {
    await waitUntil(() => a.ready() && b.ready());
    await a.emit({ ...input, text: "account A input" });
    await b.emit(input);
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0].adapterId).toBe("custom:0");
    console.log("AUDIT both adapter handlers resolved; only account A is durable");
  } finally { stop.abort(); await running; await rm(dir, { recursive: true, force: true }); }
});

test("valid small attachment is acknowledged memory-only after spool I/O failure and lost on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-audit-chat-spool-"));
  const path = join(dir, "inbox.json"), spool = join(dir, "spool");
  await writeFile(spool, "simulate temporarily unavailable spool directory");
  // Start before the directory obstruction is installed: startup correctly rejects it.
  await rm(spool);
  const queue = new DeliveryQueue({ ...settings, path, attachmentSpoolDir: spool }, async () => {}, () => {});
  await queue.start();
  await writeFile(spool, "blocked");
  try {
    const accepted = await queue.enqueue("custom:0", {
      ...input,
      attachments: [{ id: "a", kind: "file", name: "one.bin", size: 1, load: async () => new Uint8Array([7]) }],
    });
    expect(accepted).toBe("queued");
    expect(queue.status().pending).toBe(1);
    queue.stop();
    await rm(spool); await mkdir(spool);
    const restored = new DeliveryQueue({ ...settings, path, attachmentSpoolDir: spool }, async () => {}, () => {});
    await restored.start();
    expect(restored.status().pending).toBe(0);
    restored.stop();
    console.log("AUDIT attachment enqueue=queued pending=1; fresh queue after restart pending=0");
  } finally { queue.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("normal small attachment persists and restores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-audit-chat-control-"));
  const path = join(dir, "inbox.json");
  const queue = new DeliveryQueue({ ...settings, path }, async () => {}, () => {});
  try {
    await queue.start();
    await queue.enqueue("custom:0", { ...input, attachments: [{ id: "a", kind: "file", size: 1, load: async () => new Uint8Array([7]) }] });
    queue.stop();
    const restored = new DeliveryQueue({ ...settings, path }, async () => {}, () => {});
    await restored.start(); expect(restored.status().pending).toBe(1); restored.stop();
  } finally { queue.stop(); await rm(dir, { recursive: true, force: true }); }
});
