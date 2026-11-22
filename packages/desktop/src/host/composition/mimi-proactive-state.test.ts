import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storedMimiProactiveState } from "./mimi-proactive-state.js";
import { HEARTBEAT_JUDGE_CAP, HEARTBEAT_SAY_CAP } from "../../main/pet/pet-proactive-state.js";
import type { MimiProactiveCommand } from "../../shared/mimi-proactive-state.js";

test("one Host owner enforces the daily inference and send caps across concurrent requests and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mimi-daily-counts-"));
  const permit = () => new Int32Array(new SharedArrayBuffer(4));
  const send = (
    owner: ReturnType<typeof storedMimiProactiveState>,
    call: MimiProactiveCommand,
    word = permit(),
  ) => owner({ call, permit: word });
  try {
    const first = storedMimiProactiveState(directory);
    const reserve = { type: "reserveJudgement", day: 50, since: 100 } as const;
    const revoked = permit();
    Atomics.store(revoked, 0, -1);
    await expect(send(first, reserve, revoked)).rejects.toThrow("expired");
    const reservations = await Promise.all(
      Array.from({ length: HEARTBEAT_JUDGE_CAP + 3 }, () => send(first, reserve)),
    );
    expect(reservations.filter((row) => "committed" in row && row.committed)).toHaveLength(
      HEARTBEAT_JUDGE_CAP,
    );
    const advance: MimiProactiveCommand = {
      type: "advance",
      day: 50,
      at: 120,
      seen: ["receipt"],
      said: true,
    };
    const sends = await Promise.all(
      Array.from({ length: HEARTBEAT_SAY_CAP + 2 }, () => send(first, advance)),
    );
    expect(sends.filter((row) => "committed" in row && row.committed)).toHaveLength(
      HEARTBEAT_SAY_CAP,
    );
    const restored = storedMimiProactiveState(directory);
    expect(await send(restored, reserve)).toEqual({ committed: false });
    expect(await send(restored, { type: "read" })).toMatchObject({
      state: {
        heartbeat: { day: 50, lastAt: 120, judged: HEARTBEAT_JUDGE_CAP, said: HEARTBEAT_SAY_CAP },
      },
    });
    expect(await send(restored, { ...reserve, day: 51 })).toEqual({ committed: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
