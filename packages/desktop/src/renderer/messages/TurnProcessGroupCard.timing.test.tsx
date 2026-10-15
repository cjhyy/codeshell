import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { TurnProcessGroupCard } from "./TurnProcessGroupCard";
import type { RenderedTurnProcessGroup } from "./streamGroups";

function text(node: unknown): string {
  const item = node as {
    childNodes?: unknown[];
    nodeValue?: string;
    nodeType?: number;
    textContent?: string;
  };
  if (item.nodeType === 3) return item.nodeValue ?? item.textContent ?? "";
  return item.childNodes?.length
    ? Array.from(item.childNodes).map(text).join("")
    : (item.textContent ?? "");
}

function buttons(node: unknown): any[] {
  const item = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(item.tagName === "BUTTON" ? [item] : []),
    ...Array.from(item.childNodes ?? []).flatMap(buttons),
  ];
}

function props(node: any): Record<string, any> {
  return node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
}

describe("process card lifecycle clock", () => {
  let root: Root;
  let container: HTMLElement;
  let wallClock = 110_000;
  let tick: (() => void) | undefined;
  let restore: (() => void)[];
  const base: RenderedTurnProcessGroup = {
    kind: "turn_process_group",
    id: "process",
    startedAt: 100_000,
    firstToolStartedAt: 109_000,
    durationMs: 0,
    isLive: true,
    toolCount: 1,
    items: [],
  };

  beforeEach(() => {
    ensureMiniDom();
    wallClock = 110_000;
    tick = undefined;
    container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    const now = spyOn(Date, "now").mockImplementation(() => wallClock);
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
    ) => {
      tick = callback;
      return 1;
    }) as typeof setInterval);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    restore = [() => now.mockRestore(), () => interval.mockRestore(), () => clear.mockRestore()];
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    restore.forEach((callback) => callback());
  });

  async function render(group: RenderedTurnProcessGroup, epoch = 0): Promise<void> {
    await act(async () => {
      root.render(<TurnProcessGroupCard group={group} turnEpoch={epoch} />);
      await flushMicrotasks();
    });
  }

  test("uses the whole run start and catches up after a delayed timer tick", async () => {
    await render(base);
    expect(text(container)).toContain("已处理 10s");
    wallClock = 123_000;
    await act(async () => {
      tick?.();
      await flushMicrotasks();
    });
    expect(text(container)).toContain("已处理 23s");
  });

  test("freezes completion and collapses even when the epoch update was coalesced", async () => {
    await render(base);
    await render({ ...base, isLive: false, completedCleanly: true, durationMs: 12_000 });
    expect(text(container)).toContain("已处理 12s");
    expect(props(buttons(container)[0])["aria-expanded"]).toBe(false);
    wallClock = 199_000;
    await act(async () => {
      tick?.();
      await flushMicrotasks();
    });
    expect(text(container)).toContain("已处理 12s");
  });

  test("keeps abnormal completion expanded and preserves a manually reopened historical card", async () => {
    await render(base);
    const failed = { ...base, isLive: false, completedCleanly: false, durationMs: 12_000 };
    await render(failed);
    expect(props(buttons(container)[0])["aria-expanded"]).toBe(true);
    await render(failed, 2);
    expect(props(buttons(container)[0])["aria-expanded"]).toBe(true);
  });
});
