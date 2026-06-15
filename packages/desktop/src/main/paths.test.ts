import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveTargetPath } from "./paths";

describe("resolveTargetPath", () => {
  test("absolute path passes through", () => {
    expect(resolveTargetPath("/a/b.ts")).toBe("/a/b.ts");
  });
  test("strips a :line suffix", () => {
    expect(resolveTargetPath("/a/b.ts:42")).toBe("/a/b.ts");
  });
  test("strips a :line:col suffix", () => {
    expect(resolveTargetPath("/a/b.ts:42:7")).toBe("/a/b.ts");
  });
  test("resolves a relative path against cwd", () => {
    expect(resolveTargetPath("b.ts", "/a")).toBe(path.resolve("/a", "b.ts"));
  });
  test("resolves a relative path WITH a :line suffix against cwd", () => {
    expect(resolveTargetPath("src/b.ts:99", "/a")).toBe(
      path.resolve("/a", "src/b.ts"),
    );
  });
});
