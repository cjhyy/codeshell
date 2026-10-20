import { describe, expect, test } from "bun:test";
import { cookiePlatformName, newCookieAccountId } from "./cookie-platform.js";

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

describe("newCookieAccountId", () => {
  test("keeps the readable platform__slug form for a fresh label", () => {
    expect(newCookieAccountId("xiaohongshu", "Account A", [])).toBe("xiaohongshu__account-a");
  });

  test("never reuses an existing account ID for a colliding default or non-ASCII label", () => {
    const taken = ["xiaohongshu__account", "xiaohongshu__account-2"];
    expect(newCookieAccountId("xiaohongshu", "默认账号", taken)).toBe("xiaohongshu__account-3");
    expect(newCookieAccountId("browser", "工作号", ["browser__account"])).toBe(
      "browser__account-2",
    );
    expect(newCookieAccountId("xiaohongshu", "Account A", ["xiaohongshu__account-a"])).toBe(
      "xiaohongshu__account-a-2",
    );
  });
});
