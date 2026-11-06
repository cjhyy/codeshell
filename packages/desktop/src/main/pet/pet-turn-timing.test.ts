import { describe, expect, test } from "bun:test";
import { createPetTurnTimer } from "./pet-turn-timing";

describe("createPetTurnTimer", () => {
  test("records each phase once and reports the total", async () => {
    let now = 1_000;
    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const timer = createPetTurnTimer({
      clientMessageId: "m-1",
      now: () => now,
      log: (msg, data) => logs.push({ msg, data }),
    });
    const value = await timer.phase("sources", async () => {
      now += 40;
      return 7;
    });
    expect(value).toBe(7);
    now += 5;
    timer.done();
    expect(logs).toEqual([
      { msg: "pet.turn.phase", data: { clientMessageId: "m-1", phase: "sources", ms: 40 } },
      { msg: "pet.turn.prep_total", data: { clientMessageId: "m-1", ms: 45 } },
    ]);
  });

  test("still records a phase that throws, then rethrows", async () => {
    let now = 0;
    const logs: string[] = [];
    const timer = createPetTurnTimer({
      clientMessageId: "m-2",
      now: () => now,
      log: (msg, data) =>
        logs.push(`${msg}:${String(data?.phase ?? "")}:${String(data?.ok ?? "")}`),
    });
    await expect(
      timer.phase("inbox", async () => {
        now += 3;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(logs).toEqual(["pet.turn.phase:inbox:false"]);
  });
});
