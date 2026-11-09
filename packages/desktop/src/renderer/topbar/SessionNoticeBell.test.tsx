import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { PetSessionBellState } from "../../shared/pet-notices";

// Radix and friends bind layout effects at import time: install the DOM first.
ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { SessionNoticeBell, SessionNoticeBellButton, isDelegatedOnly, sessionBellLabel } =
  await import("./SessionNoticeBell");
const { translate } = await import("../i18n");

const t = (key: string, params?: Record<string, string | number>) => translate("zh", key, params);

function descendants(node: any): any[] {
  const children = Array.from(node?.childNodes ?? []) as any[];
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function reactProps(node: any): Record<string, any> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function bellButton(container: any): any {
  return descendants(container).find((node) => node.getAttribute?.("data-session-bell"));
}

const OFF: PetSessionBellState = { available: true, on: false, delegated: false };
const ON: PetSessionBellState = {
  available: true,
  on: true,
  origin: "user",
  delegated: false,
  ruleId: "rule-1",
  channel: "auto",
  imLabel: "微信",
  ready: "ready",
};
const DELEGATED: PetSessionBellState = {
  available: true,
  on: true,
  origin: "delegation",
  delegated: true,
  ruleId: "rule-d",
  channel: "auto",
};
const UNAVAILABLE: PetSessionBellState = { available: false, on: false, delegated: false };

interface FakeBellApi {
  bells: Map<string, PetSessionBellState>;
  calls: Array<{ sessionId: string; on: boolean }>;
  listeners: Set<() => void>;
  /** When set, getSessionBell for that Session waits for the test to release it. */
  hold?: { sessionId: string; release?: (bell: PetSessionBellState) => void };
  /** When set, setSessionBell waits for the test to release it. */
  holdSet?: { release?: (bell: PetSessionBellState) => void };
}

function installApi(api: FakeBellApi): void {
  (window as any).codeshell = {
    pet: {
      getSessionBell: (sessionId: string) => {
        if (api.hold?.sessionId === sessionId)
          return new Promise<PetSessionBellState>((resolve) => {
            api.hold!.release = resolve;
          });
        return Promise.resolve(api.bells.get(sessionId) ?? UNAVAILABLE);
      },
      setSessionBell: (sessionId: string, on: boolean) => {
        api.calls.push({ sessionId, on });
        const next = on ? ON : OFF;
        api.bells.set(sessionId, next);
        if (api.holdSet)
          return new Promise<PetSessionBellState>((resolve) => {
            api.holdSet!.release = resolve;
          });
        return Promise.resolve(next);
      },
      onNoticesChanged: (listener: () => void) => {
        api.listeners.add(listener);
        return () => api.listeners.delete(listener);
      },
    },
  };
}

function fakeApi(bells: Array<[string, PetSessionBellState]>): FakeBellApi {
  return { bells: new Map(bells), calls: [], listeners: new Set() };
}

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  delete (window as any).codeshell;
});

async function render(sessionId: string | null): Promise<void> {
  await act(async () => {
    root!.render(<SessionNoticeBell sessionId={sessionId} />);
    await flushMicrotasks();
  });
}

async function mount(sessionId: string | null): Promise<any> {
  const container = document.createElement("div");
  root = createRoot(container as any);
  await render(sessionId);
  return container;
}

async function click(container: any): Promise<void> {
  await act(async () => {
    reactProps(bellButton(container)).onClick?.();
    await flushMicrotasks();
  });
}

