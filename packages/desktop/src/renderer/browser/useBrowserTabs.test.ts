import { describe, expect, test } from "bun:test";
import {
  OPEN_TAB_DEDUPE_WINDOW_MS,
  OPEN_TAB_MAX_PER_RATE_WINDOW,
  OPEN_TAB_RATE_WINDOW_MS,
  OPEN_TAB_SENTINEL,
  createOpenTabConsoleGuardState,
  parseOpenTabConsoleMessage,
  shouldAcceptOpenTabConsoleUrl,
} from "./useBrowserTabs";

const nonce = "nonce-for-test";

function msg(url: string, extra?: Record<string, unknown>): string {
  return `${OPEN_TAB_SENTINEL}${JSON.stringify({ nonce, url, ...extra })}`;
}

describe("parseOpenTabConsoleMessage", () => {
  test("requires the sentinel at the start of the message", () => {
    expect(parseOpenTabConsoleMessage(`guest log ${msg("https://example.com")}`, nonce)).toBeNull();
  });

  test("parses a structured http(s) target", () => {
    expect(parseOpenTabConsoleMessage(msg("https://example.com/path?q=1#section"), nonce)).toBe(
      "https://example.com/path?q=1#section",
    );
    expect(parseOpenTabConsoleMessage(msg("http://localhost:3000/"), nonce)).toBe(
      "http://localhost:3000/",
    );
  });

  test("rejects wrong nonce, unstructured payloads, and non-http targets", () => {
    expect(
      parseOpenTabConsoleMessage(msg("https://example.com", { nonce: "wrong" }), nonce),
    ).toBeNull();
    expect(parseOpenTabConsoleMessage(`${OPEN_TAB_SENTINEL}https://example.com`, nonce)).toBeNull();
    expect(parseOpenTabConsoleMessage(msg("example.com"), nonce)).toBeNull();
    expect(parseOpenTabConsoleMessage(msg("javascript:alert(1)"), nonce)).toBeNull();
    expect(parseOpenTabConsoleMessage(msg("file:///etc/passwd"), nonce)).toBeNull();
  });
});

describe("shouldAcceptOpenTabConsoleUrl", () => {
  test("dedupes repeated URLs within the duplicate window", () => {
    const state = createOpenTabConsoleGuardState();

    expect(shouldAcceptOpenTabConsoleUrl(state, "https://example.com/", 1000)).toBe(true);
    expect(
      shouldAcceptOpenTabConsoleUrl(
        state,
        "https://example.com/",
        1000 + OPEN_TAB_DEDUPE_WINDOW_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldAcceptOpenTabConsoleUrl(
        state,
        "https://example.com/",
        1000 + OPEN_TAB_DEDUPE_WINDOW_MS,
      ),
    ).toBe(true);
  });

  test("rate-limits bursts and reopens the window later", () => {
    const state = createOpenTabConsoleGuardState();

    for (let i = 0; i < OPEN_TAB_MAX_PER_RATE_WINDOW; i += 1) {
      expect(shouldAcceptOpenTabConsoleUrl(state, `https://example.com/${i}`, 2000)).toBe(true);
    }
    expect(shouldAcceptOpenTabConsoleUrl(state, "https://example.com/overflow", 2000)).toBe(false);
    expect(
      shouldAcceptOpenTabConsoleUrl(
        state,
        "https://example.com/after-window",
        2000 + OPEN_TAB_RATE_WINDOW_MS,
      ),
    ).toBe(true);
  });
});
