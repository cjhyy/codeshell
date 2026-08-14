import { describe, expect, test } from "bun:test";
import { compileComposition } from "./compiler.js";
import { toCompositionSnapshot, computeCompositionDigest } from "./snapshot.js";

describe("composition snapshot and digest", () => {
  test("same input produces byte-identical snapshot and digest", () => {
    const a = compileComposition({});
    const b = compileComposition({});
    expect(JSON.stringify(toCompositionSnapshot(a))).toBe(JSON.stringify(toCompositionSnapshot(b)));
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("module order change changes the digest", () => {
    const modA = { id: "alpha", protocol: { hiddenSessionKinds: ["a"] } };
    const modB = { id: "beta", protocol: { hiddenSessionKinds: ["b"] } };
    const ab = compileComposition({ modules: [modA, modB] });
    const ba = compileComposition({ modules: [modB, modA] });
    expect(ab.digest).not.toBe(ba.digest);
  });

  test("snapshot contains no functions and result is frozen", () => {
    const composition = compileComposition({});
    const snapshot = toCompositionSnapshot(composition);
    const walk = (value: unknown): void => {
      expect(typeof value).not.toBe("function");
      if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(snapshot);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(composition.digest).toBe(computeCompositionDigest(snapshot));
  });
});
