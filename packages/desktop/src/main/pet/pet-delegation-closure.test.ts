import { describe, expect, it } from "bun:test";

import { recordPetDelegationClosureBestEffort } from "./pet-delegation-closure.js";

describe("recordPetDelegationClosureBestEffort", () => {
  it("contains distillation failures so later closure effects can continue", async () => {
    const errors: unknown[] = [];
    const laterEffects: string[] = [];

    const recorded = await recordPetDelegationClosureBestEffort(
      {
        onDelegationClosed: async () => {
          throw new Error("memory store unavailable");
        },
      },
      { dedupeKey: "task:1:completed", objective: "finish", outcome: "completed" },
      (error) => errors.push(error),
    );
    laterEffects.push("closure-recorded", "chat", "gateway", "desktop-notification");

    expect(recorded).toBe(false);
    expect(errors).toHaveLength(1);
    expect(laterEffects).toEqual(["closure-recorded", "chat", "gateway", "desktop-notification"]);
  });
});
