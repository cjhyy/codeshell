import { describe, expect, test } from "bun:test";
import { formatModifierShortcut } from "./keyboardShortcutHints";

describe("platform keyboard shortcut labels", () => {
  test.each([
    { platform: "darwin", text: "Cmd+B", symbol: "⌘1" },
    { platform: "win32", text: "Ctrl+B", symbol: "Ctrl+1" },
    { platform: "linux", text: "Ctrl+B", symbol: "Ctrl+1" },
  ])("formats $platform text and compact session hints", ({ platform, text, symbol }) => {
    expect(formatModifierShortcut(platform, "B")).toBe(text);
    expect(formatModifierShortcut(platform, "1", "symbol")).toBe(symbol);
  });

  test("uses Control when the host does not advertise macOS", () => {
    expect(formatModifierShortcut(undefined, "F")).toBe("Ctrl+F");
    expect(formatModifierShortcut("browser", "Shift+N")).toBe("Ctrl+Shift+N");
  });
});
