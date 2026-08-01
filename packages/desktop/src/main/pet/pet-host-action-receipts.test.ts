// Replayed turns must not repeat their side effects.
//
// Core treats `clientMessageId` as a stable submission intent: submitting the
// same id twice replays the persisted run_result instead of re-running the model.
// The Desktop pet dispatcher could not tell a fresh result from a replayed one,
// so it re-read `extensions.pet.hostActions` and ran every executor again — a
// duplicate delivery could create a second Todo or send a second proactive
// message.
//
// Reachable in practice: the Chat Gateway derives a stable id from the upstream
// message id, its reply cache is only an in-process Map, and the inbox is
// durable. A restart between "Desktop finished" and "adapter acknowledged"
// re-invokes Desktop with the same id.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetHostActionReceiptStore } from "./pet-host-action-receipts.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pet-receipts-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(): PetHostActionReceiptStore {
  return new PetHostActionReceiptStore(join(dir, "receipts.json"));
}

describe("PetHostActionReceiptStore", () => {
  test("an unrecorded action has no receipt", async () => {
    expect(await store().find("pet-1", "msg-1", 0)).toBeUndefined();
  });

  test("a recorded success replays with its result", async () => {
    const s = store();
    await s.record("pet-1", "msg-1", 0, {
      kind: "outboundMessage",
      ok: true,
      result: { delivered: true },
      completedAt: 1,
    });

    const receipt = await s.find("pet-1", "msg-1", 0);
    expect(receipt?.ok).toBe(true);
    expect(receipt?.result).toEqual({ delivered: true });
  });

  test("a recorded failure also replays, so a retry does not re-attempt it", async () => {
    const s = store();
    await s.record("pet-1", "msg-1", 0, {
      kind: "outboundMessage",
      ok: false,
      error: "channel offline",
      completedAt: 1,
    });

    const receipt = await s.find("pet-1", "msg-1", 0);
    expect(receipt?.ok).toBe(false);
    expect(receipt?.error).toBe("channel offline");
  });

  test("receipts are per action index, not per turn", async () => {
    // The partial-failure case: action 0 succeeded, action 1 never ran. A retry
    // must replay 0 and actually execute 1.
    const s = store();
    await s.record("pet-1", "msg-1", 0, { kind: "todo", ok: true, completedAt: 1 });

    expect(await s.find("pet-1", "msg-1", 0)).toBeDefined();
    expect(await s.find("pet-1", "msg-1", 1)).toBeUndefined();
  });

  test("receipts are scoped by session and message id", async () => {
    const s = store();
    await s.record("pet-1", "msg-1", 0, { kind: "todo", ok: true, completedAt: 1 });

    // A different turn, or a different pet session, is not a replay.
    expect(await s.find("pet-1", "msg-2", 0)).toBeUndefined();
    expect(await s.find("pet-2", "msg-1", 0)).toBeUndefined();
  });

  test("receipts survive a process restart", async () => {
    // The whole point: an in-memory Map would not have helped, because the
    // duplicate arrives after a restart.
    const first = store();
    await first.record("pet-1", "msg-1", 0, {
      kind: "outboundMessage",
      ok: true,
      result: { messageId: "abc" },
      completedAt: 1,
    });

    const reopened = store();
    const receipt = await reopened.find("pet-1", "msg-1", 0);
    expect(receipt?.result).toEqual({ messageId: "abc" });
  });

  test("a corrupt log degrades to no-receipts instead of throwing", async () => {
    const path = join(dir, "receipts.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "not json at all");
    const s = new PetHostActionReceiptStore(path);
    // Worst case a genuinely duplicated turn repeats once — far better than
    // blocking every host action.
    expect(await s.find("pet-1", "msg-1", 0)).toBeUndefined();
    await s.record("pet-1", "msg-1", 0, { kind: "todo", ok: true, completedAt: 1 });
    expect(await s.find("pet-1", "msg-1", 0)).toBeDefined();
  });

  test("concurrent records are serialized and all persist", async () => {
    const s = store();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        s.record("pet-1", "msg-1", i, { kind: "todo", ok: true, completedAt: i }),
      ),
    );
    for (let i = 0; i < 12; i += 1) {
      expect(await s.find("pet-1", "msg-1", i)).toBeDefined();
    }
  });
});
