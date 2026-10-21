import { describe, expect, test } from "bun:test";
import { LINK_PROVIDER_MANIFESTS, getLinkProviderManifest } from "./catalog.js";
import { resolveLinkFileSelection } from "./file-selection.js";

describe("reviewed provider file selection", () => {
  test("Figma Make reports an unsupported file type rather than a missing grant", () => {
    expect(() =>
      resolveLinkFileSelection("figma", {
        kind: "figma-file",
        fileUrlOrKey: "https://www.figma.com/make/MakeOne/Prototype",
      }),
    ).toThrow("unsupported_file_type");
  });
  test("only providers with actual file readers advertise selection", () => {
    expect(
      LINK_PROVIDER_MANIFESTS.filter((provider) => provider.fileSelection).map(
        (provider) => provider.id,
      ),
    ).toEqual(["github", "figma"]);
    expect(getLinkProviderManifest("notion")?.fileSelectionLimitation).toBe(
      "document-content-unavailable",
    );
    for (const provider of LINK_PROVIDER_MANIFESTS.filter((provider) => provider.fileSelection))
      expect(provider.actionIds).toContain(provider.fileSelection!.action);
  });

  test("canonical GitHub references retain exact paths and refs without arbitrary action fields", () => {
    expect(
      resolveLinkFileSelection("github", {
        kind: "github-file",
        owner: "Owner",
        repo: "Docs",
        path: "guide/Intro.md",
        ref: "release/docs",
        label: "  Handbook  ",
      }),
    ).toEqual({
      providerId: "github",
      action: "get_file",
      scopeId: "github:get_file",
      params: { owner: "owner", repo: "docs", path: "guide/Intro.md", ref: "release/docs" },
      resourceId: "owner/docs",
      label: "Handbook",
    });
  });

  // Regression (audit HL-01): exact picked paths were trimmed, so " a.txt" and
  // "a.txt" collapsed into one reference.
  test("exact picked GitHub paths keep surrounding whitespace and stay distinct", () => {
    const pick = (path: string) =>
      resolveLinkFileSelection("github", {
        kind: "github-file",
        owner: "owner",
        repo: "repo",
        path,
        exact: true,
      });
    const paths = [" a.txt", "a.txt ", "　a.txt", "docs/ b.md", "a.txt"];
    const selected = paths.map(pick);
    expect(selected.map((item) => item.params.path)).toEqual(paths);
    expect(new Set(selected.map((item) => JSON.stringify(item.params))).size).toBe(paths.length);
    expect(selected[0]!.label).toBe("owner/repo/ a.txt");
    for (const path of [" ", "a/ /../b", " /a//b", "a/\u0000b"]) expect(() => pick(path)).toThrow();
  });

  test("typed GitHub paths are still trimmed and keep the existing reference shape", () => {
    const typed = resolveLinkFileSelection("github", {
      kind: "github-file",
      owner: "owner",
      repo: "repo",
      path: "  docs/a.txt  ",
    });
    expect(typed.params).toEqual({ owner: "owner", repo: "repo", path: "docs/a.txt" });
    // An ordinary exact pick resolves to the same reference, so stored ids stay stable.
    expect(
      resolveLinkFileSelection("github", {
        kind: "github-file",
        owner: "owner",
        repo: "repo",
        path: "docs/a.txt",
        exact: true,
      }),
    ).toEqual(typed);
    for (const exact of ["true", 1, null])
      expect(() =>
        resolveLinkFileSelection("github", {
          kind: "github-file",
          owner: "owner",
          repo: "repo",
          path: "a.txt",
          exact,
        }),
      ).toThrow();
  });

  test("Figma URLs and keys normalize to the same exact granted resource", () => {
    const key = resolveLinkFileSelection("figma", { kind: "figma-file", fileUrlOrKey: "File_key" });
    expect(key.action).toBe("read_design_content");
    expect(key.scopeId).toBe("figma:read_design_content");
    for (const type of ["file", "design", "board"])
      expect(
        resolveLinkFileSelection("figma", {
          kind: "figma-file",
          fileUrlOrKey: `https://www.figma.com/${type}/File_key/title?node-id=1`,
        }),
      ).toEqual(key);
  });

  test.each([
    "../secret",
    "a/../secret",
    "a/%2e%2e/secret",
    "a%2fb",
    "a\\b",
    "/a",
    "a//b",
    "a/\u0000b",
  ])("rejects escaping GitHub path %j", (path) => {
    expect(() =>
      resolveLinkFileSelection("github", {
        kind: "github-file",
        owner: "owner",
        repo: "repo",
        path,
      }),
    ).toThrow();
  });

  test.each([
    "http://figma.com/file/key/title",
    "https://figma.com.evil.invalid/file/key",
    "https://user@figma.com/file/key",
    "https://figma.com:8443/file/key",
    "https://figma.com/file/key%2fother",
    "../../key",
  ])("rejects non-file Figma reference %j", (fileUrlOrKey) => {
    expect(() => resolveLinkFileSelection("figma", { kind: "figma-file", fileUrlOrKey })).toThrow();
  });

  // Regression (audit HL-02): the default label kept the last 512 UTF-16 units,
  // which could start with the low half of an emoji.
  test("bounds a long default GitHub label without splitting a surrogate pair", () => {
    const path = "😀/" + "a".repeat(250) + "/" + "b".repeat(250) + "/" + "c".repeat(8);
    const selected = resolveLinkFileSelection("github", {
      kind: "github-file",
      owner: "owner",
      repo: "repo",
      path,
    });
    expect(selected.params.path).toBe(path);
    expect(selected.label.isWellFormed()).toBe(true);
    expect(selected.label.length).toBeLessThanOrEqual(512);
    expect(`owner/repo/${path}`.endsWith(selected.label)).toBe(true);
    expect(selected.label.length).toBe(511);
  });

  test("rejects unsupported providers, crossed kinds, and generic JSON", () => {
    expect(() =>
      resolveLinkFileSelection("notion", { kind: "figma-file", fileUrlOrKey: "key" }),
    ).toThrow();
    expect(() =>
      resolveLinkFileSelection("github", { kind: "figma-file", fileUrlOrKey: "key" }),
    ).toThrow();
    expect(() =>
      resolveLinkFileSelection("figma", {
        kind: "figma-file",
        fileUrlOrKey: "key",
        params: { token: "hidden" },
      }),
    ).toThrow();
  });
});
