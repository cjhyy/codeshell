import { describe, expect, test } from "bun:test";
import { assertSafePluginName } from "./installer/paths.js";
import { deriveMarketplaceName, parseMarketplaceInput } from "./parseMarketplaceInput.js";

describe("parseMarketplaceInput", () => {
  test("rejects insecure http marketplace URLs by default", () => {
    expect(parseMarketplaceInput("http://github.com/org/repo")).toBeNull();
    expect(parseMarketplaceInput("http://example.com/marketplace.git")).toBeNull();
  });

  test("allows insecure http marketplace URLs only with explicit opt-in", () => {
    expect(
      parseMarketplaceInput("http://example.com/marketplace.git", {
        allowUnsafeTransport: true,
      }),
    ).toEqual({
      source: "git",
      url: "http://example.com/marketplace.git",
    });
  });
});

// Regression (PLUGIN-R8-03): drive-prefixed Windows paths with backslashes are
// accepted by the parser, so the derived name must split on backslashes too.
describe("deriveMarketplaceName for local Windows paths", () => {
  test.each(["C:\\work\\skills.git", "C:/work/skills.git", "D:\\repos\\team\\skills.git"])(
    "%s derives a safe tail name",
    (input) => {
      const source = parseMarketplaceInput(input);
      expect(source).not.toBeNull();
      const name = deriveMarketplaceName(source!);
      expect(name).toBe("skills");
      expect(() => assertSafePluginName(name)).not.toThrow();
    },
  );
});
