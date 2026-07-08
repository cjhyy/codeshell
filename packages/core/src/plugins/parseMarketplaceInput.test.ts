import { describe, expect, test } from "bun:test";
import { parseMarketplaceInput } from "./parseMarketplaceInput.js";

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
