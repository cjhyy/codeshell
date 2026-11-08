import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { MimiBubblePanel } from "../../shared/mimi-presence";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { usePetBubbleMouse } from "./usePetBubbleMouse";

let reports: boolean[];
let section: HTMLElement;
let child: HTMLElement;
let target: Element | null;
let resize: () => void;
let disconnected: boolean;
let cleanup: (() => Promise<void>) | undefined;
let originals: Array<[object, string, PropertyDescriptor | undefined]>;
let points: number[][];

function replace(object: object, key: string, value: unknown) {
  originals.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
}

beforeEach(() => {
  ensureMiniDom();
  originals = [];
  reports = [];
  points = [];
  disconnected = false;
  section = document.createElement("section");
  child = document.createElement("button");
  section.appendChild(child);
  target = document.body;
  replace(window, "screenX", 200);
  replace(window, "screenY", 100);
  replace(document, "elementFromPoint", (x: number, y: number) => {
    points.push([x, y]);
    return target;
  });
  replace(
    globalThis,
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(node: Element) {
        expect(node).toBe(section);
      }
      disconnect() {
        disconnected = true;
      }
    },
  );
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  for (const [object, key, original] of originals.reverse()) {
    if (original) Object.defineProperty(object, key, original);
    else Reflect.deleteProperty(object, key);
  }
});

const report = (value: boolean) => reports.push(value);

async function mount(enabled = true) {
  const hook = await renderHook(() => {
    const [panel, setPanel] = useState<MimiBubblePanel | null>("activity");
    const ref = usePetBubbleMouse(enabled, panel, report);
    // The component attaches this ref only to its rendered panel section.
    ref.current = panel ? section : null;
    return { setPanel };
  });
  cleanup = hook.unmount;
  return hook;
}

function mouse(type: string, extras: Record<string, unknown> = {}) {
  const event = new Event(type);
  Object.assign(event, { clientX: 20, clientY: 30, buttons: 0, relatedTarget: null }, extras);
  window.dispatchEvent(event);
}

describe("bubble mouse hit testing", () => {
  test("empty space yields; visible content and its descendants capture", async () => {
    await mount();
    expect(reports).toEqual([false]);
    mouse("mousemove");
    expect(reports.at(-1)).toBe(false);
    target = child;
    mouse("mousemove");
    mouse("mousemove"); // Main can reset independently; always reassert on movement.
    expect(reports.slice(-2)).toEqual([true, true]);
    expect(points.at(-1)).toEqual([20, 30]);
    target = document.body;
    mouse("mousemove");
    expect(reports.at(-1)).toBe(false);
    target = null;
    mouse("mousemove");
    expect(reports.at(-1)).toBe(false);
  });

  test("a panel shrinking under a stationary pointer restores pass-through", async () => {
    await mount();
    target = child;
    mouse("mousemove");
    expect(reports.at(-1)).toBe(true);
    target = document.body;
    resize();
    expect(reports.at(-1)).toBe(false);
  });

  test("window relocation invalidates cached coordinates until fresh movement", async () => {
    await mount();
    target = child;
    mouse("mousemove");
    window.screenX = 500;
    resize();
    expect(reports.at(-1)).toBe(false);
    mouse("mousemove", { clientX: 11, clientY: 12 });
    expect(reports.at(-1)).toBe(true);
    expect(points.at(-1)).toEqual([11, 12]);
  });

  test("selection drags retain mouseup outside content, then yield", async () => {
    await mount();
    target = child;
    mouse("mousedown", { buttons: 1 });
    target = document.body;
    mouse("mousemove", { buttons: 1 });
    mouse("mouseout", { buttons: 1 });
    expect(reports.at(-1)).toBe(true);
    mouse("mouseup");
    expect(reports.at(-1)).toBe(false);
  });

  test("leaving the window or losing focus clears stale capture", async () => {
    await mount();
    target = child;
    mouse("mousemove");
    mouse("mouseout", { relatedTarget: section });
    expect(reports.at(-1)).toBe(true);
    mouse("mouseout");
    expect(reports.at(-1)).toBe(false);
    resize();
    expect(reports.at(-1)).toBe(false);
    mouse("mousedown", { buttons: 1 });
    window.dispatchEvent(new Event("blur"));
    resize();
    expect(reports.at(-1)).toBe(false);
  });

  test("switching and closing panels recomputes capture and removes listeners", async () => {
    const hook = await mount();
    target = child;
    mouse("mousemove");
    target = document.body;
    await act(async () => hook.result.current.setPanel("chat"));
    expect(reports.at(-1)).toBe(false);
    target = child;
    mouse("mousemove");
    await act(async () => hook.result.current.setPanel(null));
    expect(reports.at(-1)).toBe(false);
    expect(disconnected).toBe(true);
    const count = reports.length;
    mouse("mousemove");
    resize(); // An already-queued observer callback cannot recapture after cleanup.
    expect(reports).toHaveLength(count);
    await act(async () => hook.result.current.setPanel("chat"));
    // The pointer can move while the native window is hidden; do not reuse it.
    expect(reports.at(-1)).toBe(false);
    mouse("mousemove");
    expect(reports.at(-1)).toBe(true);
  });

  test("unmount releases capture; the docked widget never reports bubble state", async () => {
    await mount();
    target = child;
    mouse("mousemove");
    await cleanup?.();
    cleanup = undefined;
    expect(reports.at(-1)).toBe(false);
    reports = [];
    await mount(false);
    mouse("mousemove");
    mouse("mousedown");
    expect(reports).toEqual([]);
  });
});
