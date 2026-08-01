import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeliveryBackpressureError,
  DeliveryQueue,
  UnroutableDeliveryError,
} from "./delivery-queue.js";
import type { ChannelMessage } from "./channel.js";

const roots: string[] = [];

afterEach(async () => {
  // `stop()` prevents NEW work but does not await a persist already in flight.
  // Under full-suite load that write could land after the directory was removed,
  // surfacing as an ENOENT rename from a previous test's queue and failing an
  // unrelated one. Yield first so any pending atomic write completes.
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable delivery queue", () => {
  test("persists before acknowledgement, retries, and deduplicates platform message ids", async () => {
    const path = inboxPath();
    let attempts = 0;
    const delivered: string[] = [];
    const queue = new DeliveryQueue(
      config(path),
      async (_adapter, message) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        delivered.push(message.text);
      },
      () => undefined,
    );
    await queue.start();
    const message = incoming("m-1", "hello");
    expect(await queue.enqueue("line:0", message)).toBe("queued");
    expect(JSON.parse(readFileSync(path, "utf-8")).pending).toHaveLength(1);
    expect(await queue.enqueue("line:0", message)).toBe("duplicate");
    await waitUntil(() => delivered.length === 1);
    expect(attempts).toBe(2);
    await waitUntil(() => persistedPending(path) === 0);
    expect(await queue.enqueue("line:0", message)).toBe("duplicate");
    queue.stop();
  });

  test("recovers pending records and preserves per-target ordering", async () => {
    const path = inboxPath();
    const first = new DeliveryQueue(
      { ...config(path), maxConcurrent: 0 },
      async () => undefined,
      () => undefined,
    );
    await first.start();
    await first.enqueue("whatsapp:0", incoming("m-1", "one"));
    await first.enqueue("whatsapp:0", incoming("m-2", "two"));
    first.stop();

    const delivered: string[] = [];
    const recovered = new DeliveryQueue(
      config(path),
      async (_adapter, message) => void delivered.push(message.text),
      () => undefined,
    );
    await recovered.start();
    await waitUntil(() => delivered.length === 2);
    expect(delivered).toEqual(["one", "two"]);
    await waitUntil(() => persistedPending(path) === 0);
    recovered.stop();
  });

  test("rejects new work at the configured backpressure boundary", async () => {
    const blocker = deferred<void>();
    const queue = new DeliveryQueue(
      { ...config(undefined), maxPending: 1 },
      async () => blocker.promise,
      () => undefined,
    );
    await queue.start();
    await queue.enqueue("teams:0", incoming("m-1", "one"));
    expect(queue.enqueue("teams:0", incoming("m-2", "two"))).rejects.toBeInstanceOf(
      DeliveryBackpressureError,
    );
    queue.stop();
    blocker.resolve(undefined);
  });

  test("drops an unroutable record instead of retrying it forever", async () => {
    const path = inboxPath();
    let attempts = 0;
    const errors: unknown[] = [];
    const queue = new DeliveryQueue(
      config(path),
      async () => {
        attempts += 1;
        // Simulate a persisted record whose adapter no longer exists after a
        // config change: it can never be delivered.
        throw new UnroutableDeliveryError("Chat adapter no longer exists: discord:1");
      },
      (error) => void errors.push(error),
    );
    await queue.start();
    await queue.enqueue("discord:1", incoming("m-1", "orphaned"));

    // The record must be dropped after a single attempt, not retried on the
    // 30s cadence, and it must not linger in the durable inbox.
    await waitUntil(() => persistedPending(path) === 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    expect(queue.status().pending).toBe(0);
    queue.stop();
  });
});

function config(path: string | undefined) {
  return {
    ...(path ? { path } : {}),
    maxPending: 10,
    maxConcurrent: 4,
    maxPerTarget: 1,
    retryBaseMs: 5,
    retryMaxMs: 10,
    completedTtlMs: 60_000,
  };
}

function incoming(messageId: string, text: string): ChannelMessage {
  return {
    channel: "line",
    target: "room",
    senderId: "owner",
    messageId,
    text,
  };
}

