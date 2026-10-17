import { describe, expect, test } from "bun:test";
import { stripInjectedContextMessages } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/injected-context-cache.ts";
import { enqueueSteerItem, consumeSteerItems, removeSteerItem, type SteerItem } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/steer-queue.ts";
import type { Message, InputAttachmentMeta } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/types.ts";

describe("round15 cache and queue characterization (no Engine)", () => {
  test("cache removes only run-scoped identities and preserves equal durable content", () => {
    const injected: Message = { role: "user", content: "same" };
    const dynamic: Message = { role: "user", content: "dynamic" };
    const durable: Message = { role: "user", content: "same" };
    const durableDynamic: Message = { role: "user", content: "dynamic" };
    const input = [injected, durable, dynamic, durableDynamic, dynamic];
    const output = stripInjectedContextMessages(input, injected, dynamic);
    expect(output).toEqual([durable, durableDynamic]);
    expect(output[0]).toBe(durable);
    expect(output[1]).toBe(durableDynamic);
    expect(input).toEqual([injected, durable, dynamic, durableDynamic, dynamic]);
  });

  test("cache with absent injections returns a new outer array, preserving message identity", () => {
    const message: Message = { role: "user", content: "ordinary task" };
    const input = [message];
    const output = stripInjectedContextMessages(input, null, null);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output[0]).toBe(message);
  });

  test("distinct ids preserve per-entry revocation and FIFO draining without mutating inputs", () => {
    const initial: SteerItem[] = [];
    const first = enqueueSteerItem(initial, "host-a", "  first  ", "client-a");
    const second = enqueueSteerItem(first, "host-b", "second", "client-b");
    const removal = removeSteerItem(second, "host-a");
    expect(removal.removed).toBe(true);
    expect(removal.list.map((item) => item.id)).toEqual(["host-b"]);
    expect(first).toEqual([{ id: "host-a", text: "first", clientMessageId: "client-a" }]);
    expect(second).toHaveLength(2);
    expect(initial).toEqual([]);
    const consumed = consumeSteerItems(removal.list);
    expect(consumed.drained[0]!.text).toBe("second");
    expect(consumed.rest).toEqual([]);
    expect(removeSteerItem(consumed.rest, "host-b").removed).toBe(false);
  });

  test("candidate: list-length ids can collide after a revoke, and helper revokes both", () => {
    // Only the pure helpers execute. The id expressions mirror the independently
    // inspected Engine.enqueueSteer default-id branch; no Engine is imported.
    let queue: SteerItem[] = [];
    queue = enqueueSteerItem(queue, `steer-${queue.length}`, "first");
    queue = enqueueSteerItem(queue, `steer-${queue.length}`, "second");
    queue = removeSteerItem(queue, "steer-0").list;
    queue = enqueueSteerItem(queue, `steer-${queue.length}`, "third");
    expect(queue.map((item) => item.id)).toEqual(["steer-1", "steer-1"]);
    expect(queue.map((item) => item.text)).toEqual(["second", "third"]);
    const removed = removeSteerItem(queue, "steer-1");
    expect(removed.removed).toBe(true);
    expect(removed.list).toEqual([]);
    expect(queue).toHaveLength(2);
    console.log("STEER-R15-C1", JSON.stringify({ beforeRevoke: queue, afterRevoke: removed.list, actualEngineExecuted: false }));
  });

  test("attachment list is copied at enqueue, without claiming a deep immutable snapshot", () => {
    const attachment = { id: "owned-meta", kind: "image", path: "owned.png" } as InputAttachmentMeta;
    const attachments = [attachment];
    const queue = enqueueSteerItem([], "host-a", "inspect", undefined, attachments);
    attachments.push({ id: "later-meta", kind: "image", path: "later.png" } as InputAttachmentMeta);
    expect(queue[0]!.attachments).toEqual([attachment]);
    expect(queue[0]!.attachments).not.toBe(attachments);
    expect(queue[0]!.attachments![0]).toBe(attachment);
  });
});
