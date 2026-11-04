import { describe, expect, test } from "bun:test";
import {
  createPetBubbleSurface,
  PET_BUBBLE_SIZE,
  petBubbleOrigin,
  type PetBubbleWindowLike,
} from "./pet-bubble-surface";

type Bounds = { x: number; y: number; width: number; height: number };
type Listener = (...args: any[]) => void;

const workArea = { x: 0, y: 0, width: 1512, height: 944 };

class FakeWindow implements PetBubbleWindowLike {
  destroyed = false;
  visible = false;
  focused = false;
  protectedContent = false;
  sent: Array<{ channel: string; payload: unknown }> = [];
  listeners = new Map<string, Listener[]>();
  constructor(public bounds: Bounds) {}
  webContents = {
    id: 7,
    send: (channel: string, payload: unknown) => {
      this.sent.push({ channel, payload });
    },
    on: () => {},
  };
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible && !this.destroyed;
  }
  isFocused() {
    return this.focused && !this.destroyed;
  }
  setBounds(bounds: Bounds) {
    this.bounds = { ...bounds };
  }
  show() {
    this.visible = true;
  }
  showInactive() {
    this.visible = true;
  }
  focus() {
    this.focused = true;
  }
  hide() {
    this.visible = false;
    this.focused = false;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.listeners.get("closed") ?? []) listener();
  }
  levels: unknown[] = [];
  setAlwaysOnTop(_flag: boolean, level?: unknown) {
    this.levels.push(level);
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  setContentProtection(enable: boolean) {
    this.protectedContent = enable;
  }
  moveTop() {}
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
}

function setup() {
  const windows: FakeWindow[] = [];
  let released = 0;
  const surface = createPetBubbleSurface({
    platform: "darwin",
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
    },
    ready: async () => {},
    createWindow: (bounds) => {
      const win = new FakeWindow(bounds);
      windows.push(win);
      return win;
    },
    load: async () => {},
    onReleased: () => released++,
  });
  return { surface, windows, released: () => released };
}

const near = { x: 600, y: 300, width: 140, height: 200 };

describe("petBubbleOrigin", () => {
  test("opens to the character's right, tops aligned", () => {
    expect(petBubbleOrigin(near, workArea)).toEqual({ x: 744, y: 300 });
  });

  test("flips to her left near the right edge", () => {
    const origin = petBubbleOrigin({ ...near, x: 1300 }, workArea);
    expect(origin.x + PET_BUBBLE_SIZE.width).toBeLessThanOrEqual(1300);
  });

  test("stays inside the work area at the bottom", () => {
    const origin = petBubbleOrigin({ ...near, y: 900 }, workArea);
    expect(origin.y + PET_BUBBLE_SIZE.height).toBeLessThanOrEqual(workArea.height);
  });

  test("without a character it takes the docked widget's corner", () => {
    const origin = petBubbleOrigin(undefined, workArea);
    expect(origin.x + PET_BUBBLE_SIZE.width).toBeLessThanOrEqual(workArea.width);
    expect(origin.y + PET_BUBBLE_SIZE.height).toBeLessThanOrEqual(workArea.height);
    expect(origin.x).toBeGreaterThan(workArea.width / 2);
  });
});

