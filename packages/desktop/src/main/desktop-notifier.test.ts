import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DesktopNotifier, type DesktopNotifierDependencies } from "./desktop-notifier.js";

const tempRoots: string[] = [];

function fixture(overrides: Partial<DesktopNotifierDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-desktop-notifier-"));
  tempRoots.push(root);
  const shown: Array<{ title: string; body: string }> = [];
  const dependencies: DesktopNotifierDependencies = {
    hasFocusedWindow: () => false,
    isSupported: () => true,
    show: (input) => shown.push(input),
    now: () => 100,
    ...overrides,
  };
  return {
    root,
    path: join(root, "notifications.json"),
    shown,
    dependencies,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DesktopNotifier", () => {
  it("deduplicates the same key across process-like instances", async () => {
    const f = fixture();
    const first = new DesktopNotifier(f.path, f.dependencies);
    expect(await first.notify({ key: "result-1", title: "完成", body: "first" })).toBe("shown");

    const restarted = new DesktopNotifier(f.path, f.dependencies);
    expect(await restarted.notify({ key: "result-1", title: "完成", body: "again" })).toBe(
      "duplicate",
    );
    expect(f.shown).toEqual([{ title: "完成", body: "first" }]);
  });

  it("skips non-urgent notifications while focused", async () => {
    const f = fixture({ hasFocusedWindow: () => true });
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    expect(await notifier.notify({ key: "focused", title: "完成", body: "body" })).toBe("focused");
    expect(f.shown).toEqual([]);
  });

  it("shows urgent notifications while focused", async () => {
    const f = fixture({ hasFocusedWindow: () => true });
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    expect(
      await notifier.notify({ key: "urgent", title: "停止", body: "body", urgent: true }),
    ).toBe("shown");
    expect(f.shown).toHaveLength(1);
  });

  it("normalizes and truncates bodies to 180 characters", async () => {
    const f = fixture();
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    await notifier.notify({ key: "body", title: "完成", body: `  ${"x".repeat(200)}\nnext  ` });
    expect(f.shown[0]!.body).toHaveLength(180);
    expect(f.shown[0]!.body).toBe("x".repeat(180));
  });

  it("delays bursts instead of dropping them", async () => {
    let now = 100;
    const waits: number[] = [];
    const f = fixture({
      maxNotificationsPerWindow: 1,
      rateWindowMs: 10,
      now: () => now,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
      },
    });
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    expect(await notifier.notify({ key: "one", title: "完成", body: "one" })).toBe("shown");
    expect(await notifier.notify({ key: "two", title: "完成", body: "two" })).toBe("shown");
    expect(waits).toEqual([10]);
    expect(f.shown).toHaveLength(2);
  });

  it("lets urgent notifications bypass a saturated rate window", async () => {
    const f = fixture({
      maxNotificationsPerWindow: 1,
      sleep: async () => {
        throw new Error("urgent notification unexpectedly waited");
      },
    });
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    await notifier.notify({ key: "one", title: "完成", body: "one" });
    expect(
      await notifier.notify({ key: "urgent", title: "停止", body: "urgent", urgent: true }),
    ).toBe("shown");
    expect(f.shown).toHaveLength(2);
  });

  it("does not charge urgent notifications against the ordinary burst budget", async () => {
    const f = fixture({
      maxNotificationsPerWindow: 1,
      sleep: async () => {
        throw new Error("ordinary notification waited behind an exempt urgent notification");
      },
    });
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    await notifier.notify({ key: "urgent-first", title: "停止", body: "urgent", urgent: true });
    expect(await notifier.notify({ key: "ordinary", title: "完成", body: "ordinary" })).toBe(
      "shown",
    );
    expect(f.shown).toHaveLength(2);
  });

  it("does not persist a receipt when show throws", async () => {
    let shouldThrow = true;
    const f = fixture({
      show: (input) => {
        if (shouldThrow) throw new Error("native notification failed");
        f.shown.push(input);
      },
    });
    const notifier = new DesktopNotifier(f.path, f.dependencies);
    expect(await notifier.notify({ key: "retry", title: "完成", body: "body" })).toBe("failed");
    shouldThrow = false;
    expect(await notifier.notify({ key: "retry", title: "完成", body: "body" })).toBe("shown");
    expect(f.shown).toHaveLength(1);
  });

  it("quarantines unreadable history and continues notifying", async () => {
    const f = fixture();
    writeFileSync(f.path, '{"broken":');
    const notifier = new DesktopNotifier(f.path, f.dependencies);

    expect(await notifier.notify({ key: "after-corrupt", title: "完成", body: "body" })).toBe(
      "shown",
    );
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual([
      expect.objectContaining({ key: "after-corrupt" }),
    ]);
    const quarantine = readdirSync(f.root).find((name) => name.endsWith(".corrupt"));
    expect(quarantine).toBeDefined();
    expect(f.shown).toHaveLength(1);
  });
});
