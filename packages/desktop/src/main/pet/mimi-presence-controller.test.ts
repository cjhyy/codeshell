import { describe, expect, test } from "bun:test";
import {
  MimiPresenceController,
  type MimiDockedSurface,
  type MimiMovingSurface,
} from "./mimi-presence-controller";
import {
  defaultMimiPresenceState,
  type MimiPresenceState,
  type Point,
} from "./mimi-presence-state";
import type { MimiPresenceMode, MimiPresenceSnapshot } from "../../shared/mimi-presence";

type Deferred = { resolve(): void; reject(error: Error): void };

/** Shared world: records events and checks "never both visible" at every show. */
class World {
  events: string[] = [];
  violations: string[][] = [];
  surfaces: FakeSurface[] = [];
  check(): void {
    const visible = this.surfaces.filter((surface) => surface.visible);
    if (visible.length > 1) this.violations.push([...this.events]);
  }
  visibleMode(): MimiPresenceMode | null {
    return this.surfaces.find((surface) => surface.visible)?.name ?? null;
  }
}

/**
 * Follows the surface contract the real docked/moving surfaces implement:
 * `present` marks synchronously, `withdraw` unmarks and hides synchronously,
 * and the window is only ever shown while marked (also for late load signals).
 */
class FakeSurface implements MimiDockedSurface, MimiMovingSurface {
  presenting = false;
  visible = false;
  loaded = false;
  captureHidden = false;
  pending: Deferred[] = [];
  feetPoint: Point | undefined;
  placed: Point[] = [];
  sizes: number[] = [];
  appearances: string[] = [];
  previews = 0;
  cancels = 0;
  constructor(
    readonly name: MimiPresenceMode,
    private readonly world: World,
    /** Docked creation rejects when withdrawn; moving's present returns early. */
    private readonly rejectOnWithdraw: boolean,
  ) {
    world.surfaces.push(this);
  }
  present(isCurrent: () => boolean): Promise<void> {
    this.world.events.push(`${this.name}:present`);
    this.presenting = true;
    if (this.loaded) {
      this.sync();
      return Promise.resolve();
    }
    let deferred!: Deferred;
    const promise = new Promise<void>((resolve, reject) => {
      deferred = { resolve, reject };
    });
    this.pending.push(deferred);
    return promise.then(() => {
      if (!this.presenting || !isCurrent()) return;
      this.loaded = true;
      this.sync();
    });
  }
  /** Complete the oldest (or `index`) outstanding load. */
  finishLoad(index = 0, error?: string): boolean {
    const deferred = this.pending.splice(index, 1)[0];
    if (!deferred) return false;
    if (error) deferred.reject(new Error(error));
    else deferred.resolve();
    return true;
  }
  /** A renderer ready/did-finish-load signal arriving at an arbitrary time. */
  lateReady(): void {
    if (!this.presenting) return;
    this.loaded = true;
    this.sync();
  }
  withdraw(): void {
    this.world.events.push(`${this.name}:withdraw`);
    this.presenting = false;
    this.loaded = false;
    this.hide();
    const pending = this.pending.splice(0);
    for (const deferred of pending) {
      if (this.rejectOnWithdraw) deferred.reject(new Error("withdrawn"));
      else deferred.resolve();
    }
  }
  isVisible(): boolean {
    return this.visible;
  }
  feet(): Point | undefined {
    return this.feetPoint;
  }
  placeFeet(feet: Point): void {
    this.placed.push(feet);
    this.feetPoint = feet;
  }
  setCaptureHidden(hidden: boolean): boolean {
    const was = this.visible;
    this.captureHidden = hidden;
    this.sync();
    return hidden && was;
  }
  setSize(size: number): void {
    this.sizes.push(size);
  }
  setAppearance(appearance: string): void {
    this.appearances.push(appearance);
  }
  async startPreview(isCurrent: () => boolean): Promise<void> {
    if (isCurrent()) this.previews++;
  }
  cancelPreview(): void {
    this.cancels++;
  }
  private sync(): void {
    if (this.presenting && this.loaded && !this.captureHidden) this.show();
    else this.hide();
  }
  private show(): void {
    if (this.visible) return;
    this.visible = true;
    this.world.events.push(`${this.name}:shown`);
    this.world.check();
  }
  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.world.events.push(`${this.name}:hidden`);
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
  initial: Partial<MimiPresenceState> = {},
  options: { moving?: boolean; unavailableReason?: string } = {},
) {
  const world = new World();
  const docked = new FakeSurface("docked", world, true);
  const moving = new FakeSurface("moving", world, false);
  const saves: MimiPresenceState[] = [];
  const changes: MimiPresenceSnapshot[] = [];
  const controller = new MimiPresenceController({
    initial: { ...defaultMimiPresenceState(), ...initial },
    docked,
    save: async (state) => {
      saves.push(state);
    },
    onChange: (snapshot) => changes.push(snapshot),
  });
  const start = () =>
    controller.start(
      options.moving === false
        ? { unavailableReason: options.unavailableReason }
        : { surface: moving },
    );
  return { world, docked, moving, saves, changes, controller, start };
}

