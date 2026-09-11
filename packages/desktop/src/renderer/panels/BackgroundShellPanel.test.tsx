import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackgroundWorkInfo } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { BackgroundShellPanel } from "./BackgroundShellPanel";

let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function shell(id: string, owner = "session"): BackgroundWorkInfo {
  return {
    kind: "shell",
    shell: {
      shellId: id,
      sessionId: owner,
      command: `command-${id}`,
      cwd: "/repo",
      status: "exited",
      startedAt: 1,
      exitCode: 0,
      signal: null,
    },
    sourceSession: { sessionId: owner, shortId: owner, current: true },
  };
}

function props(node: any): Record<string, any> {
  const key = Object.keys(node ?? {}).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function nodes(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => nodes(child, tag)),
  ];
}

function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length ? node.childNodes.map(text).join("") : (node.textContent ?? "");
}

function api(overrides: Record<string, unknown>) {
  ensureMiniDom();
  Object.assign(window, {
    codeshell: {
      listBackgroundWork: async () => ({ items: [shell("a"), shell("b")] }),
      ...overrides,
    },
  });
}

async function render(sessionId: string | null = "session", active = true) {
  await act(async () => {
    root?.render(<BackgroundShellPanel sessionId={sessionId} active={active} />);
    await flushMicrotasks();
  });
}

async function mount(sessionId: string | null = "session", active = true) {
  const container = document.createElement("div");
  root = createRoot(container);
  await render(sessionId, active);
  return container;
}

async function clickShell(container: any, id: string) {
  const button = nodes(container, "BUTTON").find((node) => props(node).title === `command-${id}`);
  expect(button).toBeDefined();
  await act(async () => {
    props(button).onClick();
    await flushMicrotasks();
  });
}

async function filesChanged() {
  await act(async () => {
    window.dispatchEvent(new Event("codeshell:files-changed"));
    await flushMicrotasks();
  });
}

describe("BackgroundShellPanel request ownership", () => {
  test("a late output from the previous shell cannot replace the selected shell", async () => {
    const a = deferred<{ header: string; text: string }>();
    const b = deferred<{ header: string; text: string }>();
    api({
      backgroundShellOutput: (_owner: string, id: string) => (id === "a" ? a.promise : b.promise),
    });
    const container = await mount();
    await clickShell(container, "a");
    await clickShell(container, "b");
    await act(async () => {
      b.resolve({ header: "B", text: "output-b" });
      await flushMicrotasks();
    });
    await act(async () => {
      a.resolve({ header: "A", text: "output-a" });
      await flushMicrotasks();
    });
    expect(text(container)).toContain("output-b");
    expect(text(container)).not.toContain("output-a");
  });

  test("an obsolete output failure cannot stop the current shell's loading state", async () => {
    const a = deferred<{ header: string; text: string }>();
    const b = deferred<{ header: string; text: string }>();
    api({
      backgroundShellOutput: (_owner: string, id: string) => (id === "a" ? a.promise : b.promise),
    });
    const container = await mount();
    await clickShell(container, "a");
    await clickShell(container, "b");
    await act(async () => {
      a.reject(new Error("old shell gone"));
      await flushMicrotasks();
    });
    expect(text(container)).not.toContain("old shell gone");
    expect(nodes(container, "PRE")).toHaveLength(0);
    await act(async () => {
      b.resolve({ header: "", text: "current output" });
      await flushMicrotasks();
    });
    expect(text(container)).toContain("current output");
  });

  test("a late list failure from another session cannot erase the current work", async () => {
    const first = deferred<{ items: BackgroundWorkInfo[] }>();
    api({
      listBackgroundWork: (id: string) =>
        id === "first" ? first.promise : Promise.resolve({ items: [shell("current", id)] }),
    });
    const container = await mount("first");
    await render("next");
    await act(async () => {
      first.reject(new Error("old worker stopped"));
      await flushMicrotasks();
    });
    expect(text(container)).toContain("command-current");
    expect(text(container)).not.toContain("old worker stopped");
  });

  test("a vanished shell invalidates its pending output even if it later reappears", async () => {
    let visible = true;
    const old = deferred<{ header: string; text: string }>();
    let reads = 0;
    api({
      listBackgroundWork: async () => ({ items: visible ? [shell("a")] : [] }),
      backgroundShellOutput: () =>
        ++reads === 1 ? old.promise : Promise.resolve({ header: "", text: "new shell output" }),
    });
    const container = await mount();
    await clickShell(container, "a");
    visible = false;
    await filesChanged();
    visible = true;
    await filesChanged();
    await clickShell(container, "a");
    await act(async () => {
      old.resolve({ header: "", text: "reaped shell output" });
      await flushMicrotasks();
    });
    expect(text(container)).toContain("new shell output");
    expect(text(container)).not.toContain("reaped shell output");
  });

  test("a kept-mounted hidden panel defers reads and refreshes when shown", async () => {
    let reads = 0;
    api({
      listBackgroundWork: async () => {
        reads += 1;
        return { items: [] };
      },
    });
    await mount("session", false);
    await filesChanged();
    expect(reads).toBe(0);
    await render("session", true);
    expect(reads).toBe(1);
    await render("session", false);
    await filesChanged();
    expect(reads).toBe(1);
  });
});
