import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { useResponsiveSidebar } from "./useResponsiveSidebar";

describe("responsive sidebar preference and navigation", () => {
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useResponsiveSidebar>>>> | null;
  let widthDescriptor: PropertyDescriptor | undefined;
  let desktopCollapsed: boolean;
  let available: boolean;
  let desktopChanges: number;

  beforeEach(() => {
    ensureMiniDom();
    widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1000,
    });
    desktopCollapsed = false;
    available = true;
    desktopChanges = 0;
    hook = null;
  });
  afterEach(async () => {
    await hook?.unmount();
    if (widthDescriptor) Object.defineProperty(window, "innerWidth", widthDescriptor);
    else Reflect.deleteProperty(window, "innerWidth");
  });
  const mount = async () => {
    hook = await renderHook(() =>
      useResponsiveSidebar(
        desktopCollapsed,
        () => {
          desktopChanges++;
          desktopCollapsed = !desktopCollapsed;
        },
        available,
      ),
    );
  };
  const resize = async (width: number) => {
    await act(async () => {
      Object.assign(window, { innerWidth: width });
      window.dispatchEvent(new Event("resize"));
    });
  };

  test("narrow toggles and resizing preserve an expanded desktop preference", async () => {
    await mount();
    expect(hook!.result.current.visible).toBe(true);
    await resize(390);
    expect(hook!.result.current.visible).toBe(false);
    await act(async () => hook!.result.current.toggle());
    expect(hook!.result.current.visible).toBe(true);
    await resize(680);
    expect(hook!.result.current.visible).toBe(true);
    await resize(390);
    expect(hook!.result.current.visible).toBe(false);
    expect(desktopChanges).toBe(0);
    expect(desktopCollapsed).toBe(false);
  });

  test("a collapsed desktop preference survives a temporary drawer", async () => {
    desktopCollapsed = true;
    await mount();
    await resize(639);
    await act(async () => hook!.result.current.toggle());
    expect(hook!.result.current.visible).toBe(true);
    await resize(640);
    expect(hook!.result.current.narrow).toBe(false);
    expect(hook!.result.current.visible).toBe(false);
    expect(desktopCollapsed).toBe(true);
    expect(desktopChanges).toBe(0);
  });

  test("only explicit wide-window toggles change the desktop preference", async () => {
    await mount();
    await act(async () => hook!.result.current.toggle());
    await hook!.rerender();
    expect(desktopChanges).toBe(1);
    expect(hook!.result.current.visible).toBe(false);
  });

  test("navigation waits for drawer focus restoration and runs once", async () => {
    await resize(390);
    await mount();
    const actions: string[] = [];
    await act(async () => hook!.result.current.toggle());
    await act(async () => hook!.result.current.navigate(() => actions.push("search")));
    expect(hook!.result.current.visible).toBe(false);
    expect(actions).toEqual([]);
    await act(async () => hook!.result.current.afterClose());
    await act(async () => hook!.result.current.afterClose());
    expect(actions).toEqual(["search"]);
    await act(async () => hook!.result.current.navigate(() => actions.push("direct")));
    expect(actions).toEqual(["search", "direct"]);
  });

  test("routes without application chrome dismiss the drawer without changing preferences", async () => {
    await resize(390);
    await mount();
    await act(async () => hook!.result.current.toggle());
    available = false;
    await hook!.rerender();
    expect(hook!.result.current.visible).toBe(false);
    await act(async () => hook!.result.current.toggle());
    available = true;
    await hook!.rerender();
    expect(hook!.result.current.visible).toBe(false);
    expect(desktopChanges).toBe(0);
  });
});
