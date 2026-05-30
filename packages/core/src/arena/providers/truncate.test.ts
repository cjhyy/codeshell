import { describe, test, expect } from "bun:test";
import { truncate as truncateDoc } from "./docs.js";
import { truncate as truncateRepo } from "./repo.js";

// Regression: truncate did `t.slice(0, t.lastIndexOf("\n"))`; with no newline
// in the window lastIndexOf is -1, so slice(0,-1) dropped only the last char
// instead of cutting cleanly at the cap (review-2026-05-30).

const DOC_CAP = 10_000;
const REPO_CAP = 8_000;

describe("provider truncate handles content with no newline", () => {
  test("docs: a long single line cuts at the cap, not cap-1", () => {
    const out = truncateDoc("x".repeat(DOC_CAP + 500));
    const body = out.split("\n")[0];
    expect(body.length).toBe(DOC_CAP); // not DOC_CAP-1
    expect(out).toContain("truncated");
  });

  test("repo: a long single line cuts at the cap, not cap-1", () => {
    const out = truncateRepo("y".repeat(REPO_CAP + 500));
    const body = out.split("\n")[0];
    expect(body.length).toBe(REPO_CAP);
    expect(out).toContain("truncated");
  });

  test("docs: short content is returned unchanged", () => {
    expect(truncateDoc("hello")).toBe("hello");
  });

  test("docs: still cuts at the last newline when one exists", () => {
    const content = "line\n".repeat(3000); // > 10k chars, has newlines
    const out = truncateDoc(content);
    expect(out.endsWith("chars total)")).toBe(true);
    // body ends on a newline boundary (no partial 'lin')
    expect(out.split("\n... (truncated")[0].endsWith("line")).toBe(true);
  });
});
