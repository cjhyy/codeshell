// Author rotation must move the OUTGOING author into the critic pool and keep
// the INCOMING author out of it.
//
// The bug: `criticsForRound()` took a round number, ignored it, and returned
// `config.critics` unchanged. With `round-robin` / `best-critic`, once critic B
// was promoted to author, B kept critiquing the draft B had just written, and
// the original author A never became a critic — the inverse of the documented
// "pool minus current author" rule. `fixed` rotation hid this, which is why the
// existing suite stayed green.
//
// criticsForRound is private (it is pure selection logic, not I/O), so the test
// reaches it directly rather than mocking a model client and four phase modules.
import { describe, expect, test } from "bun:test";
import { IterativeArena } from "./iterative-arena.js";
import type { ArenaParticipant } from "../types.js";

const author: ArenaParticipant = { name: "A", model: "m-a" } as ArenaParticipant;
const criticB: ArenaParticipant = { name: "B", model: "m-b" } as ArenaParticipant;
const criticC: ArenaParticipant = { name: "C", model: "m-c" } as ArenaParticipant;

function arena(overrides: Record<string, unknown> = {}): IterativeArena {
  return new IterativeArena({
    subject: "s",
    author,
    critics: [criticB, criticC],
    ...overrides,
  } as never);
}

/** Reach the private selection helper. */
function criticsFor(instance: IterativeArena, current: ArenaParticipant): string[] {
  const fn = (instance as unknown as {
    criticsForRound: (p: ArenaParticipant) => ArenaParticipant[];
  }).criticsForRound.bind(instance);
  return fn(current).map((p) => p.name);
}

describe("IterativeArena.criticsForRound", () => {
  test("original author is excluded while they hold the pen", () => {
    expect(criticsFor(arena(), author).sort()).toEqual(["B", "C"]);
  });

  test("a promoted critic does not review their own draft", () => {
    // B wrote the current draft → B must not be a critic; A rejoins the pool.
    const critics = criticsFor(arena(), criticB);
    expect(critics).not.toContain("B");
    expect(critics.sort()).toEqual(["A", "C"]);
  });

  test("rotation to the last critic likewise swaps the pool", () => {
    const critics = criticsFor(arena(), criticC);
    expect(critics).not.toContain("C");
    expect(critics.sort()).toEqual(["A", "B"]);
  });

  test("every participant is a valid author and is never their own critic", () => {
    const instance = arena({ authorRotation: "round-robin" });
    for (const current of [author, criticB, criticC]) {
      const critics = criticsFor(instance, current);
      expect(critics).not.toContain(current.name);
      // Pool is {A,B,C}; exactly one is the author, so two critics remain.
      expect(critics).toHaveLength(2);
    }
  });

  test("degenerate single-participant config still yields reviewers", () => {
    // author === the only critic name would otherwise produce an empty pool and
    // silently run a round with nobody reviewing.
    const solo = new IterativeArena({
      subject: "s",
      author,
      critics: [criticB],
    } as never);
    expect(criticsFor(solo, criticB)).toEqual(["A"]);
    // Author holds the pen → B reviews.
    expect(criticsFor(solo, author)).toEqual(["B"]);
  });
});
