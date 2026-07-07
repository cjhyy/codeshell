import { describe, expect, test } from "bun:test";
import {
  CdpActionsDriver,
  buildExtractScript,
  cleanPageText,
  validateNavigationUrl,
} from "./driver.js";
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
    const nodes = [
      { nodeId: "1", role: { value: "button" }, name: { value: "ok" }, backendDOMNodeId: 7 },
    ];
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
      "DOM.enable:",
      "Accessibility.enable:",
      "DOM.scrollIntoViewIfNeeded:",
      "DOM.getBoxModel:",
      "Page.getLayoutMetrics:",
      "Input.dispatchMouseEvent:mouseMoved",
      "Input.dispatchMouseEvent:mousePressed",
      "Input.dispatchMouseEvent:mouseReleased",
    ]);
    // center of [0,0,100,0,100,40,0,40] = (50,20)
    const press = calls.find((c) => c.params?.type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 50, y: 20, button: "left", clickCount: 1 });
  });

  test("fails when the node has no layout box instead of using JS .click()", async () => {
    const { send, calls } = fakeCdp({
      "DOM.getBoxModel": () => ({ model: null }),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.clickNode(5);
    expect(r).toMatchObject({ ok: false, staleRef: true });
    const methods = calls.map((c) => c.method);
    expect(methods).not.toContain("DOM.resolveNode");
    expect(methods).not.toContain("Runtime.callFunctionOn");
  });

  test("clicks inside the visible viewport intersection", async () => {
    const { send, calls } = fakeCdp({
      "DOM.getBoxModel": () => ({
        model: { content: [760, 10, 860, 10, 860, 50, 760, 50] },
      }),
      "Page.getLayoutMetrics": () => ({ layoutViewport: { clientWidth: 800, clientHeight: 600 } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.clickNode(20);
    expect(r.ok).toBe(true);
    const press = calls.find((c) => c.params?.type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 780, y: 30 });
  });

  test("fails when the node has no visible viewport intersection", async () => {
    const { send, calls } = fakeCdp({
      "DOM.getBoxModel": () => ({
        model: { content: [900, 10, 1000, 10, 1000, 50, 900, 50] },
      }),
      "Page.getLayoutMetrics": () => ({ layoutViewport: { clientWidth: 800, clientHeight: 600 } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.clickNode(20);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });
});

describe("CdpActionsDriver.typeNode", () => {
  test("focuses by click then inserts text", async () => {
    const { send, calls } = fakeCdp({ "DOM.getBoxModel": () => BOX });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));

    const r = await d.typeNode(10, "hello");
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === "Input.insertText" && c.params?.text === "hello")).toBe(
      true,
    );
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
      "Runtime.callFunctionOn": () => ({
        result: { value: { ok: false, options: ["中国", "美国"] } },
      }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.selectOptionNode(30, "火星");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("中国 / 美国");
  });
});

describe("buildExtractScript", () => {
  test("includes link, image, and video collection + ref tagging", () => {
    const s = buildExtractScript(50);
    expect(s).toContain("a[href]");
    expect(s).toContain("img[src]");
    expect(s).toContain("querySelectorAll('video')");
    expect(s).toContain("source[src]");
    expect(s).toContain("data-codeshell-cdp-ref");
    expect(s).toContain("data-codeshell-cdp-run");
    expect(s).toContain("removeAttribute(REF_ATTR)");
    expect(s).not.toContain("data-cs-ref");
    expect(s).toContain("var cap=50");
    expect(s).toContain("function pushVid(s,ref)");
    expect(s).toContain("videos.push({url:s,ref:ref})");
    expect(s).toContain("pushVid(vd.currentSrc,ref)");
    expect(s).toContain("pushVid(srcs[m].src,ref)");
  });
});

describe("CdpActionsDriver.fetchImageData", () => {
  test("runs in-page fetch+canvas and returns parsed base64", async () => {
    const { send, calls } = fakeCdp({
      "Runtime.evaluate": () => ({
        result: { value: { ok: true, dataUrl: "data:image/jpeg;base64,QUJD" } },
      }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.fetchImageData("img3");
    expect(r).toMatchObject({ ok: true, mediaType: "image/jpeg", base64: "QUJD", ref: "img3" });
    // the in-page expression must reference the ref by data-cs-ref
    const ev = calls.find((c) => c.method === "Runtime.evaluate");
    expect(ev?.params?.expression).toContain("img3");
    expect(ev?.params?.expression).toContain("AbortController");
    expect(ev?.params?.expression).toContain("data-codeshell-cdp-ref");
    expect(ev?.params?.awaitPromise).toBe(true);
  });

  test("passes a finite timeout into the in-page image fetch", async () => {
    const { send, calls } = fakeCdp({
      "Runtime.evaluate": () => ({
        result: { value: { ok: true, dataUrl: "data:image/jpeg;base64,QUJD" } },
      }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }), { imageFetchTimeoutMs: 1234 });
    await d.fetchImageData("img3");
    const ev = calls.find((c) => c.method === "Runtime.evaluate");
    expect(ev?.params?.expression).toContain(", 1234)");
    expect(ev?.params?.expression).toContain("image fetch timed out");
  });

  test("sanitizes maxDim before interpolating it into page JavaScript", async () => {
    const { send, calls } = fakeCdp({
      "Runtime.evaluate": () => ({
        result: { value: { ok: true, dataUrl: "data:image/jpeg;base64,QUJD" } },
      }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.fetchImageData("img3", "1);window.__pwned=1;//" as unknown as number);
    const ev = calls.find((c) => c.method === "Runtime.evaluate");
    expect(ev?.params?.expression).not.toContain("__pwned");
    expect(ev?.params?.expression).toContain('"img3", 1568, 15000');
  });

  test("reports missing ref", async () => {
    const { send } = fakeCdp({
      "Runtime.evaluate": () => ({ result: { value: { ok: false, missing: true } } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.fetchImageData("img9");
    expect(r.ok).toBe(false);
    expect(r.staleRef).toBe(true);
    expect(r.detail).toContain("not found");
  });
});

describe("CdpActionsDriver.screenshot", () => {
  test("viewport: scales natively via clip.scale, no page round-trip", async () => {
    const { send, calls } = fakeCdp({
      "Page.getLayoutMetrics": () => ({ layoutViewport: { clientWidth: 3136, clientHeight: 800 } }),
      "Page.captureScreenshot": () => ({ data: "QUJD" }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.screenshot();
    expect(r).toMatchObject({ ok: true, mediaType: "image/jpeg", base64: "QUJD" });
    const shot = calls.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params?.format).toBe("jpeg");
    // 3136px wide → scale 1568/3136 = 0.5; CDP resizes server-side
    expect(shot?.params?.clip).toMatchObject({ x: 0, y: 0, width: 3136, height: 800, scale: 0.5 });
    // CRITICAL: no Runtime.evaluate (the old in-page canvas downscale that stalled)
    expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
  });

  test("element box: clips to the box and scale 1 when within maxDim", async () => {
    const { send, calls } = fakeCdp({
      "DOM.getBoxModel": () => ({ model: { content: [10, 20, 110, 20, 110, 70, 10, 70] } }),
      "Page.captureScreenshot": () => ({ data: "QUJD" }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.screenshot(42);
    const shot = calls.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params?.clip).toMatchObject({ x: 10, y: 20, width: 100, height: 50, scale: 1 });
  });

  test("element box: scrolls then clamps the clip to the visible viewport", async () => {
    const { send, calls } = fakeCdp({
      "DOM.getBoxModel": () => ({ model: { content: [-10, 100, 50, 100, 50, 180, -10, 180] } }),
      "Page.getLayoutMetrics": () => ({
        layoutViewport: { pageX: 0, pageY: 120, clientWidth: 40, clientHeight: 40 },
      }),
      "Page.captureScreenshot": () => ({ data: "QUJD" }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.screenshot(42);
    expect(calls.some((c) => c.method === "DOM.scrollIntoViewIfNeeded")).toBe(true);
    const shot = calls.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params?.clip).toMatchObject({ x: 0, y: 120, width: 40, height: 40, scale: 1 });
    expect(shot?.params?.captureBeyondViewport).toBe(false);
  });

  test("element with no box → stale error", async () => {
    const { send } = fakeCdp({ "DOM.getBoxModel": () => ({ model: null }) });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.screenshot(7);
    expect(r.ok).toBe(false);
    expect(r.staleRef).toBe(true);
  });
});

describe("CdpActionsDriver.navigate", () => {
  test("normalizes and navigates allowed http(s) URLs", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.navigate("https://example.com/path");
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "Page.navigate")?.params.url).toBe(
      "https://example.com/path",
    );
  });

  test("blocks unsafe schemes before Page.navigate", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.navigate("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("scheme");
    expect(calls.some((c) => c.method === "Page.navigate")).toBe(false);
  });

  test("honors an optional host policy callback", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }), { canNavigate: () => false });
    const r = await d.navigate("https://example.com/");
    expect(r).toMatchObject({ ok: false, detail: "navigation blocked by host policy" });
    expect(calls.some((c) => c.method === "Page.navigate")).toBe(false);
  });
});

describe("validateNavigationUrl", () => {
  test("allows about:blank but not other about URLs", () => {
    expect(validateNavigationUrl("about:blank")).toMatchObject({ ok: true, url: "about:blank" });
    expect(validateNavigationUrl("about:srcdoc")).toMatchObject({ ok: false });
  });

  test("rejects relative URLs", () => {
    expect(validateNavigationUrl("example.com")).toMatchObject({ ok: false });
  });
});

describe("cleanPageText", () => {
  test("collapses whitespace and caps with truncation marker", () => {
    expect(cleanPageText("a\r\n\r\n\r\nb")).toEqual({ text: "a\n\nb", truncated: false });
    const long = "x".repeat(20);
    expect(cleanPageText(long, 10)).toEqual({
      text: "x".repeat(10) + "\n…(truncated)",
      truncated: true,
    });
  });
});

describe("waitForLoad NaN/negative timeout guard", () => {
  // Footgun: deadline = Date.now() + timeoutMs. A NaN timeout makes
  // `Date.now() > NaN` always false, so `while(true)` never exits — an infinite
  // loop hammering Runtime.evaluate. The default only applies to `undefined`,
  // not NaN. waitForLoad must treat a non-finite/non-positive timeout as the
  // default so it still terminates.
  test("a NaN timeout uses the default deadline, not an infinite loop", async () => {
    // Pre-guard, deadline = Date.now()+NaN = NaN → `Date.now() > NaN` always
    // false → infinite loop even though readyState eventually completes. With
    // the guard, the default 10s deadline applies and the loop polls normally,
    // so once the page reports "complete" it returns. (Page completes on the
    // 3rd poll → returns fast, proving the loop is live & bounded, not stuck.)
    let polls = 0;
    const { send } = fakeCdp({
      "Runtime.evaluate": () => ({ result: { value: ++polls >= 3 ? "complete" : "loading" } }),
    });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const r = await d.waitForLoad(Number.NaN);
    expect(r.ok).toBe(true);
    expect(polls).toBe(3); // looped (not stuck at NaN-deadline), then completed
  });

  test("a completed page still returns immediately", async () => {
    const { send } = fakeCdp({ "Runtime.evaluate": () => ({ result: { value: "complete" } }) });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    expect((await d.waitForLoad(Number.NaN)).ok).toBe(true);
  });

  // The original infinite-loop case: page NEVER completes + NaN timeout. The
  // guard makes it terminate at the default 10s deadline instead of spinning
  // forever. Necessarily ~10s of real polling — the only path that proves
  // termination of the never-completing case. (12s test budget.)
  test("a never-completing page with NaN timeout terminates at the default deadline", async () => {
    const { send } = fakeCdp({ "Runtime.evaluate": () => ({ result: { value: "loading" } }) });
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    const started = Date.now();
    const r = await d.waitForLoad(Number.NaN);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(11_500); // ~10s default, NOT forever
  }, 12_000);
});

describe("scroll NaN amount guard", () => {
  test("a NaN amount does not send NaN deltaY to CDP", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.scroll("down", Number.NaN);
    const wheel = calls.find((c) => c.method === "Input.dispatchMouseEvent");
    expect(wheel).toBeDefined();
    expect(Number.isFinite(wheel!.params.deltaY)).toBe(true); // not NaN
    expect(wheel!.params.deltaY).toBeGreaterThan(0); // fell back to default down-scroll
  });

  test("a normal amount scrolls by that amount", async () => {
    const { send, calls } = fakeCdp();
    const d = new CdpActionsDriver(send, () => ({ url: "u" }));
    await d.scroll("down", 300);
    const wheel = calls.find((c) => c.method === "Input.dispatchMouseEvent");
    expect(wheel!.params.deltaY).toBe(300);
  });
});
