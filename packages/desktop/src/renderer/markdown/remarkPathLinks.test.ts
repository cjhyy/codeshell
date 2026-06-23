/**
 * Regression coverage for remarkPathLinks — specifically that file paths glued
 * to CJK punctuation (e.g. "SVG 原图：docs/x.svg") are recognised and rewritten
 * into clickable codeshell-path links. Before the boundary fix the lookbehind
 * only accepted ASCII whitespace / "(" / ",", so a full-width colon left the
 * path as plain unclickable text.
 */
import { describe, it, expect } from "bun:test";
import {
  remarkPathLinks,
  decodePathHref,
  decodeLocalPathHref,
  CODESHELL_PATH_SCHEME,
} from "./remarkPathLinks";

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

/** Run the plugin over a single inlineCode node and collect link urls. */
function inlineCodeLinkUrls(value: string): string[] {
  const tree: MdastNode = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "inlineCode", value }] },
    ],
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

  it("links a quoted path that contains spaces (macOS screenshot path)", () => {
    expect(
      linkedPaths(
        "'/var/folders/1d/T/TemporaryItems/截屏2026-06-01 18.39.07.png'",
      ),
    ).toEqual(["/var/folders/1d/T/TemporaryItems/截屏2026-06-01 18.39.07.png"]);
  });

  it("links a double-quoted spaced path", () => {
    expect(linkedPaths('图片 "docs/my folder/a b.png" 在这', )).toEqual([
      "docs/my folder/a b.png",
    ]);
  });

  it("does not link quoted prose without a path shape", () => {
    expect(linkedPaths("他说 '你好世界' 然后离开")).toEqual([]);
  });

  it("preserves a :line suffix inside a quoted path", () => {
    // The href carries the line so editors can jump to it; decodePathHref
    // strips it off `path`, so assert on the raw url instead.
    const urls = linkUrls("打开 '/Users/x/app.ts:42'");
    expect(urls).toEqual([
      `${CODESHELL_PATH_SCHEME}${encodeURIComponent("/Users/x/app.ts")}:42`,
    ]);
  });

  it("does not link a path whose open/close quotes differ", () => {
    // ' opens but ` closes — not a balanced quote, so no link. The bare
    // matcher can't pick it up either (preceded by a quote, not whitespace).
    expect(linkedPaths("x '/a/b.png` y")).toEqual([]);
  });

  it("a contraction apostrophe doesn't open a spurious quoted span", () => {
    // "don't" + a later "'" must not be read as a quoted path; the bare
    // a/b.ts inside is still linked on its own.
    expect(linkedPaths("don't use a/b.ts here'")).toEqual(["a/b.ts"]);
  });
});

describe("remarkPathLinks — bare filename in prose (no directory)", () => {
  it("links a bare filename with a known extension and (line N)", () => {
    // Codex-style: the model writes a lone filename, not a full path.
    expect(linkedPaths("见 remote-host-manager.ts (line 147)")).toEqual([
      "remote-host-manager.ts",
    ]);
    expect(linkUrls("见 remote-host-manager.ts (line 147)")[0]).toContain(":147");
  });

  it("links a bare filename with a :line suffix", () => {
    expect(linkedPaths("改了 dev.ts:53 这里")).toEqual(["dev.ts"]);
    expect(linkUrls("改了 dev.ts:53 这里")[0]).toContain(":53");
  });

  it("links a bare filename at a CJK boundary", () => {
    expect(linkedPaths("详见 engine.ts、还有别的")).toEqual(["engine.ts"]);
  });

  it("links common dotted-name files (vite.config.ts, package.json)", () => {
    expect(linkedPaths("看 package.json 里")).toEqual(["package.json"]);
    expect(linkedPaths("看 vite.config.ts 配置")).toEqual(["vite.config.ts"]);
  });

  it("does NOT link a bare token whose extension isn't a known file type", () => {
    // Same guard as inlineCode: prose with a dot must stay plain.
    expect(linkedPaths("调用 obj.method 然后返回")).toEqual([]);
    expect(linkedPaths("版本 v1.2 发布")).toEqual([]);
    expect(linkedPaths("用 Array.from 转换")).toEqual([]);
    expect(linkedPaths("比例 16.9 很宽")).toEqual([]);
  });

  it("does NOT link a bare filename with no extension", () => {
    expect(linkedPaths("打开 README 文件")).toEqual([]);
  });

  it("a path WITH a directory still links regardless of extension whitelist", () => {
    // The slash already disambiguates from prose, so unknown extensions are
    // fine when there's a directory — unchanged behavior.
    expect(linkedPaths("see build/out.weirdext here")).toEqual(["build/out.weirdext"]);
  });
});

