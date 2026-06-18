import { describe, expect, test } from "bun:test";
import {
  browserObserveTool,
  browserActTool,
  browserNavigateTool,
  isBrowserAutomationAvailable,
} from "./browser-tools.js";
import type { BrowserBridge } from "../browser-bridge.js";
import type { ToolContext } from "../context.js";

function ctxWith(bridge?: Partial<BrowserBridge>): ToolContext {
  return { browser: bridge as BrowserBridge | undefined } as unknown as ToolContext;
}

describe("browser tools — no bridge (headless / no panel)", () => {
  test("every tool degrades with a clear error, never throws", async () => {
    const ctx = ctxWith(undefined);
    for (const out of [
      await browserObserveTool({}, ctx),
      await browserObserveTool({ mode: "read" }, ctx),
      await browserObserveTool({ mode: "extract" }, ctx),
      await browserActTool({ action: "click", ref: "e1" }, ctx),
      await browserActTool({ action: "type", ref: "e1", text: "x" }, ctx),
      await browserActTool({ action: "select", ref: "e1", value: "a" }, ctx),
      await browserActTool({ action: "press_key", key: "Enter" }, ctx),
      await browserActTool({ action: "hover", ref: "e1" }, ctx),
      await browserActTool({ action: "scroll", direction: "down" }, ctx),
      await browserActTool({ action: "wait" }, ctx),
      await browserNavigateTool({ url: "https://x.com" }, ctx),
    ]) {
      expect(out).toContain("not available");
    }
    expect(isBrowserAutomationAvailable(ctx)).toBe(false);
  });
});

describe("browser_observe", () => {
  test("snapshot renders url/title + element list; surfaces needsHuman", async () => {
    const ctx = ctxWith({
      snapshot: async () => ({
        url: "https://shop.example/login",
        title: "登录",
        elements: [
          { ref: "e1", role: "textbox", name: "账号" },
          { ref: "e2", role: "textbox", name: "password", sensitive: true },
        ],
        needsHuman: "login required",
      }),
    });
    const out = await browserObserveTool({}, ctx); // default mode = snapshot
    expect(out).toContain("https://shop.example/login");
    expect(out).toContain("e1");
    expect(out).toContain("[sensitive]");
    expect(out).toContain("login required");
  });

  test("read returns cleaned page text", async () => {
    const ctx = ctxWith({
      readContent: async () => ({ ok: true, url: "u", title: "t", text: "article body", truncated: false }),
    });
    expect(await browserObserveTool({ mode: "read" }, ctx)).toContain("article body");
  });

  test("extract lists links/images/videos", async () => {
    const ctx = ctxWith({
      extractLinks: async () => ({
        ok: true,
        url: "u",
        links: [{ text: "home", url: "https://x/home" }],
        images: [{ url: "https://x/a.png", alt: "a" }],
        videos: [{ url: "https://x/v.mp4" }],
      }),
    });
    const out = await browserObserveTool({ mode: "extract" }, ctx);
    expect(out).toContain("https://x/home");
    expect(out).toContain("https://x/a.png");
    expect(out).toContain("https://x/v.mp4");
  });

  test("unknown mode errors", async () => {
    const ctx = ctxWith({ snapshot: async () => ({ url: "u", elements: [] }) });
    expect(await browserObserveTool({ mode: "bogus" }, ctx)).toContain("unknown observe mode");
  });
});

describe("browser_act", () => {
  test("click ok / stale", async () => {
    expect(await browserActTool({ action: "click", ref: "e3" }, ctxWith({ click: async () => ({ ok: true }) }))).toContain("Clicked e3");
    const stale = await browserActTool({ action: "click", ref: "e9" }, ctxWith({ click: async () => ({ ok: false, staleRef: true }) }));
    expect(stale).toContain("no longer valid");
  });

  test("type validates ref + text", async () => {
    const ctx = ctxWith({ type: async () => ({ ok: true }) });
    expect(await browserActTool({ action: "type", text: "hi" }, ctx)).toContain("ref is required");
    expect(await browserActTool({ action: "type", ref: "e1" }, ctx)).toContain("text is required");
    expect(await browserActTool({ action: "type", ref: "e1", text: "hi" }, ctx)).toContain("Typed into e1");
  });

  test("select reports match / passes value", async () => {
    const ctx = ctxWith({ selectOption: async (_ref, v) => ({ ok: true, detail: `selected "${v}"` }) });
    expect(await browserActTool({ action: "select", ref: "e1", value: "中国" }, ctx)).toContain("中国");
  });

  test("press_key defaults to Enter", async () => {
    let got = "";
    const ctx = ctxWith({ pressKey: async (k) => { got = k; return { ok: true }; } });
    expect(await browserActTool({ action: "press_key" }, ctx)).toContain("Pressed Enter");
    expect(got).toBe("Enter");
  });

  test("hover ok", async () => {
    expect(await browserActTool({ action: "hover", ref: "e2" }, ctxWith({ hover: async () => ({ ok: true }) }))).toContain("Hovered e2");
  });

  test("scroll validates direction", async () => {
    const ctx = ctxWith({ scroll: async () => ({ ok: true }) });
    expect(await browserActTool({ action: "scroll", direction: "sideways" }, ctx)).toContain("must be 'up' or 'down'");
    expect(await browserActTool({ action: "scroll", direction: "down" }, ctx)).toContain("Scrolled down");
  });

  test("wait ready", async () => {
    expect(await browserActTool({ action: "wait", timeout_ms: 5000 }, ctxWith({ waitForLoad: async () => ({ ok: true }) }))).toContain("Page ready");
  });

  test("unknown action errors", async () => {
    expect(await browserActTool({ action: "teleport" }, ctxWith({}))).toContain("unknown action");
  });
});

describe("browser_navigate", () => {
  test("navigates / requires url", async () => {
    const ctx = ctxWith({ navigate: async () => ({ ok: true }) });
    expect(await browserNavigateTool({}, ctx)).toContain("url is required");
    expect(await browserNavigateTool({ url: "https://x.com" }, ctx)).toContain("Navigated to");
  });
});
