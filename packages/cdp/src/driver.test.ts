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

describe("CdpActionsDriver.pressEnter", () => {
  test("dispatches keyDown + keyUp Enter", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.pressEnter();
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keys.map((k) => k.params?.type)).toEqual(["keyDown", "keyUp"]);
    expect(keys[0]?.params?.key).toBe("Enter");
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
