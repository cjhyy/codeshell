import { expect, test } from "bun:test";
import { MobilePermissionModes } from "./permission-modes.js";

test("new phone default survives omitted and stale Desktop snapshots until adoption echoes it", () => {
  const modes = new MobilePermissionModes();
  modes.replaceDesktopSnapshot([{ sessionId: "desktop", mode: "bypassPermissions" }]);
  modes.set("new-phone", "default");
  modes.replaceDesktopSnapshot([{ sessionId: "desktop", mode: "acceptEdits" }]);
  expect(modes.get("new-phone")).toBe("default");
  expect(modes.get("desktop")).toBe("acceptEdits");
  modes.replaceDesktopSnapshot([{ sessionId: "new-phone", mode: "bypassPermissions" }]);
  expect(modes.get("new-phone")).toBe("default");
  modes.replaceDesktopSnapshot([{ sessionId: "new-phone", mode: "default" }]);
  modes.replaceDesktopSnapshot([{ sessionId: "new-phone", mode: "acceptEdits" }]);
  expect(modes.get("new-phone")).toBe("acceptEdits");
  modes.replaceDesktopSnapshot([]);
  expect(modes.has("new-phone")).toBe(false);
});

test("a newer phone restriction wins an older echo without freezing later Desktop changes", () => {
  const modes = new MobilePermissionModes();
  modes.set("session", "bypassPermissions");
  modes.set("session", "default");
  modes.replaceDesktopSnapshot([{ sessionId: "session", mode: "bypassPermissions" }]);
  expect(modes.get("session")).toBe("default");
  modes.replaceDesktopSnapshot([{ sessionId: "session", mode: "default" }]);
  modes.replaceDesktopSnapshot([{ sessionId: "session", mode: "bypassPermissions" }]);
  expect(modes.get("session")).toBe("bypassPermissions");
  modes.replaceDesktopSnapshot([{ sessionId: "session", mode: "invalid" }, null]);
  expect(modes.size).toBe(0);
});
