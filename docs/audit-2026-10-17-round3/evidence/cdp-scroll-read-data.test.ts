import { expect, test } from "bun:test";
import { CdpActionsDriver } from "../../../packages/cdp/src/driver.js";
import type { CdpSender } from "../../../packages/cdp/src/sender.js";

function fixture(options: { move?: boolean; canvas?: boolean; text?: string } = {}) {
  let wheelCount = 0;
  const calls: Array<{ method: string; params?: any }> = [];
  const send: CdpSender = async (method, params) => {
    calls.push({ method, params });
    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseWheel") wheelCount++;
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "frame", loaderId: "loader" } } };
    if (method === "Runtime.evaluate")
      return { result: { value: {
        text: options.text ?? "page text", textLength: 9, contentSignature: "stable",
        wheelPoint: { x: 75, y: 80 },
        scroll: { x: 0, y: options.move && wheelCount ? 100 : 0, maxX: 0, maxY: 100,
          viewportWidth: 200, viewportHeight: 150, atTop: !(options.move && wheelCount),
          atEnd: options.move && wheelCount ? true : false,
          target: options.canvas ? "canvas" : "element", positionKnown: !options.canvas },
      } } };
    return {};
  };
  const driver = new CdpActionsDriver(send, () => ({ url: "about:blank" }), {
    captureScreenshot: async () => ({ ok: true, base64: wheelCount ? "after-pixels" : "before-pixels", mediaType: "image/jpeg" }),
  });
  return { driver, calls, wheelCount: () => wheelCount };
}

test("control: scroll bounds a single wheel to the selected viewport and reports offset progress", async () => {
  const { driver, calls, wheelCount } = fixture({ move: true });
  const result = await driver.scroll("down", -5000);
  expect(result).toMatchObject({ ok: true, code: "OK", documentChanged: false, contentChanged: false, scroll: { y: 100, target: "element" } });
  expect(wheelCount()).toBe(1);
  expect(calls.find((call) => call.params?.type === "mouseWheel")!.params).toMatchObject({ x: 75, y: 80, deltaY: 150, deltaX: 0 });
});

test("control: no progress returns NO_PROGRESS and does not resend wheel", async () => {
  const { driver, wheelCount } = fixture();
  expect(await driver.scroll("down", 50)).toMatchObject({ ok: false, code: "NO_PROGRESS", retryable: false, contentChanged: false });
  expect(wheelCount()).toBe(1);
});

test("control: unknown canvas offset is checked through host-supplied local image signatures", async () => {
  const { driver, wheelCount } = fixture({ canvas: true });
  expect(await driver.scroll("down", 50)).toMatchObject({ ok: true, code: "OK", contentChanged: true, scroll: { y: 0, positionKnown: false, target: "canvas" } });
  expect(wheelCount()).toBe(1);
});

test("control: readContent normalizes text and pages with a same-document cursor", async () => {
  const { driver } = fixture({ text: "  start\r\n\r\n\r\n" + "x".repeat(400) + "  " });
  const first = await driver.readContent({ maxChars: 256 });
  expect(first).toMatchObject({ ok: true, done: false, truncated: true, documentId: "frame:loader" });
  expect(first.text.startsWith("start\n\n")).toBe(true);
  expect(first.text).toHaveLength(256);
  const second = await driver.readContent({ cursor: first.nextCursor, maxChars: 256 });
  expect(second).toMatchObject({ ok: true, done: true, truncated: false, contentHash: first.contentHash });
  expect(first.text + second.text).toBe("start\n\n" + "x".repeat(400));
});

test("control: malformed read cursors are rejected explicitly", async () => {
  const { driver } = fixture();
  expect(await driver.readContent({ cursor: "not-a-cursor" })).toMatchObject({ ok: false, code: "STALE_CURSOR", text: "" });
});
