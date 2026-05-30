import { describe, test, expect } from "bun:test";
import { buildOsascriptArgs, buildNotifySendArgs, escapeAppleScriptString } from "./notifier.js";

// Regression: notify() interpolated user title/message into single-quoted
// shell strings run via execSync (review-2026-05-30, security). Backslash does
// NOT escape inside POSIX single quotes, so a message with a `'` broke out and
// could execute, e.g. `'$(rm -rf ~)'`. Fix: pass argv via execFileSync (no
// shell) and escape only for the target interpreter (AppleScript).

describe("notifier — no shell injection", () => {
  test("AppleScript escaping handles quotes and backslashes, drops newlines", () => {
    expect(escapeAppleScriptString('he said "hi"')).toBe('he said \\"hi\\"');
    expect(escapeAppleScriptString("a\\b")).toBe("a\\\\b");
    expect(escapeAppleScriptString("line1\nline2")).toBe("line1 line2");
  });

  test("osascript args are a single -e script argv (not a shell string)", () => {
    const args = buildOsascriptArgs("Title", "Message", false);
    expect(args[0]).toBe("-e");
    expect(args).toHaveLength(2);
    // The script contains the (escaped) text but is ONE argv element — the
    // shell never sees it.
    expect(args[1]).toContain("display notification");
    expect(args[1]).toContain("Message");
    expect(args[1]).toContain("Title");
  });

  test("a quote-injection title cannot terminate the script string", () => {
    // Input that under the old single-quoted shell string would break out.
    const evil = `x"); do shell script "touch /tmp/PWNED"; (`;
    const args = buildOsascriptArgs(evil, "m", false);
    // The dangerous double-quotes are AppleScript-escaped (\"), so they stay
    // inside the notification text literal rather than closing it.
    expect(args[1]).toContain('\\"');
    expect(args[1]).not.toContain('x"); do shell script'); // raw form absent
  });

  test("notify-send args are argv with title and message separate", () => {
    const args = buildNotifySendArgs("T", "M", "critical");
    expect(args).toContain("T");
    expect(args).toContain("M");
    expect(args).toContain("critical");
    // user text is never concatenated into one of the flag tokens
    expect(args.some((a) => a.includes("\"T\""))).toBe(false);
  });
});
