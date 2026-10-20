import { expect, test } from "bun:test";
import { CdpActionsDriver } from "../../../packages/cdp/src/driver.js";
import { keyInfo, planKeySequence } from "../../../packages/cdp/src/keymap.js";
import type { CdpSender } from "../../../packages/cdp/src/sender.js";

function fixture(quad: number[]) {
  const calls: Array<{ method: string; params?: any }> = [];
  const send: CdpSender = async (method, params) => {
    calls.push({ method, params });
    if (method === "DOM.getBoxModel") return { model: { content: quad } };
    if (method === "Page.getLayoutMetrics")
      return { cssLayoutViewport: { clientWidth: 100, clientHeight: 100 } };
    return {};
  };
  return {
    calls,
    driver: new CdpActionsDriver(send, () => ({ url: "about:blank" })),
  };
}

// Independent half-plane oracle for these convex, clockwise CDP quadrilaterals.
function inQuad(quad: number[], point: { x: number; y: number }) {
  const crosses = Array.from({ length: 4 }, (_, i) => {
    const j = (i + 1) % 4;
    const ax = quad[2 * i]!;
    const ay = quad[2 * i + 1]!;
    const bx = quad[2 * j]!;
    const by = quad[2 * j + 1]!;
    return (bx - ax) * (point.y - ay) - (by - ay) * (point.x - ax);
  });
  return crosses.every((n) => n >= 0) || crosses.every((n) => n <= 0);
}

test("observed: clipped rotated box dispatches a click outside its actual quad", async () => {
  // A thin rotated rectangle. Its actual center (10, 10) is already visible;
  // scrolling is unnecessary. Its bounding rectangle crosses all viewport edges.
  const quad = [-100, 110, 110, -100, 120, -90, -90, 120];
  const { driver, calls } = fixture(quad);
  expect(inQuad(quad, { x: 10, y: 10 })).toBe(true);
  expect(await driver.clickNode(7)).toEqual({ ok: true });
  const press = calls.find((call) => call.params?.type === "mousePressed")!.params;
  expect({ x: press.x, y: press.y }).toEqual({ x: 50, y: 50 });
  expect(inQuad(quad, press)).toBe(false);
  console.log(JSON.stringify({ case: "clipped-rotated-click", expectedExample: { x: 10, y: 10 }, actual: { x: press.x, y: press.y }, actualInsideQuad: inQuad(quad, press) }));
});

test("observed: hover shares the same out-of-quad point", async () => {
  const quad = [-100, 110, 110, -100, 120, -90, -90, 120];
  const { driver, calls } = fixture(quad);
  expect(await driver.hoverNode(7)).toEqual({ ok: true });
  const move = calls.find((call) => call.params?.type === "mouseMoved")!.params;
  expect(inQuad(quad, move)).toBe(false);
});

test("control: axis-aligned partial viewport intersection remains on the target", async () => {
  const quad = [80, 10, 120, 10, 120, 50, 80, 50];
  const { driver } = fixture(quad);
  const point = await driver.centerOf(7);
  expect(point).toEqual({ x: 90, y: 30 });
  expect(inQuad(quad, point!)).toBe(true);
});

test("control: a wholly visible rotated quad has a valid center", async () => {
  const quad = [0, 50, 50, 0, 100, 50, 50, 100];
  const { driver } = fixture(quad);
  const point = await driver.centerOf(7);
  expect(point).toEqual({ x: 50, y: 50 });
  expect(inQuad(quad, point!)).toBe(true);
});

test("observed: Shift+a has uppercase text but lowercase logical key on down and up", () => {
  const events = planKeySequence("Shift+a");
  expect(events[1]).toMatchObject({ key: "a", code: "KeyA", text: "A", modifiers: 8 });
  expect(events[2]).toMatchObject({ key: "a", code: "KeyA", modifiers: 8 });
  console.log(JSON.stringify({ case: "shifted-logical-key", expectedKey: "A", actualDown: events[1], actualUp: events[2] }));
});

test("observed: Shift+1 has exclamation text but digit logical key", () => {
  expect(planKeySequence("Shift+1")[1]).toMatchObject({ key: "1", code: "Digit1", text: "!", modifiers: 8 });
});

test("control: unshifted printable key and Control shortcut retain their payloads", () => {
  expect(planKeySequence("a")[0]).toMatchObject({ key: "a", code: "KeyA", text: "a" });
  const shortcut = planKeySequence("Control+a")[1]!;
  expect(shortcut).toMatchObject({ key: "a", code: "KeyA", modifiers: 2 });
  expect(shortcut).not.toHaveProperty("text");
});

test("known duplicate: literal plus is mapped but lost by combination tokenization", async () => {
  expect(keyInfo("+")).toEqual({ code: "Equal", windowsVirtualKeyCode: 187 });
  expect(planKeySequence("+")).toEqual([]);
  expect(planKeySequence("Control++").map((event) => event.key)).toEqual(["Control", "Control"]);
  const { driver, calls } = fixture([]);
  expect(await driver.pressKey("+")).toMatchObject({ ok: false });
  expect(calls).toEqual([]);
});

test("candidate: sided modifier names get a physical code but contribute no modifier bit", () => {
  const events = planKeySequence("ControlLeft+a");
  expect(events[0]).toMatchObject({ key: "ControlLeft", code: "ControlLeft" });
  expect(events[1]).toMatchObject({ key: "a", text: "a" });
  expect(events[1]).not.toHaveProperty("modifiers");
});
