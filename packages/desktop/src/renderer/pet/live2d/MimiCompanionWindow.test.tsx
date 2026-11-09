import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MimiCompanionApi, MimiCompanionState } from "../../../shared/mimi-companion";
import { ensureMiniDom, flushMicrotasks } from "../../test-utils/renderHook";
import { MimiCompanionWindow } from "./MimiCompanionWindow";

function props(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function elements(node: unknown): HTMLElement[] {
  const current = node as HTMLElement;
  return [
    ...(current.tagName ? [current] : []),
    ...Array.from(current.childNodes ?? []).flatMap(elements),
  ];
}

let root: Root | undefined;
let container: HTMLDivElement;
let body: HTMLButtonElement;
let hit: Element | null;
let captured: Set<number>;
let interactions: string[];
let moves: Array<{ x: number; y: number }>;
let chats: number;
let state: MimiCompanionState;
let receiveState: (state: MimiCompanionState) => void;
let originals: Array<[object, string, PropertyDescriptor | undefined]>;

function replace(object: object, key: string, value: unknown) {
  originals.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
}

beforeEach(() => {
  ensureMiniDom();
  originals = [];
  interactions = [];
  moves = [];
  chats = 0;
  captured = new Set();
  hit = document.body;
  replace(document, "visibilityState", "visible");
  replace(document, "hidden", false);
  replace(document, "elementFromPoint", () => hit);
  replace(window, "matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  replace(globalThis, "Image", class {});
  state = {
    enabled: true,
    visible: true,
    size: 200,
    appearance: "mimi-sprite",
    position: { x: 400, y: 200 },
    windowOrigin: { x: 0, y: 0 },
    activity: { id: "idle", action: "idle", phase: "end", startedAt: 0 },
    preview: false,
  };
  const api: MimiCompanionApi = {
    getState: async () => state,
    onState: (listener) => {
      receiveState = listener;
      return () => {};
    },
    ready() {},
    interaction: (phase) => interactions.push(phase),
    move: (position) => moves.push(position),
    openChat: async () => {
      chats += 1;
    },
    openActivity: async () => {},
    handoff: async () => {},
    resumeFollowing() {},
    presence() {},
    resize() {},
    stopComputer() {},
    resumeComputer() {},
  };
  replace(window, "mimiCompanion", api);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  if (container?.parentNode) container.parentNode.removeChild(container);
  for (const [object, key, original] of originals.reverse()) {
    if (original) Object.defineProperty(object, key, original);
    else Reflect.deleteProperty(object, key);
  }
});

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MimiCompanionWindow />);
    await flushMicrotasks();
  });
  body = elements(container).find(
    (node) => props(node).className === "mimi-companion__body",
  ) as HTMLButtonElement;
  expect(body).toBeDefined();
  replace(body, "getBoundingClientRect", () => ({
    x: 400,
    y: 200,
    left: 400,
    top: 200,
    right: 540,
    bottom: 400,
    width: 140,
    height: 200,
  }));
  replace(body, "setPointerCapture", (id: number) => captured.add(id));
  replace(body, "hasPointerCapture", (id: number) => captured.has(id));
  replace(body, "releasePointerCapture", (id: number) => captured.delete(id));
  replace(body, "matches", () => hit === body || body.contains(hit));
  // The mini DOM has tag-name-only closest(); model the interactive CSS target.
  replace(body, "closest", (selector: string) =>
    selector.includes(".mimi-companion__body") ? body : null,
  );
  hit = body;
  interactions.length = 0;
}

async function pointer(handler: string, extras: Record<string, unknown> = {}) {
  await act(async () => {
    props(body)[handler]({
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 420,
      clientY: 220,
      screenX: 420,
      screenY: 220,
      currentTarget: body,
      target: body,
      preventDefault() {},
      ...extras,
    });
  });
}

async function mouseMove(buttons = 0) {
  await act(async () => {
    const event = new Event("mousemove");
    Object.assign(event, { buttons, clientX: 20, clientY: 20, target: hit });
    window.dispatchEvent(event);
  });
}

async function drag() {
  await pointer("onPointerEnter");
  await pointer("onPointerDown");
  await pointer("onPointerMove", { screenX: 500, clientX: 500 });
  expect(moves).toHaveLength(1);
  expect(captured.has(1)).toBe(true);
}

function isHeld() {
  return elements(container).some((node) =>
    String(props(node).className).includes("mimi-companion--held"),
  );
}

