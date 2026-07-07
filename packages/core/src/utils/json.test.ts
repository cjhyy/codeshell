import { describe, expect, test } from "bun:test";
import { extractJSON } from "./json.js";

describe("extractJSON", () => {
  test("extracts fenced json content", () => {
    expect(extractJSON("```json\n{\"ok\": true}\n```")).toBe("{\"ok\": true}");
  });

  test("extracts the first balanced object from surrounding text", () => {
    expect(extractJSON("before {\"a\": {\"b\": 1}} after")).toBe("{\"a\": {\"b\": 1}}");
  });

  test("ignores braces inside strings", () => {
    expect(extractJSON('before {"text":"not } done","next":1} after')).toBe(
      '{"text":"not } done","next":1}',
    );
  });

  test("returns from the first opening brace when unbalanced", () => {
    expect(extractJSON("before {\"a\": 1")).toBe("{\"a\": 1");
  });

  test("falls back to the original text when no object is present", () => {
    expect(extractJSON("no json here")).toBe("no json here");
  });
});
