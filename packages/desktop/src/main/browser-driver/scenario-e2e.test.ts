import { describe, expect, test, beforeEach } from "bun:test";
import { handleBrowserAction, releaseGuest, type AutomationDeps } from "./automation-host";
import type { BrowserBridge, BrowserElement } from "@cjhyy/code-shell-core";
import type { WebContents } from "electron";

/** Exercises host routing across a stateful observe → act → read loop.
 * BrowserBridge is injected directly; no legacy transport or network is involved. */
beforeEach(() => releaseGuest(1));

function fakeXiaohongshu() {
  let page: "home" | "results" | "article" = "home";
  let query = "";
  const calls: unknown[][] = [];
  const url = () =>
    page === "article" ? "https://www.xiaohongshu.com/explore/abc" : "https://www.xiaohongshu.com/";
  const guest = {
    id: 1,
    once: () => undefined,
    isDestroyed: () => false,
    getURL: url,
    getTitle: () => "小红书",
  } as unknown as WebContents;
  const unused = async () => {
    throw new Error("Unexpected scenario BrowserBridge method");
  };
  const driver: BrowserBridge = {
    snapshot: async () => {
      calls.push(["snapshot"]);
      const elements: Array<Omit<BrowserElement, "ref">> =
        page === "home"
          ? [{ role: "textbox", name: "搜索小红书" }]
          : page === "results"
            ? [
                { role: "link", name: "上海citywalk攻略" },
                { role: "link", name: "周末好去处" },
              ]
            : [{ role: "button", name: "点赞" }];
      return {
        url: url(),
        snapshotId: page,
        elements: elements.map((element, index) => ({ ...element, ref: `${page}:e${index + 1}` })),
      };
    },
    type: async (ref, text) => {
      calls.push(["type", ref, text]);
      if (page !== "home" || ref !== "home:e1") throw new Error("Unexpected search input");
      query = text;
      return { ok: true };
    },
    pressKey: async (key, ref) => {
      calls.push(["pressKey", key, ref]);
      if (key !== "Enter" || ref !== "home:e1" || query !== "citywalk")
        throw new Error("Unexpected search submission");
      page = "results";
      return { ok: true };
    },
    click: async (ref) => {
      calls.push(["click", ref]);
      if (page !== "results" || ref !== "results:e1") throw new Error("Unexpected article ref");
      page = "article";
      return { ok: true };
    },
    waitForLoad: async () => {
      calls.push(["waitForLoad"]);
      return { ok: true };
    },
    readContent: async (options) => {
      calls.push(["readContent", options]);
      return {
        ok: true,
        url: url(),
        text:
          page === "article"
            ? "上海citywalk攻略\n\n第一站:武康路。梧桐树下的老洋房……\n第二站:安福路。咖啡店扎堆……"
            : "首页",
      };
    },
    navigate: unused,
    scroll: unused,
    extractLinks: unused,
    hover: unused,
    selectOption: unused,
    fetchImages: unused,
    screenshot: unused,
    listTabs: unused,
    switchTab: unused,
  };
  return { guest, driver, calls };
}

describe("E2E: 小红书 搜索→打开→扒内容", () => {
  test("full observe→act→read loop produces article text to summarize", async () => {
    const { guest, driver, calls } = fakeXiaohongshu();
    let created = 0;
    const deps: AutomationDeps = {
      activeGuest: () => guest,
      policy: () => ({ allowedDomains: [] }),
      createDriver: (target) => {
        expect(target).toBe(guest);
        created++;
        return driver;
      },
    };
    const act = (req: Parameters<typeof handleBrowserAction>[0]) =>
      handleBrowserAction(req, deps).then(JSON.parse);

    // 1. snapshot home → find the search box
    const home = await act({ action: "snapshot" });
    const searchBox = home.elements.find((e: any) => e.role === "textbox");
    expect(searchBox.ref).toBe(`${home.snapshotId}:e1`);

    // 2. type the query + press Enter (→ results page)
    expect((await act({ action: "type", ref: searchBox.ref, text: "citywalk" })).ok).toBe(true);
    expect((await act({ action: "pressKey", key: "Enter", ref: searchBox.ref })).ok).toBe(true);

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
    expect(created).toBe(1);
    expect(calls).toEqual([
      ["snapshot"],
      ["type", "home:e1", "citywalk"],
      ["pressKey", "Enter", "home:e1"],
      ["waitForLoad"],
      ["snapshot"],
      ["click", "results:e1"],
      ["waitForLoad"],
      ["readContent", { cursor: undefined, maxChars: undefined }],
    ]);
  });
});
