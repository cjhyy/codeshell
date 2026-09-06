import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { CollapsibleContent } from "./CollapsibleContent";

function findElements(node: Node, tagName: string): HTMLElement[] {
  return [
    ...((node as HTMLElement).tagName === tagName ? [node as HTMLElement] : []),
    ...Array.from(node.childNodes).flatMap((child) => findElements(child, tagName)),
  ];
}

function reactPropsOf(node: HTMLElement): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

describe("CollapsibleContent container resize", () => {
  let root: Root | null;
  let container: HTMLElement;
  let availableWidth: number;
  let measurementCount: number;
  let heightDescriptor: PropertyDescriptor | undefined;
  let observerDescriptor: PropertyDescriptor | undefined;
  const observers: ObservedResize[] = [];

  class ObservedResize {
    disconnected = false;
    target: Element | null = null;

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    observe(target: Element): void {
      this.target = target;
    }

    unobserve(): void {
      this.target = null;
    }

    disconnect(): void {
      this.disconnected = true;
    }

    deliver(): void {
      // MiniDOM has no layout engine. Model the browser's geometry change and
      // deliver its ResizeObserver notification without a React/window resize.
      this.callback([], this as unknown as ResizeObserver);
    }
  }

  beforeEach(() => {
    ensureMiniDom();
    availableWidth = 720;
    measurementCount = 0;
    observers.length = 0;
    heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        measurementCount += 1;
        return availableWidth < 500 ? 480 : 120;
      },
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ObservedResize,
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = null;
    restore(HTMLElement.prototype, "scrollHeight", heightDescriptor);
    restore(globalThis, "ResizeObserver", observerDescriptor);
  });

  const render = async () => {
    await act(async () => {
      root?.render(
        <CollapsibleContent>
          <p>A pasted message that wraps across more lines when the side panel grows.</p>
        </CollapsibleContent>,
      );
      await flushMicrotasks();
    });
  };

  const button = () => findElements(container, "BUTTON")[0];
  const controlledContent = (toggle: HTMLElement) =>
    findElements(container, "DIV").find(
      (node) => node.getAttribute("id") === toggle.getAttribute("aria-controls"),
    );

  test("measures initially, updates for a narrower/wider container, and releases listeners", async () => {
    await render();
    expect(button()).toBeUndefined();
    expect(observers).toHaveLength(1);
    expect(observers[0].target).not.toBeNull();

    availableWidth = 360;
    await act(async () => {
      observers[0].deliver();
      await flushMicrotasks();
    });
    const toggle = button();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const content = controlledContent(toggle);
    expect(content).toBeDefined();
    expect(content!.style.maxHeight).toBe("320px");

    availableWidth = 720;
    await act(async () => {
      observers[0].deliver();
      await flushMicrotasks();
    });
    expect(button()).toBeUndefined();
    expect(content!.style.maxHeight).toBe("");

    await act(async () => {
      root?.unmount();
      root = null;
      await flushMicrotasks();
    });
    expect(observers[0].disconnected).toBe(true);
    const measurementsBeforeLateDelivery = measurementCount;
    observers[0].deliver();
    window.dispatchEvent(new Event("resize"));
    expect(measurementCount).toBe(measurementsBeforeLateDelivery);
  });

  test("clamps tall content on first layout and preserves the user's expansion across resizing", async () => {
    availableWidth = 360;
    await render();
    const toggle = button();
    const content = controlledContent(toggle)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.style.maxHeight).toBe("320px");

    await act(async () => {
      reactPropsOf(toggle).onClick();
      await flushMicrotasks();
    });
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(content.style.maxHeight).toBe("");

    availableWidth = 720;
    await act(async () => {
      observers[0].deliver();
      await flushMicrotasks();
    });
    expect(button()).toBeUndefined();
    availableWidth = 360;
    await act(async () => {
      observers[0].deliver();
      await flushMicrotasks();
    });
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(content.style.maxHeight).toBe("");
    expect(observers).toHaveLength(1);

    await act(async () => {
      reactPropsOf(button()).onClick();
      await flushMicrotasks();
    });
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(content.style.maxHeight).toBe("320px");
  });

  test("keeps the window resize fallback when ResizeObserver is unavailable", async () => {
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: undefined });
    await render();
    expect(button()).toBeUndefined();

    availableWidth = 360;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await flushMicrotasks();
    });
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(controlledContent(button())!.style.maxHeight).toBe("320px");
  });
});
