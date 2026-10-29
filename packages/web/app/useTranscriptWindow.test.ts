import { expect, test } from "bun:test";
import { act } from "react";
import type { ChatItem } from "../src/lib/streamReducer.js";
import { renderHook } from "../src/test-utils/renderHook.js";
import { useTranscriptWindow } from "./useTranscriptWindow.js";

const messages = (count: number, prefix = "message"): ChatItem[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: "user",
    id: `${prefix}-${index}`,
    text: `Saved input ${index}`,
  }));

test("large history renders its tail while retaining every item and every live append", async () => {
  let items = messages(2000);
  const original = items;
  const listRef = { current: null };
  const hook = await renderHook(() =>
    useTranscriptWindow({
      items,
      scope: "first",
      loading: false,
      listRef,
      pauseFollowing: () => {},
    }),
  );
  try {
    expect(hook.result.current.items.length).toBe(80);
    expect(hook.result.current.hidden).toBe(1920);
    expect(hook.result.current.items[0]).toBe(original[1920]);
    expect(original.length).toBe(2000);
    await act(async () => hook.result.current.showEarlier());
    expect(hook.result.current.items.length).toBe(160);
    items = [...items, ...messages(20, "live")];
    await hook.rerender();
    expect(hook.result.current.items[0]).toBe(original[1840]);
    expect(hook.result.current.items.length).toBe(180);
    expect(hook.result.current.items.at(-1)?.id).toBe("live-19");
    while (hook.result.current.hidden) {
      await act(async () => hook.result.current.showEarlier());
    }
    expect(hook.result.current.items).toBe(items);
    expect(hook.result.current.items[0]).toBe(original[0]);
  } finally {
    await hook.unmount();
  }
});

test("a new session waits for completed history; reconnect keeps its expanded boundary", async () => {
  let items = messages(100);
  let scope = "first",
    loading = true;
  const listRef = { current: null };
  const hook = await renderHook(() =>
    useTranscriptWindow({
      items,
      scope,
      loading,
      listRef,
      pauseFollowing: () => {},
    }),
  );
  try {
    items = messages(2000);
    loading = false;
    await hook.rerender();
    expect(hook.result.current.hidden).toBe(1920);
    await act(async () => hook.result.current.showEarlier());
    loading = true;
    await hook.rerender();
    items = structuredClone(items);
    loading = false;
    await hook.rerender();
    expect(hook.result.current.hidden).toBe(1840);
    expect(hook.result.current.items.length).toBe(160);
    scope = "second";
    items = [];
    loading = true;
    await hook.rerender();
    items = messages(1000, "second");
    loading = false;
    await hook.rerender();
    expect(hook.result.current.hidden).toBe(920);
    expect(hook.result.current.items[0].id).toBe("second-920");
  } finally {
    await hook.unmount();
  }
});

test("small conversations remain complete as their current run grows", async () => {
  let items = messages(10);
  const hook = await renderHook(() =>
    useTranscriptWindow({
      items,
      scope: "live",
      loading: false,
      listRef: { current: null },
      pauseFollowing: () => {},
    }),
  );
  try {
    items = messages(150);
    await hook.rerender();
    expect(hook.result.current.hidden).toBe(0);
    expect(hook.result.current.items).toBe(items);
  } finally {
    await hook.unmount();
  }
});

test("visiting an empty pending session resets a previous session's expanded window", async () => {
  const history = messages(2000);
  let items = history;
  let scope = "first",
    loading = false;
  const hook = await renderHook(() =>
    useTranscriptWindow({
      items,
      scope,
      loading,
      listRef: { current: null },
      pauseFollowing: () => {},
    }),
  );
  try {
    await act(async () => hook.result.current.showEarlier());
    expect(hook.result.current.items.length).toBe(160);
    scope = "pending";
    items = [];
    loading = true;
    await hook.rerender();
    scope = "first";
    items = history;
    loading = false;
    await hook.rerender();
    expect(hook.result.current.items.length).toBe(80);
    expect(hook.result.current.hidden).toBe(1920);
  } finally {
    await hook.unmount();
  }
});
