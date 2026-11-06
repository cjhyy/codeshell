import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDesktopInstanceLock,
  registerSecondInstanceFocus,
  runOwnedQuickChatStartupCleanup,
} from "./quick-chat-startup-cleanup";
import { cleanupStaleQuickChatSessions } from "@cjhyy/code-shell-server/storage";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("quick-chat startup cleanup ownership", () => {
  test("a second desktop instance that cannot acquire the lock leaves the live owner's qchat intact", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "quick-chat-live-owner-"));
    tempDirs.push(sessionsDir);
    const liveSessionDir = join(sessionsDir, "qchat-live-in-first-instance");
    mkdirSync(liveSessionDir);
    writeFileSync(join(liveSessionDir, "transcript.jsonl"), "live private transcript");
    let quitCalls = 0;
    const ownsDesktopInstance = acquireDesktopInstanceLock({
      requestSingleInstanceLock: () => false,
      quit: () => {
        quitCalls++;
      },
    });

    const removed = await runOwnedQuickChatStartupCleanup(ownsDesktopInstance, () =>
      cleanupStaleQuickChatSessions(sessionsDir),
    );

    expect(ownsDesktopInstance).toBe(false);
    expect(quitCalls).toBe(1);
    expect(removed).toEqual([]);
    expect(existsSync(liveSessionDir)).toBe(true);
  });

  test("the owning desktop instance keeps the normal startup cleanup path", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "quick-chat-owned-startup-"));
    tempDirs.push(sessionsDir);
    const staleSessionDir = join(sessionsDir, "qchat-stale-owned");
    mkdirSync(staleSessionDir);
    writeFileSync(join(staleSessionDir, "transcript.jsonl"), "stale private transcript");
    let quitCalls = 0;
    const ownsDesktopInstance = acquireDesktopInstanceLock({
      requestSingleInstanceLock: () => true,
      quit: () => {
        quitCalls++;
      },
    });

    const removed = await runOwnedQuickChatStartupCleanup(ownsDesktopInstance, () =>
      cleanupStaleQuickChatSessions(sessionsDir),
    );

    expect(ownsDesktopInstance).toBe(true);
    expect(quitCalls).toBe(0);
    expect(removed).toEqual(["qchat-stale-owned"]);
    expect(existsSync(staleSessionDir)).toBe(false);
  });

  test("a second launch restores, shows, and focuses the existing main window", () => {
    let secondInstanceHandler: (() => void) | undefined;
    let registrations = 0;
    const calls: string[] = [];
    registerSecondInstanceFocus(
      (handler) => {
        registrations++;
        secondInstanceHandler = handler;
      },
      () => [
        {
          isDestroyed: () => false,
          isMinimized: () => true,
          restore: () => calls.push("restore"),
          show: () => calls.push("show"),
          focus: () => calls.push("focus"),
        },
      ],
    );

    expect(registrations).toBe(1);
    secondInstanceHandler?.();
    expect(calls).toEqual(["restore", "show", "focus"]);
  });
});

test("concurrent restore requests share the in-flight main window", async () => {
  const { createMainWindowRestorer } = await import("./quick-chat-startup-cleanup.js");
  let creates = 0;
  let release!: (window: object) => void;
  let window: object | undefined = undefined;
  const restore = createMainWindowRestorer(
    () => window,
    () => {
      creates++;
      return new Promise<object>((resolve) => {
        release = resolve;
      });
    },
  );
  const first = restore(),
    second = restore();
  expect(creates).toBe(1);
  window = {};
  release(window);
  expect(await first).toBe(window);
  expect(await second).toBe(window);
  expect(await restore()).toBe(window);
  expect(creates).toBe(1);
});

test("the startup main window shares the restorer with Dock activation", async () => {
  // A Dock click queued while startup is blocked (e.g. by a Keychain prompt)
  // fires `activate` right after the startup window is requested. Both paths must
  // share one restorer, or the gap before mainWindows.add creates a second window.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const startup = source.match(/const initialWindowReady = ([^;]+);/);
  expect(startup?.[1]).toBe("restoreMainWindow()");
});
