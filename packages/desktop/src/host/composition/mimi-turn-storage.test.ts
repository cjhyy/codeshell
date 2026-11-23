import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storedMimiTurns } from "./mimi-turn-storage.js";
import type { MimiTurnStorageCommand } from "../../shared/mimi-turn-storage.js";

test("a revoked turn cannot claim a host action or mark a report delivered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimi-action-receipts-"));
  try {
    const turns = storedMimiTurns(dir);
    const permit = () => new Int32Array(new SharedArrayBuffer(4));
    const claim: MimiTurnStorageCommand = {
      action: "claim",
      args: ["pet-session", "request-1", 0, "outboundMessage"],
    };
    const reportId="a".repeat(32);
    const recorded: MimiTurnStorageCommand = { action: "markDelivered", args: [reportId] };
    const revoked = permit();
    Atomics.store(revoked, 0, -1);
    await expect(turns({ cmd: claim, permit: revoked })).rejects.toThrow("withdrawn");
    await expect(turns({ cmd: recorded, permit: revoked })).rejects.toThrow("withdrawn");
    expect(
      await turns({ cmd: { action: "delivered", args: [reportId] }, permit: permit() }),
    ).toBe(false);
    expect(await turns({ cmd: claim, permit: permit() })).toMatchObject({ claimed: true });
    expect(await storedMimiTurns(dir)({ cmd: claim, permit: permit() })).toMatchObject({
      claimed: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
