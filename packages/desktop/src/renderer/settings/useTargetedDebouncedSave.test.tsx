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
});
