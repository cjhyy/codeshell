import { describe, test, expect } from "bun:test";
import { browserOpenCommand } from "./browser-open.js";

// Regression: openBrowser ran `open "${url}"` via exec() (a shell), so a URL
// with `"` + `$(...)` could inject (review-2026-05-30, security). The fix uses
// execFile with an argv array — the URL is one literal argument, no shell.

describe("browserOpenCommand", () => {
  test("darwin → open <url> argv", () => {
    expect(browserOpenCommand("darwin", "https://x")).toEqual({ cmd: "open", args: ["https://x"] });
  });
  test("win32 → cmd /c start <url> argv (empty title slot)", () => {
    expect(browserOpenCommand("win32", "https://x")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "https://x"],
    });
  });
  test("linux → xdg-open <url> argv", () => {
    expect(browserOpenCommand("linux", "https://x")).toEqual({ cmd: "xdg-open", args: ["https://x"] });
  });
  test("an injection-y url stays a single argv element", () => {
    const evil = 'https://x" $(touch /tmp/PWNED) "';
    const { args } = browserOpenCommand("darwin", evil);
    expect(args).toEqual([evil]); // one literal token, never split/interpreted
  });
});
