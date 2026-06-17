import { describe, expect, test } from "bun:test";
import { CdpBrowserDriver, type CdpSender } from "./cdp-driver";

/** A scriptable fake CDP endpoint: records calls, returns canned results. */
function fakeCdp(handlers: Record<string, (params?: any) => any> = {}) {
  const calls: Array<{ method: string; params?: any }> = [];
  const send: CdpSender = async (method, params) => {
    calls.push({ method, params });
    const h = handlers[method];
    return h ? h(params) : {};
  };
  return { send, calls };
}

const AX_TWO = {
  nodes: [
    { nodeId: "1", role: { value: "textbox" }, name: { value: "关键词" }, backendDOMNodeId: 10 },
    { nodeId: "2", role: { value: "button" }, name: { value: "搜索" }, backendDOMNodeId: 20 },
  ],
};
const BOX = (id: number) => ({ model: { content: [0, 0, 100, 0, 100, 40, 0, 40], width: 100, height: 40, _id: id } });

describe("CdpBrowserDriver.snapshot", () => {
  test("enables domains once, flattens AX tree, maps refs", async () => {
    const { send, calls } = fakeCdp({ "Accessibility.getFullAXTree": () => AX_TWO });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com", title: "X" }));

    const snap = await d.snapshot();
    expect(snap.url).toBe("https://x.com");
    expect(snap.elements).toEqual([
      { ref: "e1", role: "textbox", name: "关键词" },
      { ref: "e2", role: "button", name: "搜索" },
    ]);
    // DOM.enable + Accessibility.enable happened before the tree query
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("DOM.enable");
    expect(methods).toContain("Accessibility.enable");

    // second snapshot does NOT re-enable (enabled cached)
    calls.length = 0;
    await d.snapshot();
    expect(calls.map((c) => c.method)).not.toContain("Accessibility.enable");
  });

  test("flags needsHuman when a password field is present", async () => {
    const { send } = fakeCdp({
      "Accessibility.getFullAXTree": () => ({
        nodes: [{ nodeId: "1", role: { value: "textbox" }, name: { value: "password" }, backendDOMNodeId: 5 }],
      }),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com/login" }));
    const snap = await d.snapshot();
    expect(snap.needsHuman).toBeTruthy();
    expect(snap.elements[0]!.sensitive).toBe(true);
  });
});

describe("CdpBrowserDriver.click", () => {
  test("resolves ref → box center → dispatches real mouse press/release", async () => {
    const { send, calls } = fakeCdp({
      "Accessibility.getFullAXTree": () => AX_TWO,
      "DOM.getBoxModel": (p) => BOX(p.backendNodeId),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.snapshot();
    calls.length = 0;

    const r = await d.click("e2");
    expect(r.ok).toBe(true);
    // box was queried for the e2 → backend 20
    expect(calls.find((c) => c.method === "DOM.getBoxModel")?.params.backendNodeId).toBe(20);
    // a real press + release was dispatched at the box center (50,20)
    const press = calls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 50, y: 20, button: "left" });
    expect(calls.some((c) => c.params?.type === "mouseReleased")).toBe(true);
  });

  test("unknown ref → staleRef, no dispatch", async () => {
    const { send, calls } = fakeCdp({ "Accessibility.getFullAXTree": () => AX_TWO });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.snapshot();
    calls.length = 0;
    const r = await d.click("e99");
    expect(r).toMatchObject({ ok: false, staleRef: true });
    expect(calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  test("ref present but box gone → staleRef", async () => {
    const { send } = fakeCdp({
      "Accessibility.getFullAXTree": () => AX_TWO,
      "DOM.getBoxModel": () => ({ model: undefined }), // detached
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.snapshot();
    const r = await d.click("e1");
    expect(r).toMatchObject({ ok: false, staleRef: true });
  });
});

describe("CdpBrowserDriver.type", () => {
  test("focuses then inserts real text", async () => {
    const { send, calls } = fakeCdp({
      "Accessibility.getFullAXTree": () => AX_TWO,
      "DOM.getBoxModel": (p) => BOX(p.backendNodeId),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.snapshot();
    calls.length = 0;
    const r = await d.type("e1", "hello");
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "Input.insertText")?.params.text).toBe("hello");
  });
});

describe("CdpBrowserDriver.navigate / scroll", () => {
  test("navigate calls Page.navigate and invalidates refs", async () => {
    const { send } = fakeCdp({
      "Accessibility.getFullAXTree": () => AX_TWO,
      "DOM.getBoxModel": (p) => BOX(p.backendNodeId),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.snapshot();
    const nav = await d.navigate("https://y.com");
    expect(nav.ok).toBe(true);
    // refs from the old page are now stale
    const r = await d.click("e1");
    expect(r.staleRef).toBe(true);
  });

  test("scroll dispatches a mouseWheel with signed deltaY", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.scroll("down", 800);
    const wheel = calls.find((c) => c.params?.type === "mouseWheel");
    expect(wheel?.params.deltaY).toBe(800);
    calls.length = 0;
    await d.scroll("up");
    expect(calls.find((c) => c.params?.type === "mouseWheel")?.params.deltaY).toBe(-600);
  });
});

describe("CdpBrowserDriver.readContent / waitForLoad / pressEnter", () => {
  test("readContent pulls innerText via Runtime.evaluate and cleans it", async () => {
    const { send } = fakeCdp({
      "Runtime.evaluate": () => ({ result: { value: "标题\n\n\n正文   多空格" } }),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://xhs.com/p/1", title: "探店" }));
    const c = await d.readContent();
    expect(c.ok).toBe(true);
    expect(c.url).toBe("https://xhs.com/p/1");
    expect(c.text).toBe("标题\n\n正文 多空格");
  });

  test("waitForLoad resolves when readyState is complete", async () => {
    const { send, calls } = fakeCdp({ "Runtime.evaluate": () => ({ result: { value: "complete" } }) });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    const r = await d.waitForLoad(1000);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(true);
  });

  test("pressEnter dispatches keyDown+keyUp Enter", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    const r = await d.pressEnter();
    expect(r.ok).toBe(true);
    const downs = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(downs.map((c) => c.params.type)).toEqual(["keyDown", "keyUp"]);
    expect(downs[0]!.params.key).toBe("Enter");
  });

  test("pressEnter on a focused ref clicks it first", async () => {
    const { send, calls } = fakeCdp({
      "Accessibility.getFullAXTree": () => AX_TWO,
      "DOM.getBoxModel": (p) => BOX(p.backendNodeId),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    await d.snapshot();
    calls.length = 0;
    const r = await d.pressEnter("e1");
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true); // focused via click
    expect(calls.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(true);
  });
});

describe("CdpBrowserDriver.extractLinks", () => {
  test("runs in-page JS via Runtime.evaluate, returns links/images + url/title", async () => {
    const { send, calls } = fakeCdp({
      "Runtime.evaluate": () => ({
        result: {
          value: {
            links: [{ text: "笔记", url: "https://xhs.com/p/1" }],
            images: [{ url: "https://cdn.xhs.com/a.jpg", alt: "封面" }],
            truncated: false,
          },
        },
      }),
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://xhs.com/explore", title: "发现" }));
    const r = await d.extractLinks();
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://xhs.com/explore");
    expect(r.title).toBe("发现");
    expect(r.links).toEqual([{ text: "笔记", url: "https://xhs.com/p/1" }]);
    expect(r.images).toEqual([{ url: "https://cdn.xhs.com/a.jpg", alt: "封面" }]);
    // It used Runtime.evaluate with returnByValue (one DOM pass, not the a11y tree).
    const ev = calls.find((c) => c.method === "Runtime.evaluate");
    expect(ev?.params?.returnByValue).toBe(true);
    expect(String(ev?.params?.expression)).toContain("a[href]");
  });

  test("CDP error → ok:false with detail, never throws", async () => {
    const { send } = fakeCdp({
      "Runtime.evaluate": () => {
        throw new Error("eval blew up");
      },
    });
    const d = new CdpBrowserDriver(send, () => ({ url: "https://x.com" }));
    const r = await d.extractLinks();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("eval blew up");
    expect(r.links).toEqual([]);
    expect(r.images).toEqual([]);
  });
});
