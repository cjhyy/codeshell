import { describe, expect, test } from "bun:test";
import {
  effectiveMimiVisible,
  legacyCompanionSettings,
  parseMimiPresencePatch,
  registerMimiPresenceIpc,
  type MimiPresenceOwner,
} from "./mimi-presence-ipc";
import type { MimiPresencePatch, MimiPresenceSnapshot } from "../../shared/mimi-presence";

function owner(initial: Partial<MimiPresenceSnapshot> = {}) {
  let snapshot: MimiPresenceSnapshot = {
    visible: false,
    mode: "docked",
    size: 200,
    effectiveMode: "docked",
    shown: null,
    movingAvailable: true,
    previewing: false,
    ...initial,
  };
  const calls: Array<MimiPresencePatch | "preview" | "retry"> = [];
  const value: MimiPresenceOwner = {
    snapshot: () => snapshot,
    set: async (patch) => {
      calls.push(patch);
      snapshot = { ...snapshot, ...patch };
      return true;
    },
    preview: async () => {
      calls.push("preview");
    },
    retry: async () => {
      calls.push("retry");
      return true;
    },
  };
  return { value, calls };
}

function harness(initial: Partial<MimiPresenceSnapshot> = {}) {
  const handlers = new Map<string, (event: any, payload?: unknown) => unknown>();
  const presence = owner(initial);
  const main = { id: 1, isDestroyed: () => false, mainFrame: {} };
  const widget = { id: 2, isDestroyed: () => false, mainFrame: {} };
  const panel = { id: 3, isDestroyed: () => false, mainFrame: {} };
  registerMimiPresenceIpc({
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any,
    owner: presence.value,
    isMainWindow: (sender) => sender === (main as any),
    isDockedSurface: (sender) => sender === (widget as any),
  });
  const event = (sender: typeof main, frame: unknown = sender.mainFrame) => ({
    sender,
    senderFrame: frame,
  });
  const invoke = (channel: string, sender: typeof main, payload?: unknown, frame?: unknown) =>
    Promise.resolve().then(() =>
      handlers.get(channel)!(event(sender, frame ?? sender.mainFrame), payload),
    );
  return { handlers, presence, main, widget, panel, invoke };
}

describe("presence IPC sender validation", () => {
  test("only a main window main frame may change, preview or retry presence", async () => {
    const h = harness();
    for (const [channel, payload] of [
      ["mimi:presence-set", { visible: true }],
      ["mimi:presence-preview", undefined],
      ["mimi:presence-retry", undefined],
    ] as const) {
      await expect(h.invoke(channel, h.widget, payload)).rejects.toThrow("主窗口");
      await expect(h.invoke(channel, h.panel, payload)).rejects.toThrow("主窗口");
      await expect(h.invoke(channel, h.main, payload, { child: true })).rejects.toThrow("主窗口");
    }
    expect(h.presence.calls).toEqual([]);
    expect(
      await h.invoke("mimi:presence-set", h.main, { visible: true, mode: "moving" }),
    ).toMatchObject({ visible: true, mode: "moving" });
    await h.invoke("mimi:presence-preview", h.main);
    await h.invoke("mimi:presence-retry", h.main);
    expect(h.presence.calls).toEqual([{ visible: true, mode: "moving" }, "preview", "retry"]);
  });

  test("the docked widget may read state and close itself, but not show Mimi", async () => {
    const h = harness({ visible: true, shown: "docked" });
    expect(await h.invoke("mimi:presence-get", h.widget)).toMatchObject({ visible: true });
    expect(await h.invoke("pet:widget-visible-get", h.widget)).toBe(true);
    await expect(h.invoke("pet:widget-visible", h.widget, true)).rejects.toThrow();
    expect(await h.invoke("pet:widget-visible", h.widget, false)).toEqual({ ok: true });
    expect(h.presence.calls).toEqual([{ visible: false }]);
  });

  test("unknown or destroyed senders cannot read or toggle", async () => {
    const h = harness();
    await expect(h.invoke("mimi:presence-get", h.panel)).rejects.toThrow();
    await expect(h.invoke("pet:widget-visible", h.panel, true)).rejects.toThrow();
    const destroyed = { ...h.main, isDestroyed: () => true };
    await expect(h.invoke("mimi:presence-get", destroyed)).rejects.toThrow();
    expect(h.presence.calls).toEqual([]);
  });

  test("legacy pet:widget-visible from the main window maps onto the single owner", async () => {
    const h = harness();
    await expect(h.invoke("pet:widget-visible", h.main, "yes")).rejects.toThrow("boolean");
    expect(await h.invoke("pet:widget-visible", h.main, true)).toEqual({ ok: true });
    expect(h.presence.calls).toEqual([{ visible: true }]);
  });
});

describe("presence patch validation", () => {
  test("accepts only visible/mode/size within range", () => {
    expect(parseMimiPresencePatch({ visible: true })).toEqual({ visible: true });
    expect(parseMimiPresencePatch({ mode: "moving", size: 160 })).toEqual({
      mode: "moving",
      size: 160,
    });
    for (const invalid of [
      null,
      [],
      {},
      { visible: "yes" },
      { mode: "phone" },
      { size: 159 },
      { size: 481 },
      { size: Number.NaN },
      { size: 200, extra: 1 },
    ]) {
      expect(() => parseMimiPresencePatch(invalid)).toThrow("无效");
    }
  });
});

describe("effective visibility and legacy companion settings", () => {
  test("a failed docked form is not reported as visible", () => {
    const base = owner().value.snapshot();
    expect(effectiveMimiVisible({ ...base, visible: true })).toBe(true);
    expect(effectiveMimiVisible({ ...base, visible: true, dockedError: "x" })).toBe(false);
    expect(effectiveMimiVisible({ ...base, visible: false })).toBe(false);
  });

  test("computerUse:setCompanion enable → show Mimi in moving mode; disable hides only moving", async () => {
    const docked = owner({ visible: true, mode: "docked" });
    const legacy = legacyCompanionSettings(docked.value);
    // Disabling the companion while Mimi is docked must not hide the docked Mimi.
    await legacy.update({ enabled: false });
    expect(docked.calls).toEqual([]);
    await legacy.update({ enabled: true, size: 240 });
    expect(docked.calls).toEqual([{ size: 240, visible: true, mode: "moving" }]);
    await legacy.update({ enabled: false });
    expect(docked.calls.at(-1)).toEqual({ visible: false });
    await legacy.preview();
    expect(docked.calls.at(-1)).toBe("preview");
  });

  test("legacy status reports moving availability and reasons from the owner", () => {
    const unavailable = legacyCompanionSettings(
      owner({ movingAvailable: false, movingUnavailableReason: "仅支持 macOS" }).value,
    );
    expect(unavailable.status()).toEqual({
      enabled: false,
      size: 200,
      appearance: "mimi-sprite",
      available: false,
      error: "仅支持 macOS",
    });
    const moving = legacyCompanionSettings(
      owner({ visible: true, mode: "moving", effectiveMode: "moving" }).value,
    );
    expect(moving.status()).toMatchObject({ enabled: true, available: true });
  });
});