describe("remarkPathLinks — inlineCode path spans", () => {
  const paths = (value: string): (string | undefined)[] =>
    inlineCodeLinkUrls(value)
      .filter((u) => u.startsWith(CODESHELL_PATH_SCHEME))
      .map((u) => decodePathHref(u)?.path);

  it("links a backtick-wrapped relative path", () => {
    expect(paths("packages/desktop/src/renderer/App.tsx")).toEqual([
      "packages/desktop/src/renderer/App.tsx",
    ]);
  });

  it("links a backtick-wrapped absolute path", () => {
    expect(paths("/Users/me/app/foo.ts")).toEqual(["/Users/me/app/foo.ts"]);
  });

  it("preserves a :line suffix on a backtick path", () => {
    expect(inlineCodeLinkUrls("src/x.ts:42")[0]).toContain(":42");
  });

  it("links a bare root-level filename with a known extension", () => {
    expect(paths("README.md")).toEqual(["README.md"]);
    expect(paths("package.json")).toEqual(["package.json"]);
    expect(paths("TODO.md")).toEqual(["TODO.md"]);
    expect(paths("vite.config.ts")).toEqual(["vite.config.ts"]);
  });

  it("does not link inline code that isn't a lone path", () => {
    expect(paths("npm run build")).toEqual([]);
    expect(paths("--no-verify")).toEqual([]);
    expect(paths("useState")).toEqual([]); // no "."
    expect(paths("README")).toEqual([]); // no extension
  });

  it("does not link a bare dotted token whose extension isn't a known file type", () => {
    // Prose / code that happens to have a dot but isn't a file.
    expect(paths("obj.method")).toEqual([]);
    expect(paths("a.b")).toEqual([]);
    expect(paths("v1.2")).toEqual([]);
    expect(paths("Array.from")).toEqual([]);
  });

  it("does not link a domain-shaped span (URL, not a path)", () => {
    expect(paths("example.com/index.html")).toEqual([]);
  });
});

describe("remarkPathLinks — CJK characters inside the path itself", () => {
  it("links a bare path with a CJK directory segment", () => {
    // The user's whole workspace lives under a Chinese directory. With ASCII
    // \w the matcher resynced after the CJK segment and dropped the prefix, so
    // the path never linked and inline image thumbnails couldn't load.
    expect(linkedPaths("路径 /Users/me/个人学习/代码学习/proj/a.png 完成")).toEqual([
      "/Users/me/个人学习/代码学习/proj/a.png",
    ]);
  });

  it("links a bare path with a CJK basename", () => {
    expect(linkedPaths("见 outputs/ep01/assets/img/ep01-char-萧炎.png 这张")).toEqual([
      "outputs/ep01/assets/img/ep01-char-萧炎.png",
    ]);
  });

  it("links a CJK basename at a CJK punctuation boundary", () => {
    expect(linkedPaths("见 outputs/ep01/assets/img/ep01-char-萧炎.png。")).toEqual([
      "outputs/ep01/assets/img/ep01-char-萧炎.png",
    ]);
  });

  it("links a CJK path inside an inlineCode span", () => {
    const paths = inlineCodeLinkUrls("outputs/ep01/assets/img/ep01-char-萧炎.png")
      .filter((u) => u.startsWith(CODESHELL_PATH_SCHEME))
      .map((u) => decodePathHref(u)?.path);
    expect(paths).toEqual(["outputs/ep01/assets/img/ep01-char-萧炎.png"]);
  });

  it("links an absolute CJK inlineCode path (GenerateImage echo)", () => {
    const paths = inlineCodeLinkUrls(
      "/Users/admin/个人学习/代码学习/mimi/.code-shell/generated_images/1782-57adaf.png",
    )
      .filter((u) => u.startsWith(CODESHELL_PATH_SCHEME))
      .map((u) => decodePathHref(u)?.path);
    expect(paths).toEqual([
      "/Users/admin/个人学习/代码学习/mimi/.code-shell/generated_images/1782-57adaf.png",
    ]);
  });

  it("links a bare CJK filename in an inlineCode span", () => {
    const paths = inlineCodeLinkUrls("萧炎.png")
      .filter((u) => u.startsWith(CODESHELL_PATH_SCHEME))
      .map((u) => decodePathHref(u)?.path);
    expect(paths).toEqual(["萧炎.png"]);
  });

  it("decodeLocalPathHref keeps a CJK markdown href", () => {
    expect(
      decodeLocalPathHref("outputs/ep01/assets/img/ep01-char-萧炎.png"),
    ).toEqual({ path: "outputs/ep01/assets/img/ep01-char-萧炎.png" });
  });
});

describe("decodeLocalPathHref", () => {
  it("decodes absolute markdown hrefs with line numbers", () => {
    expect(decodeLocalPathHref("/Users/me/app/src/Foo.tsx:81")).toEqual({
      path: "/Users/me/app/src/Foo.tsx",
      line: 81,
    });
  });

  it("decodes relative markdown hrefs", () => {
    expect(decodeLocalPathHref("packages/core/src/index.ts")).toEqual({
      path: "packages/core/src/index.ts",
    });
  });

  it("ignores non-file web links and anchors", () => {
    expect(decodeLocalPathHref("https://example.com/a.ts")).toBeNull();
    expect(decodeLocalPathHref("#section")).toBeNull();
  });

  it("ignores scheme-less URLs (domain-shaped first segment) so they open externally", () => {
    // These have no scheme but are clearly web links, not workspace paths.
    // Treating them as local sent openPath after a file that can't exist and
    // never reached the openExternal branch.
    expect(decodeLocalPathHref("example.com/path.html")).toBeNull();
    expect(decodeLocalPathHref("www.google.com/a.html")).toBeNull();
    expect(decodeLocalPathHref("mysite.io/index.html")).toBeNull();
    expect(decodeLocalPathHref("//cdn.com/x.js")).toBeNull();
  });

  it("still decodes explicit-relative paths with dotted dirs via ./", () => {
    expect(decodeLocalPathHref("./my.app/foo.ts")).toEqual({ path: "./my.app/foo.ts" });
  });
});
