import { describe, expect, test } from "bun:test";
import type { MimiCompanionAttention } from "../../shared/mimi-companion";
import type { MimiPresenceSnapshot } from "../../shared/mimi-presence";
import { createMimiBubbleHost } from "./mimi-bubble-host";

const workArea = { x: 0, y: 0, width: 1512, height: 944 };

function setup(options: { companion?: boolean; failLoad?: boolean } = {}) {
  const listeners = new Map<string, (event: any, payload: unknown) => void>();
  const attention: Array<MimiCompanionAttention | undefined> = [];
  const overviews: Array<{ prompt: string } | undefined> = [];
  const sent: unknown[] = [];
  const ignoredMouseEvents: boolean[] = [];
  let destroyed = 0;
  const host = createMimiBubbleHost({
    platform: "darwin",
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    ipcMain: { on: (channel: string, listener: any) => listeners.set(channel, listener) } as any,
    ready: async () => {},
    createWindow: (bounds) => {
      let visible = false;
      let gone = false;
      return {
        isDestroyed: () => gone,
        isVisible: () => visible,
        isFocused: () => false,
        getBounds: () => ({ ...bounds }),
        setBounds: (next) => {
          bounds = { ...next };
        },
        show: () => (visible = true),
        showInactive: () => (visible = true),
        focus() {},
        hide: () => (visible = false),
        destroy: () => {
          gone = true;
          destroyed++;
        },
        setAlwaysOnTop() {},
        setContentProtection() {},
        setIgnoreMouseEvents: (ignore: boolean) => ignoredMouseEvents.push(ignore),
        moveTop() {},
        on() {},
        webContents: {
          id: 11,
          send: (_channel: string, payload: unknown) => sent.push(payload),
          on() {},
        },
      };
    },
    load: async () => {
      if (options.failLoad) throw new Error("load failed");
    },
    companion: () =>
      options.companion === false ? undefined : { setAttention: (value) => attention.push(value) },
    openOverview: async (request) => {
      overviews.push(request);
    },
  });
  const snapshot = (patch: Partial<MimiPresenceSnapshot>): MimiPresenceSnapshot => ({
    visible: true,
    mode: "moving",
    size: 200,
    effectiveMode: "moving",
    shown: "moving",
    movingAvailable: true,
    previewing: false,
    ...patch,
  });
  return {
    host,
    listeners,
    attention,
    overviews,
    sent,
    ignoredMouseEvents,
    snapshot,
    destroyed: () => destroyed,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createMimiBubbleHost", () => {
  test("lives only while moving is the wanted form", async () => {
    const { host, snapshot, destroyed, attention } = setup();
    host.sync(snapshot({}));
    await tick();
    expect(host.surface.active()).toBe(true);
    expect(host.surface.window()).not.toBeNull();
    host.sync(snapshot({ effectiveMode: "docked", mode: "docked", shown: "docked" }));
    expect(host.surface.active()).toBe(false);
    expect(destroyed()).toBe(1);
    // Its counts no longer apply once it is gone.
    expect(attention.at(-1)).toBeUndefined();
  });

  test("only the bubble's own renderer feeds the badge", async () => {
    const { host, listeners, snapshot, attention } = setup();
    host.sync(snapshot({}));
    await tick();
    const report = listeners.get("pet:bubble-attention")!;
    report({ sender: { id: 99 } }, { running: 1, needsAction: 0, unread: 0 });
    report({ sender: { id: 11 } }, "not an object");
    expect(attention).toHaveLength(0);
    report({ sender: { id: 11 } }, { running: 1, needsAction: 0, unread: 2 });
    expect(attention.at(-1)).toEqual({ running: 1, needsAction: 0, unread: 2 });
  });

  test("docked or closed Mimi falls back to the full page with the draft", async () => {
    const { host, overviews } = setup();
    await host.open("chat", undefined, "看看「备忘录」");
    expect(overviews).toEqual([{ prompt: "看看「备忘录」" }]);
  });

  test("only the bubble's own renderer can report its interactive content", async () => {
    const { host, listeners, ignoredMouseEvents } = setup();
    await host.surface.prepare();
    host.surface.setExpanded(false);
    await host.open("activity");
    host.surface.setExpanded(true);
    const report = listeners.get("pet:bubble-interactive")!;
    const initialReports = ignoredMouseEvents.length;
    report({ sender: { id: 99 } }, true);
    report({ sender: { id: 11 } }, "true");
    report({ sender: { id: 11 } }, 1);
    expect(ignoredMouseEvents).toHaveLength(initialReports);
    expect(ignoredMouseEvents.at(-1)).toBe(true);
    report({ sender: { id: 11 } }, true);
    expect(ignoredMouseEvents.at(-1)).toBe(false);
    report({ sender: { id: 11 } }, false);
    expect(ignoredMouseEvents.at(-1)).toBe(true);
    host.surface.release();
    const releasedReports = ignoredMouseEvents.length;
    report({ sender: { id: 11 } }, true);
    expect(ignoredMouseEvents).toHaveLength(releasedReports);
  });

  test("a bubble that cannot load falls back to the full page", async () => {
    const { host, snapshot, overviews } = setup({ failLoad: true });
    host.sync(snapshot({}));
    await tick();
    await host.open("chat");
    expect(overviews).toEqual([undefined]);
  });
});