describe("createPetBubbleSurface", () => {
  test("prepare loads a hidden, capture-protected window", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    expect(windows).toHaveLength(1);
    expect(windows[0].isVisible()).toBe(false);
    expect(windows[0].protectedContent).toBe(true);
    expect(surface.active()).toBe(true);
  });

  test("chat opens beside her and takes focus once the renderer expands", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    surface.setExpanded(false); // renderer mounted with no panel
    await surface.open("chat", near, "看看这个");
    const win = windows[0];
    expect(win.bounds).toMatchObject({ x: 744, y: 300, ...PET_BUBBLE_SIZE });
    expect(win.sent.at(-1)).toEqual({
      channel: "pet:bubble-open",
      payload: { panel: "chat", prompt: "看看这个" },
    });
    expect(win.isVisible()).toBe(false);
    surface.setExpanded(true);
    expect(win.isVisible()).toBe(true);
    expect(win.focused).toBe(true);
    // Typing: the input method's candidate window must stay above the bubble.
    expect(win.levels.at(-1)).toBe("floating");
    win.focused = false;
    win.emit("blur");
    expect(win.levels.at(-1)).toBe("screen-saver");
  });

  test("an accepted request is forwarded to be sent, a plain prompt is not", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    surface.setExpanded(false);
    await surface.open("chat", near, "看看这个窗口", true);
    expect(windows[0].sent.at(-1)?.payload).toEqual({
      panel: "chat",
      prompt: "看看这个窗口",
      send: true,
    });
    await surface.open("chat", near, "草稿");
    expect(windows[0].sent.at(-1)?.payload).toEqual({ panel: "chat", prompt: "草稿" });
  });

  test("an open bubble follows the dragged character; a hidden one stays put", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    surface.setExpanded(false);
    const hiddenBounds = { ...windows[0].bounds };
    surface.follow({ x: 100, y: 200, width: 112, height: 160 });
    expect(windows[0].bounds).toEqual(hiddenBounds);
    await surface.open("chat", near);
    surface.setExpanded(true);
    surface.follow({ x: 100, y: 200, width: 112, height: 160 });
    expect(windows[0].bounds).toMatchObject({ x: 216, y: 200, ...PET_BUBBLE_SIZE });
  });

  test("the work list shows without stealing focus", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    surface.setExpanded(false);
    await surface.open("activity", near);
    surface.setExpanded(true);
    expect(windows[0].isVisible()).toBe(true);
    expect(windows[0].focused).toBe(false);
  });

  test("a renderer mounting late still receives the first request", async () => {
    const { surface, windows } = setup();
    let opened = false;
    const opening = surface.open("chat", near).then(() => (opened = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(false);
    expect(windows[0].sent).toHaveLength(0);
    surface.setExpanded(false); // mount report
    await opening;
    expect(windows[0].sent.at(-1)?.payload).toEqual({ panel: "chat" });
    surface.setExpanded(true);
    expect(windows[0].isVisible()).toBe(true);
  });

  test("clicking her again closes the open chat", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    surface.setExpanded(false);
    await surface.open("chat", near);
    surface.setExpanded(true);
    await surface.open("chat", near);
    expect(windows[0].isVisible()).toBe(false);
    expect(windows[0].sent.at(-1)?.payload).toEqual({ panel: null });
    // The renderer's own close report does not reopen it.
    surface.setExpanded(true);
    expect(windows[0].isVisible()).toBe(false);
  });

  test("closing from the bubble hides it; the next click reopens", async () => {
    const { surface, windows } = setup();
    await surface.prepare();
    surface.setExpanded(false);
    await surface.open("chat", near);
    surface.setExpanded(true);
    surface.setExpanded(false); // × or Esc in the bubble
    expect(windows[0].isVisible()).toBe(false);
    await surface.open("chat", near);
    surface.setExpanded(true);
    expect(windows[0].isVisible()).toBe(true);
  });

  test("release destroys the window and reports once", async () => {
    const { surface, windows, released } = setup();
    await surface.prepare();
    surface.release();
    expect(windows[0].isDestroyed()).toBe(true);
    expect(surface.active()).toBe(false);
    expect(surface.window()).toBeNull();
    expect(released()).toBe(1);
    surface.release();
    expect(released()).toBe(1);
  });

  test("a release during loading discards the half-made window", async () => {
    const windows: FakeWindow[] = [];
    let finishLoad: () => void = () => {};
    const surface = createPetBubbleSurface({
      platform: "darwin",
      screen: {
        getDisplayNearestPoint: () => ({ workArea }),
        getPrimaryDisplay: () => ({ workArea }),
      },
      ready: async () => {},
      createWindow: (bounds) => {
        const win = new FakeWindow(bounds);
        windows.push(win);
        return win;
      },
      load: () => new Promise<void>((resolve) => (finishLoad = resolve)),
    });
    const preparing = surface.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));
    surface.release();
    finishLoad();
    await expect(preparing).rejects.toThrow();
    expect(windows[0].isDestroyed()).toBe(true);
    expect(surface.window()).toBeNull();
  });

  test("owns only its own renderer", async () => {
    const { surface } = setup();
    expect(surface.owns(7)).toBe(false);
    await surface.prepare();
    expect(surface.owns(7)).toBe(true);
    expect(surface.owns(8)).toBe(false);
  });
});
