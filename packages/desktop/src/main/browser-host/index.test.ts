import { describe, test, expect } from "bun:test";
import { buildWindowOptions, shouldBlockNavigation, openBrowserHost } from "./index.js";

describe("buildWindowOptions", () => {
  test("hardened webPreferences, no preload, carries partition", () => {
    const o = buildWindowOptions({ kind: "window", url: "https://x", partition: "persist:login-1" });
    expect(o.webPreferences.partition).toBe("persist:login-1");
    expect(o.webPreferences.nodeIntegration).toBe(false);
    expect(o.webPreferences.contextIsolation).toBe(true);
    expect(o.webPreferences.sandbox).toBe(true);
    expect(o.webPreferences.webSecurity).toBe(true);
    // no preload key — external site must not get our API
    expect("preload" in o.webPreferences).toBe(false);
  });

  test("defaults size/title; respects overrides", () => {
    const def = buildWindowOptions({ kind: "window", url: "https://x", partition: "p" });
    expect(def.width).toBe(1000);
    expect(def.title).toBe("登录");
    const ov = buildWindowOptions({
      kind: "window",
      url: "https://x",
      partition: "p",
      width: 1200,
      title: "登录 YouTube",
    });
    expect(ov.width).toBe(1200);
    expect(ov.title).toBe("登录 YouTube");
  });
});

describe("shouldBlockNavigation", () => {
  test("allows http/https/about, blocks others", () => {
    expect(shouldBlockNavigation("https://youtube.com")).toBe(false);
    expect(shouldBlockNavigation("http://x.com")).toBe(false);
    expect(shouldBlockNavigation("about:blank")).toBe(false);
    expect(shouldBlockNavigation("file:///etc/passwd")).toBe(true);
    expect(shouldBlockNavigation("javascript:alert(1)")).toBe(true);
  });
});

describe("openBrowserHost", () => {
  test("rejects unimplemented kinds", async () => {
    // @ts-expect-error intentional bad kind for the guard test
    await expect(openBrowserHost({ kind: "webview", url: "https://x", partition: "p" })).rejects.toThrow(
      /not implemented/,
    );
  });
});
