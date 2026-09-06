import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import type { SessionContentSearchResult } from "../../preload/types";
import { useSessionContentSearch } from "./useSessionContentSearch";

describe("conversation content lookup", () => {
  let originalBridge: typeof window.codeshell;
  let hook: Awaited<
    ReturnType<typeof renderHook<ReturnType<typeof useSessionContentSearch>>>
  > | null;
  let enabled: boolean;
  let term: string;
  let requests: Array<{
    term: string;
    resolve: (result: SessionContentSearchResult) => void;
    reject: (error: Error) => void;
  }>;

  beforeEach(() => {
    ensureMiniDom();
    jest.useFakeTimers();
    originalBridge = window.codeshell;
    enabled = true;
    term = "first query";
    requests = [];
    hook = null;
    window.codeshell = {
      ...originalBridge,
      searchSessionContent: (query) =>
        new Promise((resolve, reject) => requests.push({ term: query, resolve, reject })),
    };
  });
  afterEach(async () => {
    await hook?.unmount();
    window.codeshell = originalBridge;
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  const advance = async (milliseconds = 300) => {
    await act(async () => {
      jest.advanceTimersByTime(milliseconds);
      await Promise.resolve();
    });
  };
  const result = (scannedSessions: number): SessionContentSearchResult => ({
    matches: [],
    scannedSessions,
    truncated: false,
  });
  const mount = async () => {
    hook = await renderHook(() => useSessionContentSearch(enabled, term));
  };

  test("debounces typing and issues only the latest query", async () => {
    await mount();
    await advance(150);
    term = "latest query";
    await hook!.rerender();
    await advance(299);
    expect(requests).toHaveLength(0);
    expect(hook!.result.current.loading).toBe(true);
    await advance(1);
    expect(requests.map((request) => request.term)).toEqual(["latest query"]);
    await act(async () => requests[0].resolve(result(7)));
    expect(hook!.result.current.result?.scannedSessions).toBe(7);
    expect(hook!.result.current.loading).toBe(false);
  });

  test("older responses cannot replace a newer resolved query", async () => {
    await mount();
    await advance();
    term = "second query";
    await hook!.rerender();
    await advance();
    await act(async () => requests[1].resolve(result(2)));
    await act(async () => requests[0].resolve(result(1)));
    expect(hook!.result.current.result?.scannedSessions).toBe(2);
  });

  test("a new term hides previous matches immediately while it waits", async () => {
    await mount();
    await advance();
    await act(async () => requests[0].resolve(result(1)));
    term = "changed query";
    await hook!.rerender();
    expect(hook!.result.current.result).toBeNull();
    expect(hook!.result.current.loading).toBe(true);
  });

  test("leaving content mode or closing cancels both pending and running lookups", async () => {
    await mount();
    enabled = false;
    await hook!.rerender();
    await advance();
    expect(requests).toHaveLength(0);
    enabled = true;
    await hook!.rerender();
    await advance();
    enabled = false;
    await hook!.rerender();
    await act(async () => requests[0].resolve(result(4)));
    expect(hook!.result.current.result).toBeNull();
    expect(hook!.result.current.loading).toBe(false);
    enabled = true;
    await hook!.rerender();
    expect(hook!.result.current.result).toBeNull();
    await advance();
    expect(requests).toHaveLength(2);
  });

  test("failure is distinct from empty results and the same query can retry", async () => {
    await mount();
    await advance();
    await act(async () => requests[0].reject(new Error("fixture unavailable")));
    expect(hook!.result.current.failed).toBe(true);
    expect(hook!.result.current.result).toBeNull();
    await act(async () => hook!.result.current.retry());
    expect(hook!.result.current.loading).toBe(true);
    expect(hook!.result.current.failed).toBe(false);
    await advance();
    await act(async () => requests[1].resolve(result(0)));
    expect(hook!.result.current.failed).toBe(false);
    expect(hook!.result.current.result).toEqual(result(0));
  });

  test("returning to the same text starts a fresh request without old results or errors", async () => {
    await mount();
    await advance();
    await act(async () => requests[0].resolve(result(1)));
    term = "second query";
    await hook!.rerender();
    term = "first query";
    await hook!.rerender();
    expect(hook!.result.current.result).toBeNull();
    expect(hook!.result.current.loading).toBe(true);
    await advance();
    await act(async () => requests[1].reject(new Error("temporary failure")));
    expect(hook!.result.current.failed).toBe(true);
    term = "second query";
    await hook!.rerender();
    term = "first query";
    await hook!.rerender();
    expect(hook!.result.current.failed).toBe(false);
    expect(hook!.result.current.loading).toBe(true);
  });

  test("unmount cancels scheduled work", async () => {
    await mount();
    await hook!.unmount();
    hook = null;
    await advance();
    expect(requests).toHaveLength(0);
  });
});
