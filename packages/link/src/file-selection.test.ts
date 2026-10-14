import { describe, expect, test } from "bun:test";
import { LINK_PROVIDER_MANIFESTS, getLinkProviderManifest } from "./catalog.js";
import { resolveLinkFileSelection } from "./file-selection.js";

describe("reviewed provider file selection", () => {
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

  test("Figma URLs and keys normalize to the same exact granted resource", () => {
    const key = resolveLinkFileSelection("figma", { kind: "figma-file", fileUrlOrKey: "File_key" });
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