describe("SessionNoticeBell", () => {
  test("labels say what will happen, including an IM that is not ready", () => {
    expect(sessionBellLabel(OFF, t as never)).toBe("完成后提醒我");
    expect(
      sessionBellLabel(
        { ...ON, imLabel: undefined, ready: undefined, channel: "desktop" },
        t as never,
      ),
    ).toBe("会提醒你：桌面");
    expect(sessionBellLabel({ ...ON, ready: "unknown" }, t as never)).toBe(
      "会提醒你：微信（微信 未就绪）",
    );
    expect(sessionBellLabel(DELEGATED, t as never)).toBe("Mimi 派的活：完成和卡住都会告诉你");
    // The owner's own rule speaks for the bell even when a delegation also exists.
    expect(isDelegatedOnly({ ...ON, delegated: true })).toBe(false);
    const off = renderToStaticMarkup(
      <SessionNoticeBellButton state={OFF} onToggle={() => undefined} />,
    );
    expect(off).toContain('data-session-bell="off"');
    expect(off).toContain('title="完成后提醒我"');
    const on = renderToStaticMarkup(
      <SessionNoticeBellButton
        state={{ ...ON, ready: "unavailable" }}
        onToggle={() => undefined}
      />,
    );
    expect(on).toContain('data-session-bell="on"');
    expect(on).toContain('data-session-bell-ready="not-ready"');
    expect(on).toContain('aria-pressed="true"');
    const delegated = renderToStaticMarkup(
      <SessionNoticeBellButton state={DELEGATED} onToggle={() => undefined} />,
    );
    expect(delegated).toContain('data-session-bell="delegated"');
    expect(delegated).toContain('aria-disabled="true"');
  });

  test("click toggles the bell through IPC and shows the new state", async () => {
    const api = fakeApi([["s-work", OFF]]);
    installApi(api);
    const container = await mount("s-work");
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");

    await click(container);
    expect(api.calls).toEqual([{ sessionId: "s-work", on: true }]);
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("on");
    expect(bellButton(container).getAttribute("title")).toBe("会提醒你：微信");

    // A rule change elsewhere (e.g. the Session finished and spent it) refreshes the bell.
    api.bells.set("s-work", OFF);
    await act(async () => {
      for (const listener of api.listeners) listener();
      await flushMicrotasks();
    });
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");
  });

  test("Mimi's delegation rule alone is shown read-only: clicking does nothing", async () => {
    const api = fakeApi([["s-work", DELEGATED]]);
    installApi(api);
    const container = await mount("s-work");
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("delegated");
    expect(bellButton(container).getAttribute("title")).toBe("Mimi 派的活：完成和卡住都会告诉你");
    await click(container);
    expect(api.calls).toEqual([]);
  });

  test("hidden for Mimi's own Session and Sessions main does not watch", async () => {
    installApi(fakeApi([["s-mimi", UNAVAILABLE]]));
    const container = await mount("s-mimi");
    expect(bellButton(container)).toBeUndefined();
    expect(descendants(container)).toHaveLength(0);
  });

  test("hidden without a work Session", async () => {
    installApi(fakeApi([["s-work", OFF]]));
    const container = await mount(null);
    expect(descendants(container)).toHaveLength(0);
  });

  test("a late answer about the previous Session is never shown", async () => {
    const api = fakeApi([
      ["s-a", OFF],
      ["s-b", OFF],
    ]);
    api.hold = { sessionId: "s-a" };
    installApi(api);
    const container = await mount("s-a");
    expect(bellButton(container)).toBeUndefined();
    await render("s-b");
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");
    // s-a's bell (on) arrives after the switch: it must not paint over s-b.
    await act(async () => {
      api.hold!.release!(ON);
      await flushMicrotasks();
    });
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");
    // And a click toggles s-b from s-b's own state.
    await click(container);
    expect(api.calls).toEqual([{ sessionId: "s-b", on: true }]);
  });

  test("a toggle still in flight when the Session changes does not land on the new one", async () => {
    const api = fakeApi([
      ["s-a", OFF],
      ["s-b", OFF],
    ]);
    installApi(api);
    const container = await mount("s-a");
    api.holdSet = {};
    await click(container);
    expect(api.calls).toEqual([{ sessionId: "s-a", on: true }]);
    await render("s-b");
    await act(async () => {
      api.holdSet!.release!(ON);
      await flushMicrotasks();
    });
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");
    // s-b is not stuck waiting on s-a's toggle.
    expect(bellButton(container).getAttribute("disabled")).toBeNull();
  });
});
