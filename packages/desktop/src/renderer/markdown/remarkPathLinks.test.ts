/**
 * Regression coverage for remarkPathLinks — specifically that file paths glued
 * to CJK punctuation (e.g. "SVG 原图：docs/x.svg") are recognised and rewritten
 * into clickable codeshell-path links. Before the boundary fix the lookbehind
 * only accepted ASCII whitespace / "(" / ",", so a full-width colon left the
 * path as plain unclickable text.
 */
import { describe, it, expect } from "bun:test";
import { remarkPathLinks, decodePathHref, CODESHELL_PATH_SCHEME } from "./remarkPathLinks";

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/** Run the plugin over a single paragraph text node and collect link urls. */
function linkUrls(text: string): string[] {
  const tree: MdastNode = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
  };
  remarkPathLinks()(tree);
  const urls: string[] = [];
  const visit = (n: MdastNode): void => {
    if (n.type === "link" && n.url) urls.push(n.url);
    n.children?.forEach(visit);
  };
  visit(tree);
  return urls;
}

/** Decode every produced link back to its path for easy assertions. */
function linkedPaths(text: string): string[] {
  return linkUrls(text)
    .filter((u) => u.startsWith(CODESHELL_PATH_SCHEME))
    .map((u) => decodePathHref(u)?.path)
    .filter((p): p is string => !!p);
}

describe("remarkPathLinks — CJK punctuation boundaries", () => {
  it("links a path after a full-width colon", () => {
    expect(linkedPaths("SVG 原图：docs/architecture/core-package-map.svg")).toEqual([
      "docs/architecture/core-package-map.svg",
    ]);
  });

  it("links a dotted relative path after a full-width colon", () => {
    expect(linkedPaths("截图：.code-shell/tmp/preview.png")).toEqual([
      ".code-shell/tmp/preview.png",
    ]);
  });

  it("links a path wrapped in CJK parentheses/brackets", () => {
    expect(linkedPaths("（详见 packages/core/src/x.ts）")).toEqual([
      "packages/core/src/x.ts",
    ]);
  });

  it("still links ASCII-delimited paths and preserves :line", () => {
    expect(linkedPaths("see docs/a.ts:42 here")).toEqual(["docs/a.ts"]);
    expect(linkUrls("see docs/a.ts:42 here")[0]).toContain(":42");
  });

  it("does not match bare words without a separator+extension", () => {
    expect(linkedPaths("纯文本 readme 不该匹配")).toEqual([]);
    expect(linkedPaths("这是一句话没有路径")).toEqual([]);
  });
});
