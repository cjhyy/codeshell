// Replayed turns must not repeat their side effects.
//
// Core treats `clientMessageId` as a stable submission intent: submitting the
// same id twice replays the persisted run_result instead of re-running the model.
// The Desktop pet dispatcher could not tell a fresh result from a replayed one,
// so it re-read `extensions.pet.hostActions` and ran every executor again — a
// duplicate delivery could repeat a follow-up mutation or send a second proactive
// message.
//
// Reachable in practice: the Chat Gateway derives a stable id from the upstream
// message id, its reply cache is only an in-process Map, and the inbox is
// durable. A restart between "Desktop finished" and "adapter acknowledged"
// re-invokes Desktop with the same id.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  test("claims before execution and preserves an interrupted action as uncertain", async () => {
    const path = join(dir, "receipts.json");
    const first = new PetHostActionReceiptStore(path);
    expect(await first.claim("pet-1", "msg-1", 0, "outboundMessage", 1)).toEqual({
      claimed: true,
    });

    const reopened = new PetHostActionReceiptStore(path);
    const replay = await reopened.claim("pet-1", "msg-1", 0, "outboundMessage", 2);
    expect(replay).toMatchObject({
      claimed: false,
      receipt: {
        kind: "outboundMessage",
        ok: false,
        phase: "claimed",
      },
    });
    if (!replay.claimed) expect(replay.receipt.error).toContain("为避免重复执行");
  });

  test("a completion atomically replaces the prior claim", async () => {
    const s = store();
    await s.claim("pet-1", "msg-1", 0, "outboundMessage", 1);
    await s.record("pet-1", "msg-1", 0, {
      kind: "outboundMessage",
      ok: true,
      result: { accepted: true },
      completedAt: 2,
    });

    expect(await s.find("pet-1", "msg-1", 0)).toMatchObject({
      kind: "outboundMessage",
      ok: true,
      phase: "completed",
      result: { accepted: true },
    });
  });

  test("concurrent claims elect exactly one executor", async () => {
    const s = store();
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => s.claim("pet-1", "msg-1", 0, "outboundMessage")),
    );
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.claimed)).toHaveLength(7);
  });

  test("a recorded success replays with its result", async () => {
    const s = store();
    await s.record("pet-1", "msg-1", 0, {
      kind: "outboundMessage",
      ok: true,
      result: { accepted: true },
      completedAt: 1,
    });

    const receipt = await s.find("pet-1", "msg-1", 0);
    expect(receipt?.ok).toBe(true);
    expect(receipt?.result).toEqual({ accepted: true });
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
    await s.record("pet-1", "msg-1", 0, {
      kind: "followUpMutation",
      ok: true,
      completedAt: 1,
    });

    expect(await s.find("pet-1", "msg-1", 0)).toBeDefined();
    expect(await s.find("pet-1", "msg-1", 1)).toBeUndefined();
  });

  test("receipts are scoped by session and message id", async () => {
    const s = store();
    await s.record("pet-1", "msg-1", 0, {
      kind: "followUpMutation",
      ok: true,
      completedAt: 1,
    });

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

  test("a corrupt log fails closed instead of risking a repeated side effect", async () => {
    const path = join(dir, "receipts.json");
    writeFileSync(path, "not json at all", { mode: 0o600 });
    const s = new PetHostActionReceiptStore(path);
    await expect(s.find("pet-1", "msg-1", 0)).rejects.toThrow("为避免重复执行，已阻止操作");
    await expect(s.claim("pet-1", "msg-1", 0, "outboundMessage")).rejects.toThrow(
      "为避免重复执行，已阻止操作",
    );
  });

  test("rejects ambiguous identities and unsafe receipt payloads", async () => {
    const s = store();
    await expect(s.claim("pet-1\0other", "msg-1", 0, "outboundMessage")).rejects.toThrow(
      "invalid Mimi host action receipt identity",
    );
    await expect(s.claim("pet-1", "msg-1", -1, "outboundMessage")).rejects.toThrow(
      "invalid Mimi host action receipt identity",
    );
    await expect(s.claim("pet-1", "msg-1", 0, "bad\nkind")).rejects.toThrow(
      "invalid Mimi host action receipt claim",
    );
    await expect(
      s.record("pet-1", "msg-1", 0, {
        kind: "outboundMessage",
        ok: false,
        error: "x".repeat(8_001),
        completedAt: 1,
      }),
    ).rejects.toThrow("invalid Mimi host action receipt");
  });

  test("stores owner-only files and fails closed on permissive file modes", async () => {
    const path = join(dir, "receipts.json");
    const s = new PetHostActionReceiptStore(path);
    await s.claim("pet-1", "msg-1", 0, "outboundMessage");
    if (process.platform === "win32") return;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    await expect(new PetHostActionReceiptStore(path).load()).rejects.toThrow(
      "权限必须为 0600",
    );
  });

  test("concurrent records are serialized and all persist", async () => {
    const s = store();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        s.record("pet-1", "msg-1", i, {
          kind: "followUpMutation",
          ok: true,
          completedAt: i,
        }),
      ),
    );
    for (let i = 0; i < 12; i += 1) {
      expect(await s.find("pet-1", "msg-1", i)).toBeDefined();
    }
  });

  test("capacity trimming never deletes an uncertain pre-execution claim", async () => {
    const path = join(dir, "receipts.json");
    const { readFileSync } = await import("node:fs");
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < 2_000; index += 1) {
      entries[["pet-1", `old-${index}`, "0"].join("\0")] = {
        kind: "followUpMutation",
        ok: true,
        phase: "completed",
        completedAt: index,
      };
    }
    entries[["pet-1", "uncertain", "0"].join("\0")] = {
      kind: "outboundMessage",
      ok: false,
      phase: "claimed",
      error: "outcome unknown",
      completedAt: -1,
    };
    writeFileSync(path, JSON.stringify({ version: 1, entries }), { mode: 0o600 });

    const s = new PetHostActionReceiptStore(path);
    await s.record("pet-1", "new-message", 0, {
      kind: "followUpMutation",
      ok: true,
      completedAt: 3_000,
    });

    expect(await s.find("pet-1", "uncertain", 0)).toMatchObject({ phase: "claimed" });
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { entries: object };
    expect(Object.keys(persisted.entries)).toHaveLength(2_000);
    expect(await s.find("pet-1", "old-0", 0)).toBeUndefined();
  });
});
