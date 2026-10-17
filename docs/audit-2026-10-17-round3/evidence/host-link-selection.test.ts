import { describe, expect, test } from "bun:test";
import { resolveLinkFileSelection } from "../../../packages/link/src/file-selection.ts";

const input = (path: string) => ({ kind: "github-file", owner: "owner", repo: "repo", path });

describe("round 3 ordinary Link exact-reference observations", () => {
  test("leading and trailing filename whitespace changes the selected reference", () => {
    for (const requested of [" report.md", "report.md ", " report.md ", "　report.md"]) {
      const files = new Map([
        [requested, "requested content"],
        [requested.trim(), "different file content"],
      ]);
      const selected = resolveLinkFileSelection("github", input(requested));
      expect(selected.params.path).toBe(requested.trim());
      expect(selected.params.path).not.toBe(requested);
      expect(files.get(selected.params.path)).toBe("different file content");
      console.log(JSON.stringify({ observation: "trimmed-reference", requested, selected }));
    }
  });

  test("ordinary literal percent text is accepted unless it looks like an encoded separator", () => {
    const accepted = resolveLinkFileSelection("github", input("docs/rate%20table.md"));
    expect(accepted.params.path).toBe("docs/rate%20table.md");
    for (const requested of ["docs/rate%2Ftable.md", "docs/rate%5Ctable.md"]) {
      let message: string | undefined;
      try {
        resolveLinkFileSelection("github", input(requested));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Invalid GitHub file path");
      expect(encodeURIComponent(requested.split("/").at(-1)!)).toContain("%25");
      console.log(JSON.stringify({ observation: "literal-percent-rejected", requested, message }));
    }
  });

  test("a long valid multi-directory path creates a default label beginning with a lone surrogate", () => {
    const requested = "😀/" + "a".repeat(250) + "/" + "b".repeat(250) + "/" + "c".repeat(8);
    expect(requested.length).toBe(513);
    expect(requested.split("/").every((segment) => segment.length <= 255)).toBe(true);
    const selected = resolveLinkFileSelection("github", input(requested));
    expect(selected.params.path).toBe(requested);
    expect(selected.label.length).toBe(512);
    expect(selected.label.charCodeAt(0)).toBe(0xde00);
    expect(selected.label.isWellFormed()).toBe(false);
    expect(requested.isWellFormed()).toBe(true);
    console.log(JSON.stringify({
      observation: "default-label-lone-surrogate",
      requestedLength: requested.length,
      labelLength: selected.label.length,
      firstCodeUnit: selected.label.charCodeAt(0).toString(16),
      labelWellFormed: selected.label.isWellFormed(),
    }));
  });

  test("an explicit ordinary Unicode label is preserved", () => {
    const selected = resolveLinkFileSelection("github", {
      ...input("docs/report.md"),
      label: "报告 😀",
    });
    expect(selected.label).toBe("报告 😀");
    expect(selected.label.isWellFormed()).toBe(true);
  });
});
