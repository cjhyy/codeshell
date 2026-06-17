import { describe, expect, test } from "bun:test";
import {
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserNavigateTool,
  browserScrollTool,
  browserReadContentTool,
  browserExtractLinksTool,
  browserWaitTool,
  browserPressEnterTool,
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
      await browserSnapshotTool({}, ctx),
      await browserClickTool({ ref: "e1" }, ctx),
      await browserTypeTool({ ref: "e1", text: "x" }, ctx),
      await browserNavigateTool({ url: "https://x.com" }, ctx),
      await browserScrollTool({ direction: "down" }, ctx),
      await browserReadContentTool({}, ctx),
      await browserExtractLinksTool({}, ctx),
      await browserWaitTool({}, ctx),
      await browserPressEnterTool({}, ctx),
    ]) {
      expect(out).toContain("not available");
    }
    expect(isBrowserAutomationAvailable(ctx)).toBe(false);
  });
});

describe("browser_snapshot", () => {
  test("renders url/title + element list; surfaces needsHuman", async () => {
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
    const out = await browserSnapshotTool({}, ctx);
    expect(out).toContain("URL: https://shop.example/login");
    expect(out).toContain("Title: 登录");
    expect(out).toContain("[ref=e1] textbox");
    expect(out).toContain("[sensitive]");
    expect(out).toContain("login required");
  });
});

describe("browser_click / type — happy + stale ref", () => {
  test("click ok", async () => {
    const ctx = ctxWith({ click: async () => ({ ok: true }) });
    expect(await browserClickTool({ ref: "e3" }, ctx)).toContain("Clicked e3");
  });

  test("click stale ref → tells agent to re-snapshot", async () => {
    const ctx = ctxWith({ click: async () => ({ ok: false, staleRef: true }) });
    const out = await browserClickTool({ ref: "e9" }, ctx);
    expect(out).toContain("no longer valid");
    expect(out).toContain("browser_snapshot");
  });

  test("type requires ref and text", async () => {
    const ctx = ctxWith({ type: async () => ({ ok: true }) });
    expect(await browserTypeTool({ text: "hi" }, ctx)).toContain("ref is required");
    expect(await browserTypeTool({ ref: "e1" }, ctx)).toContain("text is required");
    expect(await browserTypeTool({ ref: "e1", text: "hi" }, ctx)).toContain("Typed into e1");
  });
});

describe("browser_navigate / scroll — arg validation", () => {
  test("navigate requires url", async () => {
    const ctx = ctxWith({ navigate: async () => ({ ok: true }) });
    expect(await browserNavigateTool({}, ctx)).toContain("url is required");
    expect(await browserNavigateTool({ url: "https://a.com" }, ctx)).toContain("Navigated to");
  });

  test("scroll validates direction", async () => {
    const ctx = ctxWith({ scroll: async () => ({ ok: true }) });
    expect(await browserScrollTool({ direction: "sideways" }, ctx)).toContain("must be 'up' or 'down'");
    expect(await browserScrollTool({ direction: "down" }, ctx)).toContain("Scrolled down");
  });
});

describe("browser_read_content / wait / press_enter", () => {
  test("read_content returns cleaned text with url/title, flags truncation", async () => {
    const ctx = ctxWith({
      readContent: async () => ({ ok: true, url: "https://xhs.com/p/1", title: "探店", text: "正文内容", truncated: true }),
    });
    const out = await browserReadContentTool({}, ctx);
    expect(out).toContain("URL: https://xhs.com/p/1");
    expect(out).toContain("Title: 探店");
    expect(out).toContain("content truncated");
    expect(out).toContain("正文内容");
  });

  test("read_content error surfaces detail", async () => {
    const ctx = ctxWith({ readContent: async () => ({ ok: false, url: "x", text: "", detail: "no body" }) });
    expect(await browserReadContentTool({}, ctx)).toContain("no body");
  });

  test("extract_links renders links + images with url/title, flags truncation", async () => {
    const ctx = ctxWith({
      extractLinks: async () => ({
        ok: true,
        url: "https://xhs.com/explore",
        title: "发现",
        links: [
          { text: "探店笔记", url: "https://xhs.com/p/1" },
          { text: "", url: "https://xhs.com/p/2" },
        ],
        images: [{ url: "https://cdn.xhs.com/a.jpg", alt: "封面" }],
        truncated: true,
      }),
    });
    const out = await browserExtractLinksTool({}, ctx);
    expect(out).toContain("URL: https://xhs.com/explore");
    expect(out).toContain("探店笔记 → https://xhs.com/p/1");
    expect(out).toContain("https://xhs.com/p/2"); // empty-text link still listed
    expect(out).toContain("封面 → https://cdn.xhs.com/a.jpg");
    expect(out).toContain("truncated");
  });

  test("extract_links empty page → (none); error surfaces detail", async () => {
    const empty = await browserExtractLinksTool(
      {},
      ctxWith({ extractLinks: async () => ({ ok: true, url: "u", links: [], images: [] }) }),
    );
    expect(empty).toContain("Links: (none)");
    expect(empty).toContain("Images: (none)");
    const err = await browserExtractLinksTool(
      {},
      ctxWith({ extractLinks: async () => ({ ok: false, url: "u", links: [], images: [], detail: "boom" }) }),
    );
    expect(err).toContain("boom");
  });

  test("wait returns ready", async () => {
    const ctx = ctxWith({ waitForLoad: async () => ({ ok: true }) });
    expect(await browserWaitTool({ timeout_ms: 5000 }, ctx)).toContain("Page ready");
  });

  test("press_enter ok / stale", async () => {
    expect(await browserPressEnterTool({}, ctxWith({ pressEnter: async () => ({ ok: true }) }))).toContain("Pressed Enter");
    const stale = await browserPressEnterTool({ ref: "e9" }, ctxWith({ pressEnter: async () => ({ ok: false, staleRef: true }) }));
    expect(stale).toContain("no longer valid");
  });
});
