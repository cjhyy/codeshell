import { describe, expect, it } from "bun:test";
import {
  remarkPathLinks,
  decodePathHref,
  CODESHELL_PATH_SCHEME,
} from "../packages/desktop/src/renderer/markdown/remarkPathLinks";

/**
 * Hand-rolled MDAST fixtures — we don't want to pull `remark-parse`
 * into the test deps just to assert plugin behavior. The plugin only
 * looks at `type`, `value`, and `children`, so a literal tree is
 * enough.
 */
type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
};

function tree(...children: Node[]): Node {
  return { type: "root", children };
}
function p(...children: Node[]): Node {
  return { type: "paragraph", children };
}
function text(value: string): Node {
  return { type: "text", value };
}
function code(value: string): Node {
  return { type: "inlineCode", value };
}
function link(url: string, ...children: Node[]): Node {
  return { type: "link", url, children };
}

function run(t: Node): Node {
  remarkPathLinks()(t as never);
  return t;
}

describe("remarkPathLinks", () => {
  it("rewrites `path.ext:line` inside plain text into a link node", () => {
    const t = tree(p(text("look at packages/core/src/engine.ts:184 carefully")));
    run(t);
    const para = t.children![0]!;
    const kinds = para.children!.map((n) => n.type);
    expect(kinds).toEqual(["text", "link", "text"]);
    const linkNode = para.children!.find((n) => n.type === "link")!;
    expect(linkNode.url).toBe(
      `${CODESHELL_PATH_SCHEME}${encodeURIComponent("packages/core/src/engine.ts")}:184`,
    );
    // Visible text preserves the human form.
    expect(linkNode.children![0]!.value).toBe(
      "packages/core/src/engine.ts:184",
    );
  });

  it("works without a line suffix", () => {
    const t = tree(p(text("see ./README.md for details")));
    run(t);
    const para = t.children![0]!;
    const linkNode = para.children!.find((n) => n.type === "link")!;
    expect(linkNode.url).toBe(
      `${CODESHELL_PATH_SCHEME}${encodeURIComponent("./README.md")}`,
    );
  });

  it("leaves existing links and inlineCode untouched", () => {
    const t = tree(
      p(
        text("inside code "),
        code("packages/core/src/x.ts:10"),
        text(" stays raw"),
      ),
      p(link("https://example.com", text("packages/core/src/y.ts:20"))),
    );
    run(t);
    // First paragraph: only the "stays raw" text could match, but it
    // doesn't, so the para is unchanged.
    const firstKinds = t.children![0]!.children!.map((n) => n.type);
    expect(firstKinds).toEqual(["text", "inlineCode", "text"]);
    // Second paragraph still has one link, with its original url.
    const secondKinds = t.children![1]!.children!.map((n) => n.type);
    expect(secondKinds).toEqual(["link"]);
    expect(t.children![1]!.children![0]!.url).toBe("https://example.com");
  });

  it("ignores bare words / sentence text without an extension", () => {
    const t = tree(p(text("see README or CHANGELOG")));
    run(t);
    expect(t.children![0]!.children!.map((n) => n.type)).toEqual(["text"]);
  });

  it("decodes the codeshell-path href back to (path, line)", () => {
    const url = `${CODESHELL_PATH_SCHEME}${encodeURIComponent("packages/core/src/engine.ts")}:184`;
    expect(decodePathHref(url)).toEqual({
      path: "packages/core/src/engine.ts",
      line: 184,
    });
  });

  it("decodes when no line is present", () => {
    const url = `${CODESHELL_PATH_SCHEME}${encodeURIComponent("./README.md")}`;
    expect(decodePathHref(url)).toEqual({ path: "./README.md" });
  });

  it("returns null for non-codeshell-path hrefs", () => {
    expect(decodePathHref("https://x.com")).toBeNull();
    expect(decodePathHref("")).toBeNull();
  });
});