function inboxPath(): string {
  const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-inbox-"));
  roots.push(root);
  return join(root, "state", "inbox.json");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function persistedPending(path: string): number {
  try {
    return JSON.parse(readFileSync(path, "utf-8")).pending.length;
  } catch {
    return -1;
  }
}

describe("attachment durability", () => {
  // Attachments used to force `persistent = false`, because a ChatAttachment
  // carries a `load()` closure that cannot be serialized. The record therefore
  // lived in memory ONLY — while the adapter had already been told the message
  // was accepted (Telegram advances its long-poll offset, Slack acks on handler
  // return). A restart between enqueue and delivery lost the message for good:
  // upstream never resends, and the durable inbox had no record of it.
  //
  // Bytes are now spooled to disk and the metadata persisted, so the record
  // survives exactly like a text-only one.
  const withAttachment = (messageId: string, bytes: number[]): ChannelMessage => ({
    ...incoming(messageId, "look at this"),
    attachments: [
      {
        id: "att-1",
        kind: "image",
        name: "shot.png",
        mimeType: "image/png",
        size: bytes.length,
        load: async () => Uint8Array.from(bytes),
      },
    ],
  });

  test("a message with attachments is persisted, not memory-only", async () => {
    const path = inboxPath();
    // maxConcurrent:0 holds the record pending so we can inspect what landed.
    const queue = new DeliveryQueue(
      { ...config(path), maxConcurrent: 0 },
      async () => undefined,
      () => undefined,
    );
    await queue.start();
    expect(await queue.enqueue("line:0", withAttachment("m-att", [1, 2, 3]))).toBe("queued");

    // Pre-fix this file had zero pending entries.
    expect(JSON.parse(readFileSync(path, "utf-8")).pending).toHaveLength(1);
    queue.stop();
  });

  test("the attachment survives a restart and its bytes are readable", async () => {
    const path = inboxPath();
    const first = new DeliveryQueue(
      { ...config(path), maxConcurrent: 0 },
      async () => undefined,
      () => undefined,
    );
    await first.start();
    await first.enqueue("line:0", withAttachment("m-restart", [9, 8, 7]));
    first.stop();

    // Fresh process: the closure is gone, so the bytes must come from the spool.
    const seen: Uint8Array[] = [];
    const second = new DeliveryQueue(
      config(path),
      async (_adapter, message) => {
        for (const attachment of message.attachments ?? []) {
          seen.push(await attachment.load());
        }
      },
      () => undefined,
    );
    await second.start();
    await waitUntil(() => seen.length === 1);
    expect([...seen[0]!]).toEqual([9, 8, 7]);
    second.stop();
  });

  test("attachment metadata round-trips through the restart", async () => {
    const path = inboxPath();
    const first = new DeliveryQueue(
      { ...config(path), maxConcurrent: 0 },
      async () => undefined,
      () => undefined,
    );
    await first.start();
    await first.enqueue("line:0", withAttachment("m-meta", [1]));
    first.stop();

    const observed: Array<{ id: string; name?: string; mimeType?: string }> = [];
    const second = new DeliveryQueue(
      config(path),
      async (_adapter, message) => {
        for (const attachment of message.attachments ?? []) {
          observed.push({
            id: attachment.id,
            ...(attachment.name ? { name: attachment.name } : {}),
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          });
        }
      },
      () => undefined,
    );
    await second.start();
    await waitUntil(() => observed.length === 1);
    expect(observed[0]).toEqual({ id: "att-1", name: "shot.png", mimeType: "image/png" });
    second.stop();
  });

  test("an oversized attachment falls back to memory rather than filling the disk", async () => {
    const path = inboxPath();
    const queue = new DeliveryQueue(
      { ...config(path), maxConcurrent: 0, maxSpooledAttachmentBytes: 2 },
      async () => undefined,
      () => undefined,
    );
    await queue.start();
    await queue.enqueue("line:0", withAttachment("m-big", [1, 2, 3, 4, 5]));
    // Not persisted — the pre-existing behaviour, kept deliberately for payloads
    // too large to spool. With nothing persistable the state file is never even
    // written, so treat a missing file as "zero pending".
    const pending = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf-8")) as { pending: unknown[] }).pending
      : [];
    expect(pending).toHaveLength(0);
    queue.stop();
  });

  test("text-only messages are unaffected", async () => {
    const path = inboxPath();
    const queue = new DeliveryQueue(
      { ...config(path), maxConcurrent: 0 },
      async () => undefined,
      () => undefined,
    );
    await queue.start();
    await queue.enqueue("line:0", incoming("m-text", "plain"));
    expect(JSON.parse(readFileSync(path, "utf-8")).pending).toHaveLength(1);
    queue.stop();
  });
});
