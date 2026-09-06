import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PAGE_REGISTRY } from "./PageRegistry";
import type { ViewMode } from "../view";

// App suites stub the canonical palette module. Exercise the real command
// registry without replacing those shared integration-test boundaries.
const { buildCommands } = await import("../shell/CommandPalette?session-history-route");

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  const children = Array.from(node.childNodes);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

describe("session history page route", () => {
  let root: Root;
  let container: HTMLElement;
  let storageBefore: PropertyDescriptor | undefined;
  let apiBefore: PropertyDescriptor | undefined;

  beforeEach(() => {
    ensureMiniDom();
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    apiBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { listSessions: async () => [], listSessionTitles: async () => ({}) },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.removeChild(container);
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (apiBefore) Object.defineProperty(window, "codeshell", apiBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("the palette route renders history and forwards the host's new-conversation action", async () => {
    let mode: ViewMode = "chat";
    let created = 0;
    const noop = () => undefined;
    const commands = buildCommands({
      setViewMode: (next) => {
        mode = next;
      },
      openPanel: noop,
      toggleSidebar: noop,
      toggleInspector: noop,
      clearTranscript: noop,
      openSearch: noop,
    });
    commands.find((command) => command.id === "go.sessions")!.run();
    expect(mode).toBe("sessions");
    const route = PAGE_REGISTRY.get(mode)!;
    expect(route.render).toBeFunction();
    // Load the route's module before rendering its lazy wrapper. In a combined
    // run it may be the first import, whose I/O is not a microtask flush.
    await import("../sessions/SessionsView");
    await act(async () => {
      root.render(
        <React.Suspense fallback={null}>
          {route.render!({
            runsInitialRunId: null,
            activeProjectPath: null,
            onNewSession: () => {
              created++;
            },
          })}
        </React.Suspense>,
      );
      await flushMicrotasks();
    });
    const nodes = descendants(container);
    expect(nodes.filter((node) => node.tagName === "H1").map(textOf)).toEqual(["会话历史"]);
    expect(textOf(container)).toContain("还没有会话记录");
    const newSession = nodes.find(
      (node) => node.tagName === "BUTTON" && textOf(node) === "新会话",
    )!;
    expect(props(newSession).type).toBe("button");
    await act(async () => props(newSession).onClick());
    expect(created).toBe(1);
  });
});
