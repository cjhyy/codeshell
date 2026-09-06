import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider } from "../ui/ToastProvider";
import { Lightbox, type LightboxItem } from "./Lightbox";

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

function renderedText(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data;
  return node.childNodes.length
    ? Array.from(node.childNodes).map(renderedText).join("")
    : (node.textContent ?? "");
}

const PNG = "data:image/png;base64,cHJldmlldw==";

const DEFAULT_GALLERY: LightboxItem[] = [
  { src: PNG, alt: "first image", path: "/tmp/first.png" },
  { src: PNG, alt: "second image", path: "/tmp/second.png" },
];

function ViewerHarness({ items = DEFAULT_GALLERY }: { items?: LightboxItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Open image
      </button>
      {open && (
        <Lightbox
          src={PNG}
          alt={items[0].alt}
          path={items[0].path}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </ToastProvider>
  );
}

describe("Lightbox dialog interactions", () => {
  let root: Root | null;
  let container: HTMLElement;
  let originalTreeWalker: typeof document.createTreeWalker;
  let navigatorDescriptor: PropertyDescriptor | undefined;
  let secureContextDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    ensureMiniDom();
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    secureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async () => undefined } },
    });

    // MiniDOM returns each walked node but does not update currentNode. Supply
    // that browser contract locally so Radix can exercise its real Tab loop.
    originalTreeWalker = document.createTreeWalker;
    document.createTreeWalker = (...args) => {
      const walker = originalTreeWalker.apply(document, args);
      const nextNode = walker.nextNode.bind(walker);
      walker.nextNode = () => {
        const next = nextNode();
        if (next) walker.currentNode = next;
        return next;
      };
      return walker;
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const settle = async () => {
    await flushMicrotasks();
    // Radix intentionally restores focus on a zero-delay unmount timer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  };

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await settle();
    });
    root = null;
    document.body.removeChild(container);
    document.createTreeWalker = originalTreeWalker;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (secureContextDescriptor)
      Object.defineProperty(window, "isSecureContext", secureContextDescriptor);
    else Reflect.deleteProperty(window, "isSecureContext");
  });

  const dialog = () =>
    findElements(document.body, "DIV").find((node) => node.getAttribute("role") === "dialog");

  const openViewer = async (items?: LightboxItem[]) => {
    await act(async () => {
      root?.render(<ViewerHarness items={items} />);
      await settle();
    });
    const opener = findElements(container, "BUTTON")[0];
    opener.focus();
    await act(async () => {
      reactPropsOf(opener).onClick();
      await settle();
    });
    return opener;
  };

  const keyboardEvent = (key: string, currentTarget: HTMLElement, shiftKey = false) => ({
    key,
    currentTarget,
    shiftKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  });

  const dispatchKeyboard = async (
    key: string,
    modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
  ) => {
    const event = new Event("keydown", { bubbles: true, cancelable: true });
    let propagationStopped = false;
    Object.assign(event, {
      key,
      target: document.activeElement,
      ...modifiers,
      stopPropagation() {
        propagationStopped = true;
      },
    });
    await act(async () => {
      // MiniDOM has no native propagation. Follow the browser's order: Radix's
      // document capture listener, React's actual portal/body delegation, then
      // the app's window listener only if propagation remains permitted.
      document.dispatchEvent(event);
      if (!propagationStopped) document.body.dispatchEvent(event);
      if (!propagationStopped) window.dispatchEvent(event);
      await settle();
    });
    return { event, propagationStopped };
  };

  test.each([
    { alt: "", path: "/tmp/no-caption.png", expected: "no-caption.png" },
    { alt: "   ", name: " upload.png ", expected: "upload.png" },
    { alt: "", expected: "图片" },
  ])(
    "gives an empty-alt image a readable dialog name: $expected",
    async ({ expected, ...item }) => {
      await openViewer([{ src: PNG, ...item }]);
      const viewer = dialog()!;
      const title = document.getElementById(viewer.getAttribute("aria-labelledby")!);
      expect(title).not.toBeNull();
      expect(renderedText(title!)).toBe(expected);
      expect(findElements(viewer, "IMG")[0].getAttribute("alt")).toBe(expected);
    },
  );

  test("contains app navigation shortcuts while keeping native copy and modal keyboard navigation", async () => {
    const opener = await openViewer();
    const reachedWindow: string[] = [];
    const onAppKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && ["b", "1"].includes(event.key)) {
        reachedWindow.push(event.key);
      }
    };
    window.addEventListener("keydown", onAppKey);
    try {
      // Confirm this is a live app listener, then drive the real portal event
      // handler instead of directly calling Lightbox's React onKeyDown prop.
      const probe = new Event("keydown");
      Object.assign(probe, { key: "b", metaKey: true });
      window.dispatchEvent(probe);
      expect(reachedWindow).toEqual(["b"]);
      reachedWindow.length = 0;

      for (const key of ["b", "1"]) {
        const dispatched = await dispatchKeyboard(key, { metaKey: true });
        expect(dispatched.propagationStopped).toBe(true);
        expect(dispatched.event.defaultPrevented).toBe(false);
        expect(reachedWindow).toEqual([]);
        expect(dialog()).toBeDefined();
      }
      const nativeCopy = await dispatchKeyboard("c", { metaKey: true });
      expect(nativeCopy.propagationStopped).toBe(true);
      expect(nativeCopy.event.defaultPrevented).toBe(false);

      const viewer = dialog()!;
      const buttons = findElements(viewer, "BUTTON");
      buttons.forEach((button) => {
        button.tabIndex = 0;
      });
      buttons.at(-1)!.focus();
      const tab = await dispatchKeyboard("Tab");
      expect(tab.event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(buttons[0]);
      const backwards = await dispatchKeyboard("Tab", { shiftKey: true });
      expect(backwards.event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(buttons.at(-1));

      await dispatchKeyboard("ArrowRight");
      expect(findElements(viewer, "IMG")[0].getAttribute("alt")).toBe("second image");
      await dispatchKeyboard("ArrowLeft");
      expect(findElements(viewer, "IMG")[0].getAttribute("alt")).toBe("first image");
      await dispatchKeyboard("Escape");
      await act(settle);
      expect(dialog()).toBeUndefined();
      expect(document.activeElement).toBe(opener);
      expect(reachedWindow).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onAppKey);
    }
  });

  test("portals outside the transcript, labels the dialog, traps Tab, and restores the opener", async () => {
    const opener = await openViewer();
    const viewer = dialog()!;
    expect(viewer).toBeDefined();
    expect(container.contains(viewer)).toBe(false);
    expect(document.body.contains(viewer)).toBe(true);
    expect(viewer.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(viewer.getAttribute("aria-labelledby")!);
    expect(renderedText(title!)).toContain("first image");

    const buttons = findElements(viewer, "BUTTON");
    const close = document.activeElement as HTMLElement;
    expect(close === buttons[3]).toBe(true);
    expect(
      buttons.filter(
        (button) => button.getAttribute("aria-label") === close.getAttribute("aria-label"),
      ),
    ).toHaveLength(1);

    // Native buttons are tabbable; MiniDOM defaults every element to -1.
    buttons.forEach((button) => {
      button.tabIndex = 0;
    });
    buttons.at(-1)!.focus();
    const forward = keyboardEvent("Tab", viewer);
    reactPropsOf(viewer).onKeyDown(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement === buttons[0]).toBe(true);
    const backward = keyboardEvent("Tab", viewer, true);
    reactPropsOf(viewer).onKeyDown(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement === buttons.at(-1)).toBe(true);

    await act(async () => {
      reactPropsOf(close).onClick({ defaultPrevented: false });
      await settle();
    });
    await act(settle);
    expect(dialog()).toBeUndefined();
    expect(document.activeElement === opener).toBe(true);
  });

  test("cycles images with arrows and closes with Escape", async () => {
    const opener = await openViewer();
    await act(async () => {
      reactPropsOf(dialog()!).onKeyDown(keyboardEvent("ArrowRight", dialog()!));
      await settle();
    });
    expect(findElements(dialog()!, "IMG")[0].getAttribute("alt")).toBe("second image");
    await act(async () => {
      reactPropsOf(dialog()!).onKeyDown(keyboardEvent("ArrowRight", dialog()!));
      await settle();
    });
    expect(findElements(dialog()!, "IMG")[0].getAttribute("alt")).toBe("first image");

    await act(async () => {
      const event = new Event("keydown", { cancelable: true });
      Object.assign(event, { key: "Escape" });
      document.dispatchEvent(event);
      await settle();
    });
    await act(settle);
    expect(dialog()).toBeUndefined();
    expect(document.activeElement === opener).toBe(true);
  });

  test("reports clipboard failure without showing copied feedback", async () => {
    await openViewer();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async () => {
            throw new Error("clipboard denied");
          },
        },
      },
    });
    const copy = findElements(dialog()!, "BUTTON")[1];
    const initialTitle = copy.getAttribute("title");
    await act(async () => {
      await reactPropsOf(copy).onClick();
      await settle();
    });
    expect(copy.getAttribute("title")).toBe(initialTitle);
    expect(renderedText(container)).toContain("复制失败");
  });

  test("a backdrop pointer click closes the viewer and restores focus", async () => {
    const opener = await openViewer();
    // Allow the deferred outside-pointer listener to attach after opening.
    await act(settle);
    const overlay = findElements(document.body, "DIV").find(
      (node) =>
        node.getAttribute("data-state") === "open" && node.getAttribute("role") !== "dialog",
    )!;
    expect(overlay).toBeDefined();
    await act(async () => {
      const event = new Event("pointerdown", { cancelable: true });
      Object.assign(event, { target: overlay, button: 0, pointerType: "mouse" });
      document.dispatchEvent(event);
      const click = new Event("click", { cancelable: true });
      Object.assign(click, { target: overlay, button: 0 });
      document.dispatchEvent(click);
      await settle();
    });
    await act(settle);
    expect(dialog()).toBeUndefined();
    expect(document.activeElement === opener).toBe(true);
  });

  test("waits for clipboard completion before confirming a copied path", async () => {
    await openViewer();
    let resolveCopy!: () => void;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: () =>
            new Promise<void>((resolve) => {
              resolveCopy = resolve;
            }),
        },
      },
    });
    const copy = findElements(dialog()!, "BUTTON")[1];
    const initialTitle = copy.getAttribute("title");
    let copying: Promise<void>;
    await act(async () => {
      copying = reactPropsOf(copy).onClick();
      await flushMicrotasks();
    });
    expect(copy.getAttribute("title")).toBe(initialTitle);
    await act(async () => {
      resolveCopy();
      await copying;
      await settle();
    });
    expect(copy.getAttribute("title")).toBe("已复制");
    expect(renderedText(container)).toContain("已复制路径");
  });
});
