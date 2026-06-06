import { expect, test, describe } from "bun:test";
import { findTerminalLinks, splitPathAndLine } from "./terminalLinks";

describe("findTerminalLinks", () => {
  test("matches an http url", () => {
    const out = findTerminalLinks("see https://example.com/path for docs");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "url", text: "https://example.com/path" });
    expect(out[0]!.start).toBe(4);
  });

  test("trims trailing prose punctuation off a url", () => {
    const out = findTerminalLinks("open https://example.com.");
    expect(out[0]!.text).toBe("https://example.com");
    expect(out[0]!.length).toBe("https://example.com".length);
  });

  test("does not swallow a wrapping paren", () => {
    const out = findTerminalLinks("(https://example.com)");
    expect(out[0]!.text).toBe("https://example.com");
  });

  test("matches a relative path with extension", () => {
    const out = findTerminalLinks("error in packages/core/src/x.ts please fix");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "path", text: "packages/core/src/x.ts" });
  });

  test("matches an absolute path with line and col", () => {
    const out = findTerminalLinks("  at /Users/me/app/foo.ts:42:7");
    expect(out[0]).toMatchObject({ kind: "path", text: "/Users/me/app/foo.ts:42:7" });
  });

  test("matches a dot-relative path", () => {
    const out = findTerminalLinks("./scripts/build.ts failed");
    expect(out[0]).toMatchObject({ kind: "path", text: "./scripts/build.ts" });
  });

  test("ignores bare words with no separator or extension", () => {
    expect(findTerminalLinks("just some README words here")).toHaveLength(0);
  });

  test("does not double-match a path embedded inside a url", () => {
    const out = findTerminalLinks("https://cdn.example.com/lib/app.js");
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("url");
  });

  test("finds both a url and a path on the same line", () => {
    const out = findTerminalLinks("docs https://x.io but edit src/a.ts now");
    expect(out.map((o) => o.kind)).toEqual(["url", "path"]);
    expect(out[0]!.start).toBeLessThan(out[1]!.start);
  });

  test("returns matches sorted by start", () => {
    const out = findTerminalLinks("a/b.ts then c/d.ts");
    expect(out[0]!.start).toBeLessThan(out[1]!.start);
  });
});

describe("splitPathAndLine", () => {
  test("plain path", () => {
    expect(splitPathAndLine("src/a.ts")).toEqual({ path: "src/a.ts" });
  });
  test("path with line", () => {
    expect(splitPathAndLine("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
  });
  test("path with line and col keeps only line", () => {
    expect(splitPathAndLine("src/a.ts:12:5")).toEqual({ path: "src/a.ts", line: 12 });
  });
});
