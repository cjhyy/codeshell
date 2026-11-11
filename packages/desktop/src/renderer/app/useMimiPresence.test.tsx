import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import type { MimiPresenceSnapshot } from "../../shared/mimi-presence";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { useMimiPresence } from "./useMimiPresence";

const snapshot = (patch: Partial<MimiPresenceSnapshot> = {}): MimiPresenceSnapshot => ({
  visible: false,
  mode: "docked",
  effectiveMode: "docked",
  size: 200,
  shown: null,
  movingAvailable: true,
  previewing: false,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Mimi presence projection", () => {
  let bridgeBefore: PropertyDescriptor | undefined;
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useMimiPresence>>>> | undefined;
  let initial: ReturnType<typeof deferred<MimiPresenceSnapshot>>;
  let onPresence: (state: MimiPresenceSnapshot) => void;
  let offPresence: ReturnType<typeof mock>;
  let offVisibility: ReturnType<typeof mock>;
  let pet: any;
  beforeEach(() => {
    ensureMiniDom();
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    initial = deferred<MimiPresenceSnapshot>();
    offPresence = mock(() => {});
    offVisibility = mock(() => {});
    pet = {
      getPresence: mock(() => initial.promise),
      onPresenceChanged: (listener: typeof onPresence) => {
        onPresence = listener;
        return offPresence;
      },
      onWidgetVisibilityChanged: () => offVisibility,
      setPresence: mock(async () => snapshot({ visible: true, shown: "docked" })),
      setWidgetVisible: mock(async () => ({ ok: true })),
    };
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { pet, log: mock(() => {}) },
    });
  });
  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });
  test("a host broadcast wins over a stale initial read", async () => {
    hook = await renderHook(useMimiPresence);
    const moving = snapshot({
      visible: true,
      mode: "moving",
      effectiveMode: "moving",
      shown: "moving",
    });
    await act(async () => onPresence(moving));
    await act(async () => initial.resolve(snapshot()));
    expect(hook.result.current.mimiPresence).toEqual(moving);
    expect(hook.result.current.petWidgetVisible).toBe(true);
  });
  test("the menu sends its change to the same presence owner", async () => {
    hook = await renderHook(useMimiPresence);
    await act(async () => initial.resolve(snapshot()));
    await act(async () => hook!.result.current.togglePetWidget());
    expect(pet.setPresence).toHaveBeenCalledWith({ visible: true });
    expect(pet.setWidgetVisible).not.toHaveBeenCalled();
    expect(hook.result.current.petWidgetVisible).toBe(true);
    expect(hook.result.current.mimiPresence?.shown).toBe("docked");
  });
  test("an earlier reply cannot overwrite a newer request or host broadcast", async () => {
    hook = await renderHook(useMimiPresence);
    await act(async () => initial.resolve(snapshot()));
    const first = deferred<MimiPresenceSnapshot>();
    const second = deferred<MimiPresenceSnapshot>();
    pet.setPresence
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await act(async () => {
      hook!.result.current.changeMimiPresence({ visible: true });
      hook!.result.current.changeMimiPresence({ visible: false });
    });
    await act(async () => second.resolve(snapshot()));
    await act(async () => first.resolve(snapshot({ visible: true, shown: "docked" })));
    expect(hook.result.current.petWidgetVisible).toBe(false);
    expect(hook.result.current.mimiPresence?.visible).toBe(false);
  });
  test("a failed change or retry is reported until the next request succeeds", async () => {
    hook = await renderHook(useMimiPresence);
    await act(async () => initial.resolve(snapshot()));
    expect(hook.result.current.presenceError).toBeNull();
    pet.setPresence.mockImplementationOnce(async () => {
      throw new Error("display server unavailable");
    });
    await act(async () => hook!.result.current.changeMimiPresence({ mode: "moving" }));
    expect(hook.result.current.presenceError).toBe("display server unavailable");
    pet.retryPresence = mock(async () => {
      throw new Error("still unavailable");
    });
    await act(async () => hook!.result.current.retryMimi());
    expect(hook.result.current.presenceError).toBe("still unavailable");
    await act(async () => hook!.result.current.changeMimiPresence({ mode: "docked" }));
    expect(hook.result.current.presenceError).toBeNull();
  });

  test("an older request's failure cannot replace a newer request's outcome", async () => {
    hook = await renderHook(useMimiPresence);
    await act(async () => initial.resolve(snapshot()));
    let failFirst!: (error: Error) => void;
    const first = new Promise<MimiPresenceSnapshot>((_, reject) => {
      failFirst = reject;
    });
    pet.setPresence.mockImplementationOnce(() => first);
    await act(async () => {
      hook!.result.current.changeMimiPresence({ mode: "moving" });
      hook!.result.current.changeMimiPresence({ mode: "docked" });
    });
    expect(hook.result.current.presenceError).toBeNull();
    await act(async () => failFirst(new Error("stale failure")));
    expect(hook.result.current.presenceError).toBeNull();
  });

  test("unmount removes both listeners and ignores pending reads", async () => {
    hook = await renderHook(useMimiPresence);
    await hook.unmount();
    hook = undefined;
    expect(offPresence).toHaveBeenCalledTimes(1);
    expect(offVisibility).toHaveBeenCalledTimes(1);
    await act(async () => initial.resolve(snapshot({ visible: true })));
  });
});
