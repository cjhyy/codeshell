import { describe, expect, test } from "bun:test";
import { truncateUtf8Bytes, truncateUtf8Text } from "./truncate-utf8.js";

describe("truncateUtf8", () => {
  test("returns text unchanged when under the limit", () => {
    expect(truncateUtf8Text("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  test("never splits a multibyte character", () => {
    expect(truncateUtf8Text("你好", 4)).toEqual({ text: "你", truncated: true });
  });

  test("buffer variant matches text variant on the same input", () => {
    const buffer = Buffer.from("héllo wörld", "utf8");
    expect(truncateUtf8Bytes(buffer, 7)).toEqual(truncateUtf8Text("héllo wörld", 7));
  });

  test("zero and negative budgets yield empty truncated text", () => {
    expect(truncateUtf8Text("abc", 0)).toEqual({ text: "", truncated: true });
    expect(truncateUtf8Text("abc", -1)).toEqual({ text: "", truncated: true });
  });

  test("fractional budgets are truncated to a whole byte", () => {
    expect(truncateUtf8Text("你好", 3.9)).toEqual({ text: "你", truncated: true });
  });

  test("non-finite budgets fail closed to zero bytes", () => {
    expect(truncateUtf8Text("abc", Number.NaN)).toEqual({ text: "", truncated: true });
    expect(truncateUtf8Text("abc", Number.POSITIVE_INFINITY)).toEqual({
      text: "",
      truncated: true,
    });
  });
});
