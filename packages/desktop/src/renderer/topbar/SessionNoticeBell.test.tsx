import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { PetSessionBellState } from "../../shared/pet-notices";

// Radix and friends bind layout effects at import time: install the DOM first.
ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { SessionNoticeBell, SessionNoticeBellButton, sessionBellLabel } =
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

interface FakeBellApi {
  bells: Map<string, PetSessionBellState>;
  calls: Array<{ sessionId: string; on: boolean }>;
  listeners: Set<() => void>;
}

function installApi(api: FakeBellApi): void {
  (window as any).codeshell = {
    pet: {
      getSessionBell: async (sessionId: string) => {
        const bell = api.bells.get(sessionId);
        if (!bell) throw new Error("unknown work Session");
        return bell;
      },
      setSessionBell: async (sessionId: string, on: boolean) => {
        api.calls.push({ sessionId, on });
        const next: PetSessionBellState = on
          ? { on: true, ruleId: "rule-1", channel: "auto", imLabel: "微信", ready: "ready" }
          : { on: false };
        api.bells.set(sessionId, next);
        return next;
      },
      onNoticesChanged: (listener: () => void) => {
        api.listeners.add(listener);
        return () => api.listeners.delete(listener);
      },
    },
  };
}

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  delete (window as any).codeshell;
});

async function mount(sessionId: string | null): Promise<any> {
  const container = document.createElement("div");
  root = createRoot(container as any);
  await act(async () => {
    root!.render(<SessionNoticeBell sessionId={sessionId} />);
    await flushMicrotasks();
  });
  return container;
}

describe("SessionNoticeBell", () => {
  test("labels say what will happen, including an IM that is not ready", () => {
    expect(sessionBellLabel({ on: false }, t as never)).toBe("完成后提醒我");
    expect(sessionBellLabel({ on: true, channel: "desktop" }, t as never)).toBe("会提醒你：桌面");
    expect(sessionBellLabel({ on: true, imLabel: "微信", ready: "unknown" }, t as never)).toBe(
      "会提醒你：微信（微信 未就绪）",
    );
    const off = renderToStaticMarkup(
      <SessionNoticeBellButton state={{ on: false }} onToggle={() => undefined} />,
    );
    expect(off).toContain('data-session-bell="off"');
    expect(off).toContain('title="完成后提醒我"');
    const on = renderToStaticMarkup(
      <SessionNoticeBellButton
        state={{ on: true, imLabel: "微信", ready: "unavailable" }}
        onToggle={() => undefined}
      />,
    );
    expect(on).toContain('data-session-bell="on"');
    expect(on).toContain('data-session-bell-ready="not-ready"');
    expect(on).toContain('aria-pressed="true"');
  });

  test("click toggles the bell through IPC and shows the new state", async () => {
    const api: FakeBellApi = {
      bells: new Map([["s-work", { on: false }]]),
      calls: [],
      listeners: new Set(),
    };
    installApi(api);
    const container = await mount("s-work");
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");

    await act(async () => {
      reactProps(bellButton(container)).onClick();
      await flushMicrotasks();
    });
    expect(api.calls).toEqual([{ sessionId: "s-work", on: true }]);
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("on");
    expect(bellButton(container).getAttribute("title")).toBe("会提醒你：微信");

    // A rule change elsewhere (e.g. the Session finished and spent it) refreshes the bell.
    api.bells.set("s-work", { on: false });
    await act(async () => {
      for (const listener of api.listeners) listener();
      await flushMicrotasks();
    });
    expect(bellButton(container).getAttribute("data-session-bell")).toBe("off");
  });

  test("hidden for Mimi's own Session and Sessions main refuses", async () => {
    installApi({ bells: new Map(), calls: [], listeners: new Set() });
    const container = await mount("s-mimi");
    expect(bellButton(container)).toBeUndefined();
    expect(descendants(container)).toHaveLength(0);
  });

  test("hidden without a work Session", async () => {
    installApi({ bells: new Map([["s-work", { on: false }]]), calls: [], listeners: new Set() });
    const container = await mount(null);
    expect(descendants(container)).toHaveLength(0);
  });
});
