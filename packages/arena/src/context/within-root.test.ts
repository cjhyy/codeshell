import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { isWithinRoot } from "./within-root.js";

// Regression: validatePath used `resolved.startsWith(REPO_ROOT + "/")` with a
// hardcoded "/" (review-2026-05-30, security). On Windows the separator is
// "\\", so the boundary check never matched. Also guards the sibling-prefix
// trap (/repo vs /repo-evil). isWithinRoot uses path.sep.

describe("isWithinRoot", () => {
  const root = path.resolve("/repo");

  test("the root itself is within root", () => {
    expect(isWithinRoot(root, root)).toBe(true);
  });

  test("a child path is within root", () => {
    expect(isWithinRoot(root, path.join(root, "src", "a.ts"))).toBe(true);
  });

  test("a sibling with the root as a string prefix is NOT within root", () => {
    expect(isWithinRoot(root, path.resolve("/repo-evil/secret"))).toBe(false);
  });

  test("an unrelated path is not within root", () => {
    expect(isWithinRoot(root, path.resolve("/etc/passwd"))).toBe(false);
  });

  test("uses the platform separator, not a hardcoded slash", () => {
    // path.join builds a child with the OS separator; the check must accept it.
    const child = root + path.sep + "nested";
    expect(isWithinRoot(root, child)).toBe(true);
  });
});
