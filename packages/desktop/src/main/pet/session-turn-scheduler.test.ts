import { describe, expect, test } from "bun:test";
import { AdmissionGate, resolveSteerOutcome, type SteerProbe } from "./session-turn-scheduler.js";

function probe(overrides: Partial<SteerProbe> = {}): SteerProbe {
  return {
    steer: async () => ({ accepted: true }),
    wasInjected: () => false,
    unsteer: async () => ({ removed: true }),
    runDone: async () => undefined,
    ...overrides,
  };
}

describe("resolveSteerOutcome", () => {
  test("a rejected steer runs as its own turn", async () => {
    // The engine rejects when no run is active, so the message must not be
    // silently dropped waiting for a turn that will never take it.
    expect(await resolveSteerOutcome(probe({ steer: async () => ({ accepted: false }) }))).toBe(
      "not-consumed",
    );
  });

  test("an observed injection counts as consumed", async () => {
    expect(await resolveSteerOutcome(probe({ wasInjected: () => true }))).toBe("consumed");
  });

  test("unsteer removing the entry means it never ran", async () => {
    expect(await resolveSteerOutcome(probe({ unsteer: async () => ({ removed: true }) }))).toBe(
      "not-consumed",
    );
  });

  test("unsteer failing to remove proves the loop already took it", async () => {
    // The only evidence available to a bridge with no live event stream.
    expect(await resolveSteerOutcome(probe({ unsteer: async () => ({ removed: false }) }))).toBe(
      "consumed",
    );
  });

  test("a transport failure re-runs rather than losing the message", async () => {
    const steerFailed = probe({
      steer: async () => {
        throw new Error("worker restarted");
      },
    });
    const unsteerFailed = probe({
      unsteer: async () => {
        throw new Error("worker restarted");
      },
    });
    expect(await resolveSteerOutcome(steerFailed)).toBe("not-consumed");
    expect(await resolveSteerOutcome(unsteerFailed)).toBe("not-consumed");
  });

  test("waits for the run to settle before judging injection", async () => {
    // Checking too early would unsteer an entry the loop was about to take.
    let settled = false;
    let injected = false;
    const result = await resolveSteerOutcome(
      probe({
        runDone: async () => {
          settled = true;
          injected = true;
        },
        wasInjected: () => injected,
        unsteer: async () => {
          throw new Error("must not be reached");
        },
      }),
    );
    expect(settled).toBe(true);
    expect(result).toBe("consumed");
  });

  test("a run that rejects still reaches a decision", async () => {
    const result = await resolveSteerOutcome(
      probe({
        runDone: async () => {
          throw new Error("run failed");
        },
        unsteer: async () => ({ removed: false }),
      }),
    );
    expect(result).toBe("consumed");
  });
});

describe("AdmissionGate", () => {
  test("serializes overlapping decisions", async () => {
    const gate = new AdmissionGate();
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        gate.run(async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(name);
          concurrent -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("a throwing operation does not wedge the gate", async () => {
    const gate = new AdmissionGate();
    await expect(
      gate.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await gate.run(() => "still works")).toBe("still works");
  });
});