describe("moving pet mouse release", () => {
  test("a captured drop outside the body immediately restores click-through", async () => {
    await mount();
    await drag();
    hit = document.body;
    await pointer("onPointerUp", { buttons: 0, clientX: 20, clientY: 20 });
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
    expect(isHeld()).toBe(false);
    expect(captured.size).toBe(0);
    expect(chats).toBe(0);
  });

  test("movement outside recovers a missing pointerleave after drop without repeated IPC", async () => {
    await mount();
    await drag();
    await pointer("onPointerUp", { buttons: 0 });
    hit = document.body;
    await mouseMove();
    expect(interactions.at(-1)).toBe("leave");
    const count = interactions.length;
    await mouseMove();
    expect(interactions).toHaveLength(count);
    expect(chats).toBe(0);
  });

  test("released buttons recover a missing pointerup and cannot move the pet again", async () => {
    await mount();
    await drag();
    hit = document.body;
    await mouseMove();
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
    expect(isHeld()).toBe(false);
    expect(captured.size).toBe(0);
    await pointer("onPointerMove", { buttons: 0, screenX: 800 });
    expect(moves).toHaveLength(1);
    expect(chats).toBe(0);
  });

  test("a captured pointer move with released buttons cancels before moving", async () => {
    await mount();
    await drag();
    await pointer("onPointerMove", { buttons: 0, screenX: 800 });
    expect(moves).toHaveLength(1);
    expect(isHeld()).toBe(false);
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
    expect(chats).toBe(0);
  });

  test("held buttons keep an active drag captured outside the body", async () => {
    await mount();
    await drag();
    hit = document.body;
    const count = interactions.length;
    await mouseMove(1);
    expect(interactions).toHaveLength(count);
    expect(isHeld()).toBe(true);
    expect(captured.has(1)).toBe(true);
    const character = elements(container).find((node) =>
      String(props(node).className).includes("mimi-companion--held"),
    );
    expect(props(character).style.transition).toBe("none");
  });

  for (const interruption of ["blur", "hidden"] as const) {
    test(`${interruption} cancels the gesture and restores click-through`, async () => {
      await mount();
      await drag();
      await act(async () => {
        if (interruption === "blur") window.dispatchEvent(new Event("blur"));
        else {
          replace(document, "visibilityState", "hidden");
          replace(document, "hidden", true);
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect(interactions.slice(-2)).toEqual(["end", "leave"]);
      expect(isHeld()).toBe(false);
      expect(captured.size).toBe(0);
      expect(chats).toBe(0);
    });
  }

  test("cancel and lost capture finish once without opening chat", async () => {
    await mount();
    await pointer("onPointerDown");
    await pointer("onPointerCancel", { buttons: 0 });
    const count = interactions.length;
    await pointer("onLostPointerCapture", { buttons: 0 });
    expect(interactions).toHaveLength(count);
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
    expect(captured.size).toBe(0);
    expect(chats).toBe(0);
  });

  test("withdrawing the presence releases the gesture before the renderer is hidden", async () => {
    await mount();
    await drag();
    await act(async () => receiveState({ ...state, visible: false }));
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
    expect(isHeld()).toBe(false);
    expect(captured.size).toBe(0);
  });

  test("losing focus closes a menu and releases its native interaction hold", async () => {
    await mount();
    await pointer("onContextMenu");
    expect(props(body)["aria-expanded"]).toBe(true);
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(props(body)["aria-expanded"]).toBe(false);
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
  });

  for (const control of ["badge", "handoff"] as const) {
    test(`${control} stays clickable while the pointer is over its content`, async () => {
      state = {
        ...state,
        ...(control === "badge"
          ? { attention: { running: 1, needsAction: 1, unread: 0 } }
          : { handoff: { app: "Example" } }),
      };
      await mount();
      const className = `mimi-companion__${control}`;
      const target = elements(container).find((node) => props(node).className === className)!;
      hit = control === "handoff" ? target.children[0] : target;
      replace(hit, "closest", (selector: string) =>
        selector.includes(`.${className}`) ? target : null,
      );
      await act(async () => props(target).onPointerEnter());
      const count = interactions.length;
      await mouseMove();
      expect(interactions).toHaveLength(count);
      expect(interactions.at(-1)).toBe("hover");
      hit = document.body;
      await mouseMove();
      expect(interactions.at(-1)).toBe("leave");
    });
  }

  test("outside movement keeps an open menu interactive until explicit dismissal", async () => {
    await mount();
    await pointer("onContextMenu");
    const count = interactions.length;
    hit = document.body;
    await mouseMove();
    expect(interactions).toHaveLength(count);
    expect(props(body)["aria-expanded"]).toBe(true);
    await act(async () => {
      const event = new Event("keydown");
      Object.assign(event, { key: "Escape" });
      window.dispatchEvent(event);
    });
    expect(props(body)["aria-expanded"]).toBe(false);
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
  });

  test("unmount releases pointer capture and removes global recovery listeners", async () => {
    await mount();
    await drag();
    await act(async () => root!.unmount());
    root = undefined;
    expect(interactions.slice(-2)).toEqual(["end", "leave"]);
    expect(captured.size).toBe(0);
    const count = interactions.length;
    await mouseMove();
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(interactions).toHaveLength(count);
  });

  test("an ordinary body tap still opens chat", async () => {
    await mount();
    await pointer("onPointerDown");
    await pointer("onPointerUp", { buttons: 0 });
    expect(chats).toBe(1);
    expect(captured.size).toBe(0);
    expect(interactions.at(-1)).toBe("end");
  });
});
