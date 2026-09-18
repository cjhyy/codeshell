import { describe, expect, test } from "bun:test";
import { cookiePlatformName } from "./cookie-platform.js";

describe("cookiePlatformName", () => {
  test("groups panel and credentials-page YouTube records without changing account IDs", () => {
    expect(cookiePlatformName("youtube")).toBe("YouTube");
    expect(cookiePlatformName("youtube.com")).toBe("YouTube");
    expect(cookiePlatformName("www.youtube.com")).toBe("YouTube");
  });

  test("keeps unrelated sites distinct", () => {
    expect(cookiePlatformName("youtube.example.com")).toBe("youtube.example.com");
    expect(cookiePlatformName("example.com")).toBe("example.com");
  });
});
