import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { renderHook } from "../test-utils/renderHook";
import { useTargetedDebouncedSave } from "./useTargetedDebouncedSave";

describe("useTargetedDebouncedSave", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("flushes a pending value to its original settings target on scope change", async () => {
    const writes: Array<{ target: string; value: string }> = [];
    let target = "user";
    const hook = await renderHook(() => {
      const renderTarget = target;
      return useTargetedDebouncedSave(
        renderTarget,
        (value: string) => writes.push({ target: renderTarget, value }),
        600,
      );
    });

    act(() => hook.result.current.schedule("global draft"));
    target = "project:/repo";
    await hook.rerender();

    expect(writes).toEqual([{ target: "user", value: "global draft" }]);

    act(() => hook.result.current.schedule("project draft"));
    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(writes).toEqual([
      { target: "user", value: "global draft" },
      { target: "project:/repo", value: "project draft" },
    ]);
    await hook.unmount();
  });

  test("keeps the latest value for one target and preserves object snapshots", async () => {
    const writes: Array<{ language: string; profile: string }> = [];
    const hook = await renderHook(() =>
      useTargetedDebouncedSave(
        "user:response-prefs",
        (value: { language: string; profile: string }) => writes.push(value),
        600,
      ),
    );

    act(() => {
      hook.result.current.schedule({ language: "zh", profile: "first" });
      hook.result.current.schedule({ language: "zh", profile: "latest" });
    });
    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(writes).toEqual([{ language: "zh", profile: "latest" }]);
    await hook.unmount();
  });

  test("a rejected save keeps its value and reports the error until a retry succeeds", async () => {
    const writes: Array<{ target: string; value: string }> = [];
    let fail = true;
    const hook = await renderHook(() =>
      useTargetedDebouncedSave(
        "user:personalization",
        async (value: string) => {
          writes.push({ target: "user:personalization", value });
          if (fail) throw new Error("EISDIR: settings.json");
        },
        600,
      ),
    );

    act(() => hook.result.current.schedule("new instructions"));
    await act(async () => {
      hook.result.current.flush();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.error).toContain("EISDIR");

    fail = false;
    await act(async () => {
      hook.result.current.flush();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writes.map((write) => write.value)).toEqual(["new instructions", "new instructions"]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("leaving after a rejected save retries the unsaved value for its original target", async () => {
    const writes: string[] = [];
    let fail = true;
    const hook = await renderHook(() =>
      useTargetedDebouncedSave(
        "user:personalization",
        async (value: string) => {
          writes.push(value);
          if (fail) throw new Error("disk full");
        },
        600,
      ),
    );
    act(() => hook.result.current.schedule("draft"));
    await act(async () => {
      hook.result.current.flush();
      await Promise.resolve();
      await Promise.resolve();
    });
    fail = false;
    await hook.unmount();
    expect(writes).toEqual(["draft", "draft"]);
  });

  test("a newer edit replaces a failed value instead of being overwritten by it", async () => {
    const writes: string[] = [];
    let rejectFirst!: (error: Error) => void;
    const hook = await renderHook(() =>
      useTargetedDebouncedSave(
        "user:personalization",
        (value: string) => {
          writes.push(value);
          if (writes.length === 1)
            return new Promise<void>((_resolve, reject) => {
              rejectFirst = reject;
            });
        },
        600,
      ),
    );
    act(() => hook.result.current.schedule("old"));
    act(() => hook.result.current.flush());
    act(() => hook.result.current.schedule("newer"));
    await act(async () => {
      rejectFirst(new Error("transient"));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => hook.result.current.flush());
    expect(writes).toEqual(["old", "newer"]);
    await hook.unmount();
  });
});
