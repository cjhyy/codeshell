import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider, useToast, useToastHistory } from "./ToastProvider";
import { MAX_TOASTS } from "./toastState";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

function textOf(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data;
  return node.childNodes.length
    ? Array.from(node.childNodes).map(textOf).join("")
    : (node.textContent ?? "");
}

class Clock {
  now = 1_700_000_000_000;
  private sequence = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delay = 0): number => {
    const id = ++this.sequence;
    this.pending.set(id, { at: this.now + delay, callback });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.pending.delete(id);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      this.pending.delete(id);
      timer.callback();
    }
    this.now = target;
  }
}

describe("ToastProvider notification lifetime", () => {
  let root: Root | null;
  let container: HTMLElement;
  let clock: Clock;
  let latest: ReturnType<typeof useToastHistory>;
  let toast: ReturnType<typeof useToast>;
  let references: Array<ReturnType<typeof useToast>>;
  let originalSetTimeout: PropertyDescriptor | undefined;
  let originalClearTimeout: PropertyDescriptor | undefined;
  let originalDateNow: PropertyDescriptor | undefined;
  let originalLocalStorage: PropertyDescriptor | undefined;
  let originalSessionStorage: PropertyDescriptor | undefined;
  let originalBridge: PropertyDescriptor | undefined;

  function Capture({ emitOnMount = false }: { emitOnMount?: boolean }) {
    toast = useToast();
    latest = useToastHistory();
    references.push(toast);
    const emitted = useRef(false);
    useEffect(() => {
      if (!emitOnMount || emitted.current) return;
      emitted.current = true;
      toast({ message: "mount notification", durationMs: 1000 });
    }, [emitOnMount, toast]);
    return null;
  }

  beforeEach(() => {
    ensureMiniDom();
    clock = new Clock();
    references = [];
    latest = null;
    originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
    originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
    originalDateNow = Object.getOwnPropertyDescriptor(Date, "now");
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    originalBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: clock.setTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: clock.clearTimeout,
    });
    Object.defineProperty(Date, "now", { configurable: true, value: () => clock.now });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { log: () => undefined },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
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
    document.body.removeChild(container);
    restore(globalThis, "setTimeout", originalSetTimeout);
    restore(globalThis, "clearTimeout", originalClearTimeout);
    restore(Date, "now", originalDateNow);
    restore(globalThis, "localStorage", originalLocalStorage);
    restore(globalThis, "sessionStorage", originalSessionStorage);
    restore(window, "codeshell", originalBridge);
  });

  const settle = async (action: () => void) => {
    await act(async () => {
      action();
      await flushMicrotasks();
    });
  };
  const mount = (strict = false, emitOnMount = false) =>
    settle(() => {
      const tree = (
        <ToastProvider>
          <Capture emitOnMount={emitOnMount} />
        </ToastProvider>
      );
      root!.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
    });
  const advance = (ms: number) => settle(() => clock.advance(ms));
  const cards = () => descendants(container).filter((node) => props(node).onMouseEnter);
  const dismissButton = (card: Element) =>
    descendants(card).find((node) => node.tagName === "BUTTON") as HTMLButtonElement;

  test("expires the popup while retaining full history and its original timestamp", async () => {
    await mount();
    const createdAt = clock.now;
    await settle(() =>
      toast({
        message: "保存失败",
        detail: "完整命令\n完整错误",
        variant: "error",
        durationMs: 1000,
      }),
    );
    expect(cards()).toHaveLength(1);
    await advance(999);
    expect(cards()).toHaveLength(1);
    await advance(1);
    expect(cards()).toHaveLength(0);
    expect(clock.pending.size).toBe(0);
    expect(latest!.history).toEqual([
      expect.objectContaining({
        message: "保存失败",
        detail: "完整命令\n完整错误",
        variant: "error",
        createdAt,
        read: false,
      }),
    ]);
  });

  test("keeps timers paused until both pointer and keyboard focus leave", async () => {
    await mount();
    await settle(() => toast({ message: "read this", durationMs: 1000 }));
    await advance(250);
    const card = cards()[0]!;
    await settle(() => props(card).onMouseEnter());
    expect(clock.pending.size).toBe(0);
    const close = dismissButton(card);
    await settle(() => {
      close.focus();
      props(card).onFocus();
      props(card).onMouseLeave({ currentTarget: card });
    });
    await advance(2000);
    expect(cards()).toHaveLength(1);
    expect(clock.pending.size).toBe(0);
    await settle(() => {
      document.body.focus();
      props(card).onBlur({ currentTarget: card, relatedTarget: document.body });
    });
    await advance(749);
    expect(cards()).toHaveLength(1);
    await advance(1);
    expect(cards()).toHaveLength(0);

    await settle(() => toast({ message: "focus first", durationMs: 1000 }));
    const focusedCard = cards()[0]!;
    await settle(() => {
      dismissButton(focusedCard).focus();
      props(focusedCard).onFocus();
      props(focusedCard).onMouseEnter();
      document.body.focus();
      props(focusedCard).onBlur({ currentTarget: focusedCard, relatedTarget: document.body });
    });
    await advance(2000);
    expect(cards()).toHaveLength(1);
    expect(clock.pending.size).toBe(0);
    await settle(() => props(focusedCard).onMouseLeave({ currentTarget: focusedCard }));
    await advance(1000);
    expect(cards()).toHaveLength(0);
  });

  test("drops capped popup timers while preserving every notification in history", async () => {
    await mount();
    for (let index = 0; index < MAX_TOASTS + 1; index++) {
      await settle(() => toast({ message: `notification-${index}`, durationMs: 1000 }));
    }
    expect(cards()).toHaveLength(MAX_TOASTS);
    expect(clock.pending.size).toBe(MAX_TOASTS);
    expect(cards().map(textOf)).not.toContain("notification-0");
    expect(latest!.history.map((entry) => entry.message)).toEqual(
      Array.from({ length: MAX_TOASTS + 1 }, (_, index) => `notification-${index}`),
    );
    await advance(1000);
    expect(cards()).toHaveLength(0);
    expect(clock.pending.size).toBe(0);
    expect(latest!.history).toHaveLength(MAX_TOASTS + 1);
  });

  test("expires notifications emitted by mount effects under StrictMode", async () => {
    await mount(true, true);
    expect(cards()).toHaveLength(1);
    expect(latest!.history).toHaveLength(1);
    expect(clock.pending.size).toBe(1);
    await advance(1000);
    expect(cards()).toHaveLength(0);
    expect(clock.pending.size).toBe(0);
    expect(latest!.history).toHaveLength(1);
  });

  test("dismisses sticky notifications explicitly and clears all timers on unmount", async () => {
    await mount();
    await settle(() => toast({ message: "sticky", durationMs: 0 }));
    expect(clock.pending.size).toBe(0);
    await advance(60_000);
    expect(cards()).toHaveLength(1);
    await settle(() => props(dismissButton(cards()[0]!)).onClick());
    expect(cards()).toHaveLength(0);
    expect(latest!.history).toHaveLength(1);
    await settle(() => toast({ message: "still timed", durationMs: 1000 }));
    expect(clock.pending.size).toBe(1);
    await settle(() => {
      root!.unmount();
      root = null;
    });
    expect(clock.pending.size).toBe(0);
    await advance(60_000);
    expect(container.childNodes).toHaveLength(0);
  });

  test("keeps useToast stable as history updates, is read, and is cleared", async () => {
    await mount();
    const first = toast;
    await settle(() => toast({ message: "one", durationMs: 0 }));
    await settle(() => latest!.markRead());
    expect(latest!.history[0]!.read).toBe(true);
    await settle(() => latest!.clear());
    expect(latest!.history).toEqual([]);
    expect(cards()).toHaveLength(1);
    expect(references.length).toBeGreaterThan(2);
    expect(references.every((reference) => reference === first)).toBe(true);
  });

  test("supports isolated consumers without a provider", async () => {
    await settle(() => root!.render(<Capture />));
    expect(latest).toBeNull();
    expect(() => toast({ message: "safe fallback" })).not.toThrow();
    expect(clock.pending.size).toBe(0);
  });
});
