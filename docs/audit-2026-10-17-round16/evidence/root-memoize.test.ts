import { describe, expect, test } from "bun:test";
import { memoize } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/utils/memoize.ts";

describe("actual minimal memoize pure callbacks and supported cache API", () => {
  test("resolver sees arguments and equal keys retain the computed object", () => {
    let calls = 0;
    let resolutions = 0;
    const cached = memoize(
      (folder: string, pins: string[]) => ({ folder, pins, call: ++calls }),
      (folder: string, pins: string[]) => {
        resolutions++;
        return JSON.stringify([folder, pins]);
      },
    );
    const first = cached("owned-a", ["one"]);
    expect(cached("owned-a", ["one"])).toBe(first);
    expect(cached("owned-b", ["one"])).toEqual({ folder: "owned-b", pins: ["one"], call: 2 });
    expect(calls).toBe(2);
    expect(resolutions).toBe(3);
    expect(cached.cache.size).toBe(2);
  });

  test("undefined is an actual cached result", () => {
    let calls = 0;
    const cached = memoize(() => { calls++; return undefined; }, () => "owned-key");
    expect(cached()).toBeUndefined();
    expect(cached()).toBeUndefined();
    expect(cached.cache.has("owned-key")).toBe(true);
    expect(calls).toBe(1);
  });

  test("resolver side-channel changes select a new entry and preserve old entries", () => {
    let revision = "one";
    let calls = 0;
    const cached = memoize(() => ({ revision, call: ++calls }), () => revision);
    const one = cached();
    expect(cached()).toBe(one);
    revision = "two";
    expect(cached()).toEqual({ revision: "two", call: 2 });
    revision = "one";
    expect(cached()).toBe(one);
    expect(calls).toBe(2);
  });

  test("documented cache.clear invalidates cached results", () => {
    let calls = 0;
    const cached = memoize(() => ({ call: ++calls }), () => "owned-key");
    const first = cached();
    expect(cached()).toBe(first);
    cached.cache.clear();
    expect(cached.cache.size).toBe(0);
    expect(cached()).toEqual({ call: 2 });
    expect(calls).toBe(2);
  });

  test("ordinary string keys do not collide with object property names", () => {
    let calls = 0;
    const cached = memoize((value: string) => ({ value, call: ++calls }), (value: string) => value);
    const proto = cached("__proto__");
    const constructor = cached("constructor");
    const empty = cached("");
    expect(cached("__proto__")).toBe(proto);
    expect(cached("constructor")).toBe(constructor);
    expect(cached("")).toBe(empty);
    expect(calls).toBe(3);
    expect(cached.cache.size).toBe(3);
  });

  test("a synchronous callback exception creates no cached value", () => {
    let calls = 0;
    const cached = memoize(() => {
      calls++;
      if (calls === 1) throw new Error("owned transient callback");
      return "owned recovered value";
    }, () => "owned-key");
    expect(() => cached()).toThrow("owned transient callback");
    expect(cached.cache.has("owned-key")).toBe(false);
    expect(cached()).toBe("owned recovered value");
    expect(cached()).toBe("owned recovered value");
    expect(calls).toBe(2);
  });

  test("falsy callback values are retained per resolver key", () => {
    let calls = 0;
    const values = [false, 0, null, ""];
    const cached = memoize((index: number) => { calls++; return values[index]; }, (index: number) => String(index));
    for (let index = 0; index < values.length; index++) {
      expect(cached(index)).toBe(values[index]);
      expect(cached(index)).toBe(values[index]);
    }
    expect(calls).toBe(4);
  });
});
