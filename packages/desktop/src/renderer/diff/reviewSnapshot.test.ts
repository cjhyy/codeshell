import { expect, test } from "bun:test";
import { groupReviewSnapshot, selectReviewSnapshot } from "./reviewSnapshot";
import { parseUnifiedDiff } from "./parseUnifiedDiff";

const patch = (path: string, value: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -9 +9 @@\n-old\n+${value}\n`;

test("selects one historical file without regenerating line numbers or touching live Git", () => {
  const first = patch("src/a.ts", "a");
  const second = patch("with spaces.ts", "b");
  expect(selectReviewSnapshot(first + second, "with spaces.ts")).toBe(second);
  expect(selectReviewSnapshot(first + second, null)).toBe(first + second);
  expect(selectReviewSnapshot(first + second, "missing.ts")).toBe("");
});

test("groups every recorded legacy hunk for a file under one file header", () => {
  const first = patch("src/a.ts", "first");
  const other = patch("src/b.ts", "other");
  const second = patch("src/a.ts", "second");
  const grouped = groupReviewSnapshot(first + other + second);
  const files = parseUnifiedDiff(grouped);
  expect(files.map((file) => file.newPath)).toEqual(["src/a.ts", "src/b.ts"]);
  expect(files[0]?.hunks).toHaveLength(2);
  expect(grouped).toContain("+first");
  expect(grouped).toContain("+second");
  expect(grouped).toContain("+other");
  expect(groupReviewSnapshot(grouped)).toBe(grouped);
  const selected = selectReviewSnapshot(first + other + second, "src/a.ts");
  expect(parseUnifiedDiff(selected)).toHaveLength(1);
  expect(selected).toContain("+first");
  expect(selected).toContain("+second");
  expect(selected).not.toContain("+other");
});

test("does not merge distinct paths or infer rename identity from matching destinations", () => {
  const rename =
    "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
  const plain = patch("new.ts", "new");
  expect(groupReviewSnapshot(rename + plain)).toBe(rename + plain);
});

test("reordering A/B/A keeps file boundaries when the final patch has no trailing newline", () => {
  const raw = patch("a.ts", "first") + patch("b.ts", "other") + patch("a.ts", "last").trimEnd();
  const grouped = groupReviewSnapshot(raw);
  expect(parseUnifiedDiff(grouped).map((file) => file.newPath)).toEqual(["a.ts", "b.ts"]);
  expect(grouped).not.toContain("+lastdiff --git");
  expect(selectReviewSnapshot(raw, "b.ts")).toContain("+other");
});
