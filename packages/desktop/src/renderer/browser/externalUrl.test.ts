import { describe, expect, test } from "bun:test";
import { isExternalHttpUrl } from "./externalUrl";

describe("isExternalHttpUrl", () => {
  test("accepts absolute http(s) pages only", () => {
    expect(isExternalHttpUrl("https://example.com/path")).toBe(true);
    expect(isExternalHttpUrl("http://localhost:3000/")).toBe(true);
    expect(isExternalHttpUrl("about:blank")).toBe(false);
    expect(isExternalHttpUrl("file:///tmp/page.html")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalHttpUrl("example.com")).toBe(false);
    expect(isExternalHttpUrl("  ")).toBe(false);
  });
});