describe("MimiPresenceController — one Mimi, never two", () => {
  test("nothing is shown before start, even when the saved state is visible", async () => {
    const h = setup({ visible: true, mode: "moving" });
    await h.controller.set({ size: 240 });
    await flush();
    expect(h.world.visibleMode()).toBeNull();
    expect(h.docked.presenting || h.moving.presenting).toBe(false);
    void h.start();
    expect(h.docked.presenting).toBe(false);
    expect(h.moving.presenting).toBe(true);
    h.moving.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("moving");
    expect(h.controller.snapshot().shown).toBe("moving");
    expect(h.world.violations).toEqual([]);
  });

  test("hide before show: switching modes withdraws the old form before presenting the new one", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    h.world.events = [];
    void h.controller.set({ mode: "moving" });
    expect(h.world.events.slice(0, 3)).toEqual([
      "docked:withdraw",
      "docked:hidden",
      "moving:present",
    ]);
    expect(h.world.visibleMode()).toBeNull();
    h.moving.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("moving");
    h.world.events = [];
    void h.controller.set({ mode: "docked" });
    expect(h.world.events.slice(0, 3)).toEqual([
      "moving:withdraw",
      "moving:hidden",
      "docked:present",
    ]);
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    expect(h.world.violations).toEqual([]);
  });

  test("a stale load that finishes after a newer request never shows its window", async () => {
    const h = setup({ visible: true });
    void h.start();
    // Docked is still loading when the user switches to moving.
    void h.controller.set({ mode: "moving" });
    h.moving.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("moving");
    // Late renderer signal from the withdrawn docked window.
    h.docked.lateReady();
    expect(h.docked.visible).toBe(false);
    // Moving is withdrawn mid-load; its old load resolves after docked came back.
    void h.controller.set({ mode: "docked" });
    void h.controller.set({ mode: "moving" });
    void h.controller.set({ mode: "docked" });
    h.docked.finishLoad();
    await flush();
    h.moving.lateReady();
    while (h.moving.finishLoad()) await flush();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    expect(h.moving.visible).toBe(false);
    expect(h.world.violations).toEqual([]);
  });

  test("seeded interleavings: never both visible at any step, and the last request wins", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const h = setup({ visible: false });
      void h.start();
      let random = seed * 7919;
      const next = (n: number) => {
        random = (random * 48271) % 2147483647;
        return random % n;
      };
      let last: { visible: boolean; mode: MimiPresenceMode } = { visible: false, mode: "docked" };
      for (let step = 0; step < 60; step++) {
        switch (next(8)) {
          case 0:
            last = { ...last, visible: true };
            void h.controller.set({ visible: true });
            break;
          case 1:
            last = { ...last, visible: false };
            void h.controller.set({ visible: false });
            break;
          case 2:
            last = { ...last, mode: "moving" };
            void h.controller.set({ mode: "moving" });
            break;
          case 3:
            last = { ...last, mode: "docked" };
            void h.controller.set({ mode: "docked" });
            break;
          case 4:
            h.docked.finishLoad(next(Math.max(1, h.docked.pending.length)));
            break;
          case 5:
            h.moving.finishLoad(next(Math.max(1, h.moving.pending.length)));
            break;
          case 6:
            h.docked.lateReady();
            h.moving.lateReady();
            break;
          default:
            await flush();
        }
        h.world.check();
        expect(h.world.violations).toEqual([]);
      }
      // Settle every outstanding load in arbitrary order.
      while (h.docked.pending.length || h.moving.pending.length) {
        if (h.moving.pending.length) h.moving.finishLoad(h.moving.pending.length - 1);
        if (h.docked.pending.length) h.docked.finishLoad(0);
        await flush();
        h.world.check();
      }
      await flush();
      const expected = last.visible ? last.mode : null;
      expect(h.world.visibleMode()).toBe(expected);
      expect(h.controller.snapshot().shown).toBe(expected);
      expect(h.controller.snapshot()).toMatchObject(last);
      expect(h.world.violations).toEqual([]);
    }
  });

  test("closing hides whichever form is shown and the next launch state is hidden", async () => {
    const h = setup({ visible: true, mode: "moving" });
    void h.start();
    h.moving.finishLoad();
    await flush();
    await h.controller.set({ visible: false });
    expect(h.world.visibleMode()).toBeNull();
    expect(h.saves.at(-1)).toMatchObject({ visible: false, mode: "moving" });
    expect(h.changes.at(-1)).toMatchObject({ visible: false, shown: null });
  });

  test("broadcast reflects the actual presented form, not the request", async () => {
    const h = setup({ visible: false });
    void h.start();
    void h.controller.set({ visible: true });
    expect(h.changes.at(-1)).toMatchObject({ visible: true, shown: null });
    h.docked.finishLoad();
    await flush();
    expect(h.changes.at(-1)).toMatchObject({ visible: true, shown: "docked" });
  });
});

