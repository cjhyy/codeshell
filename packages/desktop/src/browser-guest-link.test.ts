import { describe, expect, test } from "bun:test";
import {
  BROWSER_GUEST_LINK_CHANNEL,
  guestLinkRequestFromClick,
  parseBrowserGuestLinkIpcMessage,
} from "./browser-guest-link.js";

function click(overrides: Record<string, unknown> = {}) {
  const anchor = { href: "https://example.com/docs", target: "" };
  return {
    isTrusted: true,
    target: { closest: () => anchor },
    metaKey: false,
    ctrlKey: false,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  };
}

describe("browser guest host channel", () => {
  test("accepts only trusted modifier/blank/middle link gestures", () => {
    expect(guestLinkRequestFromClick(click({ metaKey: true }))).toEqual({
      url: "https://example.com/docs",
      disposition: "external",
    });
    expect(
      guestLinkRequestFromClick(
        click({ target: { closest: () => ({ href: "http://localhost:3000", target: "_blank" }) } }),
      ),
    ).toEqual({ url: "http://localhost:3000/", disposition: "internal-tab" });
    expect(
      guestLinkRequestFromClick(
        click({ target: { closest: () => ({ href: "https://example.com/case", target: "_BLANK" }) } }),
      ),
    ).toEqual({ url: "https://example.com/case", disposition: "internal-tab" });
    expect(guestLinkRequestFromClick(click({ button: 1 }))).toMatchObject({
      disposition: "internal-tab",
    });
    expect(guestLinkRequestFromClick(click({ isTrusted: false, metaKey: true }))).toBeNull();
    expect(guestLinkRequestFromClick(click())).toBeNull();
  });

  test("a page monkey-patching console cannot observe a capability or forge host IPC", () => {
    const seen: unknown[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => seen.push(args);
    try {
      const request = guestLinkRequestFromClick(click({ ctrlKey: true }));
      expect(request?.disposition).toBe("external");
      expect(seen).toEqual([]);
      expect(
        parseBrowserGuestLinkIpcMessage({
          channel: "console-message",
          args: [{ url: "https://evil.example", disposition: "external" }],
        }),
      ).toBeNull();
      expect(
        parseBrowserGuestLinkIpcMessage({
          channel: BROWSER_GUEST_LINK_CHANNEL,
          args: [{ url: "javascript:alert(1)", disposition: "external" }],
        }),
      ).toBeNull();
    } finally {
      console.info = original;
    }
  });

  test("host parser accepts only the private channel, dispositions, and absolute http(s)", () => {
    expect(
      parseBrowserGuestLinkIpcMessage({
        channel: BROWSER_GUEST_LINK_CHANNEL,
        args: [{ url: "https://example.com/path", disposition: "external" }],
      }),
    ).toEqual({ url: "https://example.com/path", disposition: "external" });
    expect(
      parseBrowserGuestLinkIpcMessage({
        channel: BROWSER_GUEST_LINK_CHANNEL,
        args: [{ url: "file:///etc/passwd", disposition: "external" }],
      }),
    ).toBeNull();
    expect(
      parseBrowserGuestLinkIpcMessage({
        channel: BROWSER_GUEST_LINK_CHANNEL,
        args: [{ url: "https://example.com", disposition: "popup" }],
      }),
    ).toBeNull();
  });
});
