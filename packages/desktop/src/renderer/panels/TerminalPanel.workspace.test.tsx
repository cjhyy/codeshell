import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

class FakeTerminal {
  cols = 80;
  rows = 24;
  buffer = { active: { getLine: () => undefined } };
  loadAddon() {}
  open() {}
  focus() {}
  write() {}
  dispose() {}
  onData() { return { dispose() {} }; }
  registerLinkProvider() { return { dispose() {} }; }
}

class FakeFitAddon {
  fit() {}
}

mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));

const { TerminalPanel } = await import("./TerminalPanel");

let root: Root | null = null;
let container: HTMLElement;
const starts: Array<{ sessionId: string; cwd?: string; cols: number; rows: number }> = [];

beforeEach(() => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  Object.assign(globalThis, {
    // Full stub: this global leaks to later test files in the same bun
    // process; Radix useSize cleanup calls unobserve and would crash on a
    // partial stub.
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.assign(document.documentElement, {
    classList: { contains: () => false },
  });
  starts.length = 0;
  Object.assign(window, {
    codeshell: {
      windowToken: "window-7",
      ptyStart: async (request: (typeof starts)[number]) => {
        starts.push(request);
        return { ok: true };
      },
      ptyResize: async () => undefined,
      ptyWrite: async () => undefined,
      onPtyData: () => () => undefined,
      onPtyExit: () => () => undefined,
      openExternal: async () => undefined,
      openPath: async () => "",
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("TerminalPanel workspace root", () => {
  test("uses the resolved root for its first PTY and never respawns that tab in another cwd", async () => {
    await act(async () => {
      root?.render(<TerminalPanel cwd="/repo/.worktrees/feature" sessionId="term:bucket:1" />);
      await flushMicrotasks();
    });
    expect(starts).toEqual([
      {
        sessionId: "term:bucket:1@window-7",
        cwd: "/repo/.worktrees/feature",
        cols: 80,
        rows: 24,
      },
    ]);

    await act(async () => {
      root?.render(<TerminalPanel cwd="/repo" sessionId="term:bucket:1" />);
      await flushMicrotasks();
    });
    expect(starts).toHaveLength(1);
  });
});