describe("MimiPresenceController — preview", () => {
  test("preview from docked replaces docked, then returns to docked", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    const preview = h.controller.preview();
    expect(h.docked.visible).toBe(false);
    h.moving.finishLoad();
    await preview;
    expect(h.world.visibleMode()).toBe("moving");
    expect(h.moving.previews).toBe(1);
    expect(h.controller.snapshot().previewing).toBe(true);
    h.controller.previewEnded();
    expect(h.moving.visible).toBe(false);
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    expect(h.world.violations).toEqual([]);
  });

  test("a busy preview releases previewing and restores the user's form", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    h.moving.startPreview = async () => {
      throw new Error("busy");
    };
    const preview = h.controller.preview().catch((error: Error) => error);
    h.moving.finishLoad();
    await flush();
    h.docked.finishLoad();
    expect(await preview).toMatchObject({ message: "busy" });
    expect(h.controller.snapshot().previewing).toBe(false);
    expect(h.world.visibleMode()).toBe("docked");
    expect(h.world.violations).toEqual([]);
  });

  test("closing Mimi cancels the preview; a stale preview timer cannot re-show it", async () => {
    const h = setup({ visible: false });
    void h.start();
    const preview = h.controller.preview();
    h.moving.finishLoad();
    await preview;
    expect(h.world.visibleMode()).toBe("moving");
    await h.controller.set({ visible: false });
    expect(h.moving.cancels).toBe(1);
    expect(h.world.visibleMode()).toBeNull();
    // The preview's own expiry fires later.
    h.controller.previewEnded();
    await flush();
    h.moving.lateReady();
    expect(h.world.visibleMode()).toBeNull();
  });

  test("closing while the preview's window is still loading: the old load never shows it", async () => {
    const h = setup({ visible: false });
    void h.start();
    const preview = h.controller.preview();
    await h.controller.set({ visible: false });
    h.moving.finishLoad();
    await preview;
    await flush();
    h.moving.lateReady();
    expect(h.world.visibleMode()).toBeNull();
    expect(h.moving.previews).toBe(0);
    expect(h.controller.snapshot().previewing).toBe(false);
  });

  test("preview is refused, not shown beside docked, when moving is unavailable", async () => {
    const h = setup({ visible: true }, { moving: false, unavailableReason: "仅支持 macOS" });
    void h.start();
    h.docked.finishLoad();
    await flush();
    await expect(h.controller.preview()).rejects.toThrow("仅支持 macOS");
    expect(h.world.visibleMode()).toBe("docked");
  });

  test("a failed preview load reports the error and restores the previous form", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    const preview = h.controller.preview();
    h.moving.finishLoad(0, "角色显示未能加载");
    await expect(preview).rejects.toThrow("角色显示未能加载");
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    expect(h.controller.snapshot().previewing).toBe(false);
  });
});

describe("MimiPresenceController — availability and failure", () => {
  test("moving preference is kept while the effective form is docked when unavailable", async () => {
    const h = setup(
      { visible: true, mode: "moving" },
      { moving: false, unavailableReason: "仅支持 macOS" },
    );
    void h.start();
    h.docked.finishLoad();
    await flush();
    expect(h.controller.snapshot()).toMatchObject({
      mode: "moving",
      effectiveMode: "docked",
      shown: "docked",
      movingAvailable: false,
      movingUnavailableReason: "仅支持 macOS",
    });
    // Changing something else persists the moving preference unchanged.
    await h.controller.set({ size: 240 });
    expect(h.saves.at(-1)).toMatchObject({ mode: "moving", size: 240 });
    expect(h.world.visibleMode()).toBe("docked");
  });

  test("a moving load failure falls back to docked after hiding moving; retry restores moving", async () => {
    const h = setup({ visible: true, mode: "moving" });
    void h.start();
    h.moving.finishLoad(0, "角色尚未准备好");
    await flush();
    expect(h.moving.visible).toBe(false);
    expect(h.docked.presenting).toBe(true);
    h.docked.finishLoad();
    await flush();
    expect(h.controller.snapshot()).toMatchObject({
      mode: "moving",
      effectiveMode: "docked",
      shown: "docked",
      movingError: "角色尚未准备好",
    });
    void h.controller.retry();
    expect(h.docked.visible).toBe(false);
    h.moving.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("moving");
    expect(h.controller.snapshot().movingError).toBeUndefined();
    expect(h.world.violations).toEqual([]);
  });

  test("a runtime crash of moving withdraws it before docked appears", async () => {
    const h = setup({ visible: true, mode: "moving" });
    void h.start();
    h.moving.finishLoad();
    await flush();
    h.world.events = [];
    h.controller.surfaceFailed("moving", new Error("角色显示进程已退出"));
    expect(h.world.events.indexOf("moving:withdraw")).toBeLessThan(
      h.world.events.indexOf("docked:present"),
    );
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    // Asking for moving again is a retry.
    void h.controller.set({ mode: "moving" });
    h.moving.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("moving");
  });

  test("a docked failure stays hidden with an error until the user asks again", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad(0, "load failed");
    await flush();
    expect(h.world.visibleMode()).toBeNull();
    expect(h.controller.snapshot()).toMatchObject({ visible: true, dockedError: "load failed" });
    void h.controller.set({ visible: true });
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    expect(h.controller.snapshot().dockedError).toBeUndefined();
  });
});

