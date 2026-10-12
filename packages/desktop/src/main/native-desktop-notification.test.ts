import { expect, test } from "bun:test";
import {
  findNotificationWindow,
  showNativeDesktopNotification,
} from "./native-desktop-notification.js";

test("native clicks prefer the session owner and fall back only to live windows", () => {
  const window = (id: number, focused = false, destroyed = false) => ({
    webContents: { id },
    isFocused: () => focused,
    isDestroyed: () => destroyed,
  });
  const focused = window(1, true);
  const owner = window(2);
  expect(findNotificationWindow([focused, owner], 2)).toBe(owner);
  expect(findNotificationWindow([focused, window(2, false, true)], 2)).toBe(focused);
  expect(findNotificationWindow([owner], 999)).toBe(owner);
  expect(findNotificationWindow([window(2, false, true)], 2)).toBeUndefined();
});

test("each native notification opens its own conversation only when clicked", () => {
  const clicks: Array<() => void> = [];
  const opened: string[] = [];
  let shown = 0;
  const dependencies = {
    create: () => ({
      on: (_event: "click", listener: () => void) => clicks.push(listener),
      show: () => {
        shown += 1;
      },
    }),
    openSession: (sessionId: string) => opened.push(sessionId),
  };
  showNativeDesktopNotification(
    { title: "one", body: "details", sessionId: "s-one" },
    dependencies,
  );
  showNativeDesktopNotification(
    { title: "two", body: "details", sessionId: "s-two" },
    dependencies,
  );
  expect(shown).toBe(2);
  expect(opened).toEqual([]);
  clicks[1]!();
  clicks[0]!();
  expect(opened).toEqual(["s-two", "s-one"]);
});

test("notifications without a valid conversation still display without navigation", () => {
  let shown = 0;
  for (const sessionId of [undefined, "../other", ""]) {
    showNativeDesktopNotification(
      { title: "notice", body: "details", sessionId },
      {
        create: () => ({
          on: () => {
            throw new Error("unexpected click binding");
          },
          show: () => {
            shown += 1;
          },
        }),
        openSession: () => {
          throw new Error("unexpected navigation");
        },
      },
    );
  }
  expect(shown).toBe(3);
});
