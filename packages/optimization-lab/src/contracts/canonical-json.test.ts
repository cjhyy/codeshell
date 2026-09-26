import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "./canonical-json.js";

describe("canonicalJson", () => {
  test("sorts every object's keys independently of insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
  });

  test("preserves arrays, JSON scalars and special property names", () => {
    const value = JSON.parse('{"z":0,"__proto__":{"polluted":true},"constructor":null}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"polluted":true},"constructor":null,"z":0}');
    expect(canonicalJson([null, true, "a", -0, 2, 1])).toBe('[null,true,"a",0,2,1]');
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  test.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("x"),
    () => 1,
    new Date(),
    new Map(),
    new Set(),
  ])("rejects non-JSON data: %p", (value) => {
    expect(() => canonicalJson(value)).toThrow("JSON");
    expect(() => canonicalJson({ nested: value })).toThrow("JSON");
    expect(() => canonicalJson([value])).toThrow("JSON");
  });

  test("rejects sparse arrays, additional array keys, symbols and getters", () => {
    const extra = [1];
    Object.assign(extra, { metadata: true });
    const getter = Object.defineProperty({}, "value", { get: () => 1, enumerable: true });
    for (const value of [new Array(1), extra, { [Symbol("key")]: 1 }, getter]) {
      expect(() => canonicalJson(value)).toThrow("JSON");
    }
  });

  test("rejects cycles but accepts a shared JSON object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("JSON");
    const shared = { value: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"value":1},{"value":1}]');
  });

  test("hashes equal values to the same sha256", () => {
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