describe("MimiPresenceController — capture, position, size, persistence", () => {
  test("a capture hides docked Mimi and restores it only if it is still wanted", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    expect(h.controller.setCaptureActive(true)).toBe(true);
    expect(h.docked.visible).toBe(false);
    expect(h.controller.setCaptureActive(false)).toBe(false);
    expect(h.docked.visible).toBe(true);
    // Capture starts, the user closes Mimi, capture ends: no resurrection.
    h.controller.setCaptureActive(true);
    await h.controller.set({ visible: false });
    h.controller.setCaptureActive(false);
    expect(h.world.visibleMode()).toBeNull();
    // Capture starts, the user switches to moving, capture ends: docked stays hidden.
    void h.controller.set({ visible: true });
    h.docked.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("docked");
    h.controller.setCaptureActive(true);
    void h.controller.set({ mode: "moving" });
    h.controller.setCaptureActive(false);
    expect(h.docked.visible).toBe(false);
    h.moving.finishLoad();
    await flush();
    expect(h.world.visibleMode()).toBe("moving");
    expect(h.world.violations).toEqual([]);
  });

  test("switching forms keeps Mimi standing at the same feet position", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    h.docked.feetPoint = { x: 1500, y: 900 };
    void h.controller.set({ mode: "moving" });
    expect(h.moving.placed.at(-1)).toEqual({ x: 1500, y: 900 });
    h.moving.finishLoad();
    await flush();
    h.moving.feetPoint = { x: 300, y: 400 };
    void h.controller.set({ mode: "docked" });
    expect(h.docked.placed.at(-1)).toEqual({ x: 300, y: 400 });
  });

  test("size is clamped to 160–480, forwarded to the moving surface and persisted", async () => {
    const h = setup();
    void h.start();
    await h.controller.set({ size: 999 });
    expect(h.controller.snapshot().size).toBe(480);
    await h.controller.set({ size: 10 });
    expect(h.controller.snapshot().size).toBe(160);
    expect(h.moving.sizes).toEqual([200, 480, 160]);
    expect(h.saves.at(-1)?.size).toBe(160);
  });

  test("the character is forwarded to the moving surface and persisted", async () => {
    const h = setup();
    void h.start();
    expect(h.controller.snapshot().appearance).toBe("mimi-sprite");
    await h.controller.set({ appearance: "shiro-sprite" });
    expect(h.controller.snapshot().appearance).toBe("shiro-sprite");
    expect(h.moving.appearances).toEqual(["mimi-sprite", "shiro-sprite"]);
    expect(h.saves.at(-1)?.appearance).toBe("shiro-sprite");
  });

  test("anchors are remembered per form and persisted in order", async () => {
    const h = setup();
    h.controller.rememberAnchor("docked", { x: 10.4, y: 20.6 });
    h.controller.rememberAnchor("moving", { x: 30, y: 40 });
    h.controller.rememberAnchor("moving", undefined);
    expect(h.controller.anchor("docked")).toEqual({ x: 10, y: 21 });
    expect(h.controller.anchor("moving")).toBeUndefined();
    expect(h.saves.map((state) => [state.dockedAnchor, state.movingAnchor])).toEqual([
      [{ x: 10, y: 21 }, undefined],
      [
        { x: 10, y: 21 },
        { x: 30, y: 40 },
      ],
      [{ x: 10, y: 21 }, undefined],
    ]);
  });

  test("dispose withdraws both forms and saves; later requests are ignored", async () => {
    const h = setup({ visible: true });
    void h.start();
    h.docked.finishLoad();
    await flush();
    await h.controller.dispose();
    expect(h.world.visibleMode()).toBeNull();
    expect(await h.controller.set({ visible: true })).toBe(false);
    h.docked.lateReady();
    expect(h.world.visibleMode()).toBeNull();
    expect(h.saves.at(-1)).toMatchObject({ visible: true });
  });
});
