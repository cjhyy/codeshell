import { describe, expect, test } from "bun:test";
import { CdpActionsDriver, buildExtractScript, cleanPageText } from "./driver.js";
import type { CdpSender } from "./sender.js";

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

const BOX = { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };

describe("CdpActionsDriver.snapshot", () => {
  test("enables domains once and returns RAW nodes (no flattening)", async () => {
    const nodes = [{ nodeId: "1", role: { value: "button" }, name: { value: "ok" }, backendDOMNodeId: 7 }];
    const { send, calls } = fakeCdp({ "Accessibility.getFullAXTree": () => ({ nodes }) });
    const d = new CdpActionsDriver(send, () => ({ url: "https://x.com", title: "X" }));

    const raw = await d.snapshot();
    expect(raw.url).toBe("https://x.com");
    expect(raw.nodes).toEqual(nodes); // raw, not flattened
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("DOM.enable");
    expect(methods).toContain("Accessibility.enable");

    calls.length = 0;
    await d.snapshot();
    expect(calls.map((c) => c.method)).not.toContain("Accessibility.enable");
  });
});

describe("CdpActionsDriver.clickNode", () => {
  test("scrolls into view, resolves box center, dispatches real 3-event click", async () => {
    const { send, calls } = fakeCdp({ "DOM.getBoxModel": () => BOX });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.clickNode(20);
    expect(r.ok).toBe(true);
    const seq = calls.map((c) => `${c.method}:${c.params?.type ?? ""}`);
    expect(seq).toEqual([
      "DOM.scrollIntoViewIfNeeded:",
      "DOM.getBoxModel:",
      "Input.dispatchMouseEvent:mouseMoved",
      "Input.dispatchMouseEvent:mousePressed",
      "Input.dispatchMouseEvent:mouseReleased",
    ]);
    // center of [0,0,100,0,100,40,0,40] = (50,20)
    const press = calls.find((c) => c.params?.type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 50, y: 20, button: "left", clickCount: 1 });
  });

  test("falls back to JS .click() when the node has no layout box", async () => {
    const { send, calls } = fakeCdp({
      "DOM.getBoxModel": () => ({ model: null }),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.clickNode(5);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("JS fallback");
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("DOM.resolveNode");
    expect(methods).toContain("Runtime.callFunctionOn");
  });
});

describe("CdpActionsDriver.typeNode", () => {
  test("focuses by click then inserts text", async () => {
    const { send, calls } = fakeCdp({ "DOM.getBoxModel": () => BOX });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.typeNode(10, "hello");
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === "Input.insertText" && c.params?.text === "hello")).toBe(true);
  });
});

describe("CdpActionsDriver.scroll", () => {
  test("dispatches mouseWheel with signed deltaY", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.scroll("down", 300);
    expect(calls[0]?.params).toMatchObject({ type: "mouseWheel", deltaY: 300 });
    calls.length = 0;
    await d.scroll("up");
    expect(calls[0]?.params).toMatchObject({ type: "mouseWheel", deltaY: -600 });
  });
});

describe("CdpActionsDriver.hoverNode", () => {
  test("moves mouse to center without pressing", async () => {
    const { send, calls } = fakeCdp({ "DOM.getBoxModel": () => BOX });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.hoverNode(9);
    expect(r.ok).toBe(true);
    const moves = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(moves.map((m) => m.params?.type)).toEqual(["mouseMoved"]);
  });
});

describe("CdpActionsDriver.pressKey", () => {
  test("dispatches the planned sequence for a combination", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.pressKey("Control+a");
    expect(r.ok).toBe(true);
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keys.map((k) => `${k.params?.type}:${k.params?.key}`)).toEqual([
      "keyDown:Control",
      "keyDown:a",
      "keyUp:a",
      "keyUp:Control",
    ]);
  });
});

describe("CdpActionsDriver.selectOptionNode", () => {
  test("calls JS setter on the select node and reports the match", async () => {
    const { send, calls } = fakeCdp({
      "DOM.resolveNode": () => ({ object: { objectId: "sel-1" } }),
      "Runtime.callFunctionOn": () => ({ result: { value: { ok: true, matched: "中国" } } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.selectOptionNode(30, "中国");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("中国");
    const fn = calls.find((c) => c.method === "Runtime.callFunctionOn");
    expect(fn?.params?.objectId).toBe("sel-1");
    expect(fn?.params?.arguments).toEqual([{ value: "中国" }]);
  });

  test("returns available options on no match", async () => {
    const { send } = fakeCdp({
      "DOM.resolveNode": () => ({ object: { objectId: "sel-1" } }),
      "Runtime.callFunctionOn": () => ({ result: { value: { ok: false, options: ["中国", "美国"] } } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.selectOptionNode(30, "火星");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("中国 / 美国");
  });
});

describe("buildExtractScript", () => {
  test("includes link, image, and video collection", () => {
    const s = buildExtractScript(50);
    expect(s).toContain("a[href]");
    expect(s).toContain("img[src]");
    expect(s).toContain("querySelectorAll('video')");
    expect(s).toContain("source[src]");
    expect(s).toContain("var cap=50");
  });
});

describe("cleanPageText", () => {
  test("collapses whitespace and caps with truncation marker", () => {
    expect(cleanPageText("a\r\n\r\n\r\nb")).toEqual({ text: "a\n\nb", truncated: false });
    const long = "x".repeat(20);
    expect(cleanPageText(long, 10)).toEqual({ text: "x".repeat(10) + "\n…(truncated)", truncated: true });
  });
});
