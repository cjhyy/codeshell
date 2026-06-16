import { describe, expect, test, beforeEach } from "bun:test";
import { handleBrowserAction, releaseGuest, type AutomationDeps } from "./automation-host";
import type { WebContents } from "electron";

/**
 * End-to-end scenario test: "去小红书 → 搜文章 → 打开 → 扒内容 → (交给模型)总结".
 * Drives the WHOLE main-side stack (handleBrowserAction → persistent
 * CdpBrowserDriver → fake CDP) across the multi-step tool loop, proving the
 * observe→act→read pipeline works with a stateful page (search → results →
 * article) and that refs survive across the separate tool calls.
 *
 * No Electron / no network — a scriptable fake guest whose CDP responses change
 * as the "page" navigates.
 */

beforeEach(() => releaseGuest(1));

// A tiny stateful fake "site": current page determines the AX tree + innerText.
function fakeXiaohongshu() {
  let page: "home" | "results" | "article" = "home";
  const ax = () => {
    if (page === "home")
      return {
        nodes: [
          { nodeId: "1", role: { value: "textbox" }, name: { value: "搜索小红书" }, backendDOMNodeId: 10 },
        ],
      };
    if (page === "results")
      return {
        nodes: [
          { nodeId: "2", role: { value: "link" }, name: { value: "上海citywalk攻略" }, backendDOMNodeId: 20 },
          { nodeId: "3", role: { value: "link" }, name: { value: "周末好去处" }, backendDOMNodeId: 21 },
        ],
      };
    return {
      nodes: [{ nodeId: "9", role: { value: "button" }, name: { value: "点赞" }, backendDOMNodeId: 90 }],
    };
  };
  const innerText = () =>
    page === "article"
      ? "上海citywalk攻略\n\n第一站:武康路。梧桐树下的老洋房……\n第二站:安福路。咖啡店扎堆……"
      : page === "results"
        ? "搜索结果列表"
        : "首页";
  const cdp: Record<string, (p?: any) => any> = {
    "Accessibility.getFullAXTree": () => ax(),
    "DOM.getBoxModel": () => ({ model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } }),
    "Runtime.evaluate": (p) => {
      if (typeof p?.expression === "string" && p.expression.includes("readyState")) return { result: { value: "complete" } };
      return { result: { value: innerText() } };
    },
    // typing into search then Enter → results; clicking a result → article.
    "Input.dispatchKeyEvent": () => {
      if (page === "home") page = "results";
      return {};
    },
    "Input.dispatchMouseEvent": (p) => {
      // a click (mousePressed) on the results page opens the article
      if (p?.type === "mousePressed" && page === "results") page = "article";
      return {};
    },
    "Input.insertText": () => ({}),
    "Page.navigate": () => {
      page = "home";
      return {};
    },
    "DOM.enable": () => ({}),
    "Accessibility.enable": () => ({}),
    "DOM.scrollIntoViewIfNeeded": () => ({}),
  };
  let attached = false;
  const guest = {
    id: 1,
    once: () => undefined,
    isDestroyed: () => false,
    getURL: () => (page === "article" ? "https://www.xiaohongshu.com/explore/abc" : "https://www.xiaohongshu.com/"),
    getTitle: () => "小红书",
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async (m: string, pr?: any) => (cdp[m] ? cdp[m](pr) : {}),
    },
  } as unknown as WebContents;
  return guest;
}

describe("E2E: 小红书 搜索→打开→扒内容", () => {
  test("full observe→act→read loop produces article text to summarize", async () => {
    const guest = fakeXiaohongshu();
    const deps: AutomationDeps = { activeGuest: () => guest, policy: () => ({ allowedDomains: [] }) };
    const act = (req: Parameters<typeof handleBrowserAction>[0]) => handleBrowserAction(req, deps).then(JSON.parse);

    // 1. snapshot home → find the search box
    const home = await act({ action: "snapshot" });
    const searchBox = home.elements.find((e: any) => e.role === "textbox");
    expect(searchBox.ref).toBe("e1");

    // 2. type the query + press Enter (→ results page)
    expect((await act({ action: "type", ref: searchBox.ref, text: "citywalk" })).ok).toBe(true);
    expect((await act({ action: "pressEnter", ref: searchBox.ref })).ok).toBe(true);

    // 3. wait + snapshot results → pick the first article link
    expect((await act({ action: "waitForLoad" })).ok).toBe(true);
    const results = await act({ action: "snapshot" });
    expect(results.elements.map((e: any) => e.name)).toContain("上海citywalk攻略");
    const article = results.elements[0];

    // 4. click the article (→ article page), wait
    expect((await act({ action: "click", ref: article.ref })).ok).toBe(true);
    expect((await act({ action: "waitForLoad" })).ok).toBe(true);

    // 5. read the article content (扒内容) → text the model would summarize
    const content = await act({ action: "readContent" });
    expect(content.ok).toBe(true);
    expect(content.url).toContain("/explore/");
    expect(content.text).toContain("武康路");
    expect(content.text).toContain("安福路");
    // (the agent now hands content.text to the model to 总结)
  });
});
