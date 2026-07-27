import { describe, expect, test } from "bun:test";
import { parseThemeUrl, themeAssetUrl } from "./theme-asset-url";

describe("cstheme:// url parsing", () => {
  test("accepts a canonical asset url", () => {
    const parsed = parseThemeUrl("cstheme://acme-neon/.cs-theme-assets/pet-idle.png");
    expect(parsed).toEqual({ id: "acme-neon", relativePath: ".cs-theme-assets/pet-idle.png" });
  });

  test("rejects traversal, escapes, and non-asset paths", () => {
    expect(parseThemeUrl("cstheme://acme/.cs-theme-assets/../../etc/passwd")).toBeNull();
    expect(parseThemeUrl("cstheme://acme/..%2F..%2Fx.png")).toBeNull();
    expect(parseThemeUrl("cstheme://acme/other-dir/x.png")).toBeNull();
    expect(parseThemeUrl("cstheme://acme/.cs-theme-assets/sub/x.png")).toBeNull();
    expect(parseThemeUrl("cstheme://acme/.cs-theme-assets/")).toBeNull();
  });

  test("rejects an unsafe theme id and wrong scheme", () => {
    expect(parseThemeUrl("cstheme://Bad_Id/.cs-theme-assets/x.png")).toBeNull();
    expect(parseThemeUrl("cstheme://../.cs-theme-assets/x.png")).toBeNull();
    expect(parseThemeUrl("https://acme/.cs-theme-assets/x.png")).toBeNull();
    expect(parseThemeUrl("cstheme://acme/.cs-theme-assets/x.png?y=1")).toBeNull();
  });

  test("themeAssetUrl builds a matching, parseable url", () => {
    const url = themeAssetUrl("acme-neon", ".cs-theme-assets/pet-running.gif");
    expect(parseThemeUrl(url)).toEqual({
      id: "acme-neon",
      relativePath: ".cs-theme-assets/pet-running.gif",
    });
  });
});
