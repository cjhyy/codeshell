/** Executed only in a dedicated child process by mimi-companion-host.test.ts. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const app = Object.assign(new EventEmitter(), { getAppMetrics: () => [] as { pid: number }[] });
const screen = Object.assign(new EventEmitter(), {
  getCursorScreenPoint: () => ({ x: 500, y: 500 }),
  getDisplayNearestPoint: () => display,
  getAllDisplays: () => [display],
});
const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1050 },
};
const handlers = new Map<string, (...args: any[]) => any>();
const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel: string, handler: (...args: any[]) => any) {
    assert(!handlers.has(channel), `duplicate handler: ${channel}`);
    handlers.set(channel, handler);
  },
  removeHandler(channel: string) {
    handlers.delete(channel);
  },
});

class FakeContents extends EventEmitter {
  mainFrame = {};
  messages: Array<{ channel: string; value: any }> = [];
  constructor(readonly owner?: FakeWindow) {
    super();
  }
  isDestroyed() {
    return this.owner?.destroyed ?? false;
  }
  send(channel: string, value: any) {
    this.messages.push({ channel, value });
  }
  setWindowOpenHandler() {}
}

const windows: FakeWindow[] = [];
class FakeWindow extends EventEmitter {
  static getFocusedWindow() {
    return undefined;
  }
  destroyed = false;
  visible = false;
  shows = 0;
  bounds = { ...display.bounds };
  webContents = new FakeContents(this);
  resolveLoad!: () => void;
  rejectLoad!: (failure: Error) => void;
  constructor(_options: unknown) {
    super();
    windows.push(this);
  }
  loadURL() {
    return new Promise<void>((resolve, reject) => {
      this.resolveLoad = resolve;
      this.rejectLoad = reject;
    });
  }
  loadFile() {
    return this.loadURL();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible && !this.destroyed;
  }
  showInactive() {
    assert(!this.destroyed, "a destroyed window must never show");
    this.visible = true;
    this.shows++;
  }
  hide() {
    this.visible = false;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }
  getContentBounds() {
    return { ...this.bounds };
  }
  setBounds(value: typeof display.bounds) {
    this.bounds = { ...value };
  }
  ignoredMouseEvents: Array<{ ignore: boolean; options?: { forward: boolean } }> = [];
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }) {
    this.ignoredMouseEvents.push({ ignore, ...(options ? { options } : {}) });
  }
  setFocusable() {}
  setAlwaysOnTop() {}
  moveTop() {}
  workspaces: unknown[] = [];
  setVisibleOnAllWorkspaces(...args: unknown[]) {
    this.workspaces.push(args);
  }
  setHiddenInMissionControl() {}
}

const isolated = {
  setPermissionRequestHandler() {},
  webRequest: { onHeadersReceived() {} },
  protocol: {
    isProtocolHandled: async () => true,
    handle() {},
  },
};
mock.module("electron", () => ({
  app,
  BrowserWindow: FakeWindow,
  ipcMain,
  screen,
  session: { fromPartition: () => isolated },
}));

// The window under the character's feet; set per scenario.
let windowUnderFeet: { pid: number; app: string } | undefined;
mock.module("./window-at-point", () => ({
  windowAtPoint: async () =>
    windowUnderFeet && { ...windowUnderFeet, frame: { x: 0, y: 0, width: 800, height: 600 } },
}));

// Electron and the window query are mocked: choreography, geometry and the
// capture queue are real.
const { createMimiCompanionHost } = await import("./mimi-companion-host");
const { ComputerActivityBus } = await import("./computer-activity-bus");
const bus = new ComputerActivityBus();
let busSubscriptions = 0;
const originalSubscribe = bus.subscribe.bind(bus);
bus.subscribe = (listener) => {
  busSubscriptions++;
  const unsubscribe = originalSubscribe(listener);
  return () => {
    busSubscriptions--;
    unsubscribe();
  };
};
const gateListeners = new Set<() => void>();
const gate = {
  status: () => ({ stopped: false, foregroundHeld: false }),
  subscribe(listener: () => void) {
    gateListeners.add(listener);
    return () => gateListeners.delete(listener);
  },
  holdForegroundForChat() {},
  releaseForegroundForChat() {},
  stopAll() {},
  resume() {},
};
const captureChanges: boolean[] = [];
type Rect = { x: number; y: number; width: number; height: number };
const chatCalls: Array<Rect | undefined> = [];
const activityCalls: Array<Rect | undefined> = [];
const moves: Rect[] = [];
const requests: unknown[] = [];
const host = await createMimiCompanionHost({
  appPath: "/fixture-app",
  isMainWindow: () => false,
  presence: {
    onCaptureChange(value) {
      captureChanges.push(value);
      return false;
    },
    request: (patch) => requests.push(patch),
  },
  openChat: async (_request, near) => {
    chatCalls.push(near);
  },
  openActivity: async (near) => {
    activityCalls.push(near);
  },
  onMoved: (near) => moves.push(near),
  bus,
  gate: gate as any,
  log() {},
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const event = (win: FakeWindow) => ({
  sender: win.webContents,
  senderFrame: win.webContents.mainFrame,
});
const latestState = (win: FakeWindow) =>
  win.webContents.messages.filter((message) => message.channel === "mimiCompanion:state").at(-1)
    ?.value;
async function newWindow(index: number) {
  for (let retry = 0; retry < 30 && !windows[index]; retry++) await tick();
  assert(windows[index], "presentation should create an actual host window");
  return windows[index]!;
}
async function present() {
  const index = windows.length;
  const pending = host.present();
  const win = await newWindow(index);
  win.resolveLoad();
  ipcMain.emit("mimiCompanion:ready", event(win));
  await pending;
  assert(host.isVisible(), "ready host should present");
  return win;
}

try {
  switch (process.argv[2]) {
    case "withdraw-and-late-ready": {
      const first = host.present();
      const old = await newWindow(0);
      host.withdraw();
      old.resolveLoad();
      ipcMain.emit("mimiCompanion:ready", event(old));
      await first;
      assert.equal(old.shows, 0);
      assert.equal(host.isVisible(), false);

      const second = host.present();
      const current = await newWindow(1);
      current.resolveLoad();
      ipcMain.emit("mimiCompanion:ready", event(old));
      ipcMain.emit("mimiCompanion:ready", {
        sender: current.webContents,
        senderFrame: {},
      });
      ipcMain.emit("mimiCompanion:ready", {
        sender: new FakeContents(),
        senderFrame: current.webContents.mainFrame,
      });
      await tick();
      assert.equal(current.shows, 0, "only the current window's main frame can signal ready");
      const readState = handlers.get("mimiCompanion:state")!;
      assert.throws(() => readState({ ...event(current), senderFrame: {} }), /Invalid/);
      assert.throws(() => readState(event(old)), /Invalid/);
      ipcMain.emit("mimiCompanion:ready", event(current));
      await second;
      assert.equal(host.isVisible(), true);
      assert.equal(readState(event(current)).visible, true);
      host.withdraw();
      ipcMain.emit("mimiCompanion:ready", event(current));
      assert.equal(current.visible, false, "late ready cannot resurrect withdrawn Mimi");
      break;
    }
    case "concurrent-load-failure": {
      const first = host.present();
      const win = await newWindow(0);
      const second = host.present();
      const results = Promise.allSettled([first, second]);
      win.rejectLoad(new Error("fixture failed to load"));
      const failures = await results;
      assert.deepEqual(
        failures.map((result) => result.status),
        ["rejected", "rejected"],
      );
      for (const failure of failures) {
        assert(failure.status === "rejected");
        assert.match(String(failure.reason), /未能加载/);
      }
      assert.equal(host.isVisible(), false);
      assert.equal(win.shows, 0);
      assert(win.destroyed);
      break;
    }
    case "close-cleans-listeners": {
      const win = await present();
      await host.startPreview();
      assert.equal(busSubscriptions, 1);
      assert.equal(gateListeners.size, 1);
      assert.equal(handlers.size, 5);
      assert.equal(ipcMain.eventNames().length, 8);
      assert.equal(screen.listenerCount("display-removed"), 1);
      assert.equal(app.listenerCount("browser-window-focus"), 1);
      await host.close();
      assert(win.destroyed);
      assert.equal(busSubscriptions, 0);
      assert.equal(gateListeners.size, 0);
      assert.equal(handlers.size, 0);
      assert.deepEqual(ipcMain.eventNames(), []);
      assert.deepEqual(screen.eventNames(), []);
      assert.deepEqual(app.eventNames(), []);
      ipcMain.emit("mimiCompanion:ready", event(win));
      screen.emit("display-removed");
      await bus.publish({ id: "after-close", phase: "start", action: "click" } as any);
      assert.equal(host.isVisible(), false);
      break;
    }
    case "chat-and-badge-beside-character": {
      const win = await present();
      const drawn = latestState(win);
      const origin = drawn.windowOrigin ?? { x: 0, y: 0 };
      // Clicking her hands the chat where she stands, so it opens beside her.
      await handlers.get("mimiCompanion:chat")!(event(win));
      assert.deepEqual(chatCalls.at(-1), {
        x: Math.round(origin.x + drawn.position.x),
        y: Math.round(origin.y + drawn.position.y),
        width: Math.round(drawn.size * 0.7),
        height: Math.round(drawn.size),
      });
      host.setAttention({ running: 1, needsAction: 2, unread: -3 } as any);
      assert.deepEqual(latestState(win).attention, { running: 1, needsAction: 2, unread: 0 });
      await handlers.get("mimiCompanion:activity")!(event(win));
      assert.equal(activityCalls.at(-1)?.width, Math.round(latestState(win).size * 0.7));
      await assert.rejects(
        async () =>
          handlers.get("mimiCompanion:activity")!({ sender: new FakeContents(), senderFrame: {} }),
        /Invalid/,
      );
      assert.equal(activityCalls.length, 1, "only her own overlay opens the work list");
      host.setAttention({ running: 0, needsAction: 0, unread: 0 });
      assert.equal(latestState(win).attention, undefined, "nothing to show hides the badge");
      break;
    }
    case "menu-resize-and-dock-reach-presence": {
      const win = await present();
      assert.equal(latestState(win).chosenSize, latestState(win).size);
      ipcMain.emit("mimiCompanion:resize", event(win), 320);
      ipcMain.emit("mimiCompanion:resize", event(win), 9_999);
      ipcMain.emit("mimiCompanion:resize", event(win), "big");
      ipcMain.emit("mimiCompanion:resize", { sender: new FakeContents(), senderFrame: {} }, 160);
      ipcMain.emit("mimiCompanion:presence", event(win), "dock");
      ipcMain.emit("mimiCompanion:presence", event(win), "close");
      assert.deepEqual(requests, [
        { size: 320 },
        { size: 480 },
        { mode: "docked" },
        { visible: false },
      ]);
      break;
    }
    case "handoff-only-across-apps": {
      const win = await present();
      const drag = async (point: { x: number; y: number }, dropOn: typeof windowUnderFeet) => {
        ipcMain.emit("mimiCompanion:interaction", event(win), "begin");
        await tick();
        windowUnderFeet = dropOn;
        ipcMain.emit("mimiCompanion:move", event(win), point);
        ipcMain.emit("mimiCompanion:interaction", event(win), "end");
        for (let i = 0; i < 5; i++) await tick();
      };
      windowUnderFeet = { pid: 500, app: "Notes" };
      await drag({ x: 300, y: 300 }, { pid: 500, app: "Notes" });
      assert.equal(latestState(win).handoff, undefined, "moving within one app offers nothing");
      // An open chat follows her: every drag step reports where she now stands.
      assert.deepEqual(moves.at(-1), {
        x: 300,
        y: 300,
        width: Math.round(latestState(win).size * 0.7),
        height: Math.round(latestState(win).size),
      });
      await drag({ x: 600, y: 300 }, { pid: 600, app: "Safari" });
      assert.deepEqual(
        latestState(win).handoff,
        { app: "Safari" },
        "dropping on another app offers it",
      );
      break;
    }
    case "drag-releases-native-mouse": {
      const win = await present();
      const clickThrough = { ignore: true, options: { forward: true } };
      assert.deepEqual(win.ignoredMouseEvents.at(-1), clickThrough);

      ipcMain.emit("mimiCompanion:interaction", event(win), "hover");
      assert.deepEqual(win.ignoredMouseEvents.at(-1), { ignore: false });
      ipcMain.emit("mimiCompanion:interaction", event(win), "begin");
      ipcMain.emit("mimiCompanion:move", event(win), { x: 300, y: 300 });
      // Leaving the body while captured must not drop an active drag.
      ipcMain.emit("mimiCompanion:interaction", event(win), "leave");
      assert.equal(latestState(win).humanActive, true);
      assert.deepEqual(win.ignoredMouseEvents.at(-1), { ignore: false });
      ipcMain.emit("mimiCompanion:move", event(win), { x: 400, y: 350 });
      assert.deepEqual(latestState(win).position, { x: 400, y: 350 });

      ipcMain.emit("mimiCompanion:interaction", event(win), "end");
      // A drop over the body keeps the pet clickable until renderer hit testing
      // explicitly reports the pointer outside, including lost-event recovery.
      assert.deepEqual(win.ignoredMouseEvents.at(-1), { ignore: false });
      ipcMain.emit("mimiCompanion:interaction", event(win), "leave");
      assert.equal(latestState(win).humanActive, false);
      assert.deepEqual(win.ignoredMouseEvents.at(-1), clickThrough);
      ipcMain.emit("mimiCompanion:move", event(win), { x: 800, y: 700 });
      assert.deepEqual(latestState(win).position, { x: 400, y: 350 });

      ipcMain.emit("mimiCompanion:interaction", event(win), "hover");
      assert.deepEqual(win.ignoredMouseEvents.at(-1), { ignore: false });
      ipcMain.emit("mimiCompanion:interaction", event(win), "leave");
      assert.deepEqual(win.ignoredMouseEvents.at(-1), clickThrough);
      break;
    }
    case "capture-while-human-active": {
      const win = await present();
      ipcMain.emit("mimiCompanion:interaction", event(win), "hover");
      assert.equal(latestState(win).humanActive, true);
      const capture = bus.publish({
        id: "capture-1",
        phase: "start",
        action: "observe",
        capture: true,
      } as any);
      await capture;
      assert.equal(latestState(win).humanActive, true);
      assert.equal(latestState(win).visible, false, "capture hides even a hovered Mimi");
      assert.equal(win.isVisible(), false);
      assert.equal(host.isVisible(), false);
      await bus.publish({ id: "capture-1", phase: "end", action: "observe" } as any);
      await tick();
      assert.equal(host.isVisible(), true, "current desired surface returns after capture");
      assert.deepEqual(captureChanges, [true, false]);
      break;
    }
    case "busy-preview-rejects": {
      const win = await present();
      await host.startPreview();
      assert.equal(latestState(win).preview, true);
      ipcMain.emit("mimiCompanion:interaction", event(win), "hover");
      await assert.rejects(host.startPreview(), /./);
      // A failed preview must cancel the previous preview before rejecting, so
      // the owner can restore its original mode without a stale expiry timer.
      host.setSize(200);
      assert.equal(latestState(win).preview, false);
      ipcMain.emit("mimiCompanion:interaction", event(win), "leave");
      await tick();
      assert.equal(latestState(win).preview, false);
      host.withdraw();
      await host.startPreview();
      assert.equal(host.isVisible(), false, "preview cannot resurrect withdrawn Mimi");
      break;
    }
    case "keeps-dock-icon": {
      // Joining fullscreen Spaces must not transform CodeShell into a UIElement
      // app (that removes its Dock icon while the moving form is shown).
      const win = await present();
      assert.deepEqual(win.workspaces, [
        [true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
      ]);
      break;
    }
    default:
      throw new Error(`Unknown scenario: ${process.argv[2]}`);
  }
} finally {
  await host.close();
}
console.log(`${process.argv[2]}: ok`);
