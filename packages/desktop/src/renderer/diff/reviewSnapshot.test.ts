import { expect, test } from "bun:test";
import { selectReviewSnapshot } from "./reviewSnapshot";

const patch = (path: string, value: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -9 +9 @@\n-old\n+${value}\n`;

test("selects one historical file without regenerating line numbers or touching live Git", () => {
  const first = patch("src/a.ts", "a");
  const second = patch("with spaces.ts", "b");
  expect(selectReviewSnapshot(first + second, "with spaces.ts")).toBe(second);
  expect(selectReviewSnapshot(first + second, null)).toBe(first + second);
  expect(selectReviewSnapshot(first + second, "missing.ts")).toBe("");
});
