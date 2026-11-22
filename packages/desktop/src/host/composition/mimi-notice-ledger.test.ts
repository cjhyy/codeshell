import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoredMimiNoticeLedger } from "./mimi-notice-ledger.js";
import type { NoticeLedgerCall } from "../../shared/mimi-notice-ledger.js";
import type { NoticeRecord } from "../../main/pet/pet-notice-ledger.js";

test("the ledger owns claims, rejects revoked writes and recovers delivered or unknown receipts without retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimi-notice-owner-"));
  const newPermit = () => new Int32Array(new SharedArrayBuffer(4));
  const run = (owner: StoredMimiNoticeLedger, call: NoticeLedgerCall, permit = newPermit()) =>
    owner.run({ call, permit });
  try {
    const first = new StoredMimiNoticeLedger(directory);
    const record: NoticeLedgerCall = {
      method: "record",
      args: [
        {
          kind: "session.done",
          priority: "P1",
          dedupeKey: "fixture:done",
          sessionId: "fixture",
          ruleIds: [],
          facts: { title: "Fixture" },
          decision: { outlet: "desktop", reason: "present-desktop" },
        },
      ],
    };
    const revoked = newPermit();
    Atomics.store(revoked, 0, -1);
    await expect(run(first, record, revoked)).rejects.toThrow("expired");
    expect(await run(first, { method: "hasSeen", args: ["fixture:done"] })).toEqual({
      ok: true,
      value: false,
    });
    const saved = await run(first, record);
    if (!saved.ok) throw Error(saved.code);
    const id = (saved.value as NoticeRecord).id;
    await run(first, { method: "claim", args: [id, "fixture-offline", "test"] });
    const second = new StoredMimiNoticeLedger(directory);
    expect(
      await run(second, { method: "recoverOnStartup", args: [Date.now() + 24 * 60 * 60_000] }),
    ).toEqual({ ok: true, value: [] });
    expect(
      await run(second, {
        method: "readRows",
        args: [{ kind: "history", query: { sessionId: "fixture", limit: 1 } }],
      }),
    ).toMatchObject({ ok: true, value: [{ id, delivery: { status: "unknown", attempts: 1 } }] });
    expect(await run(second, { method: "claim", args: [id, "fixture-offline", "test"] })).toEqual({
      ok: false,
      code: "invalid_transition",
    });
    expect(await run(second, { method: "waiting", args: [] })).toEqual({ ok: true, value: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
