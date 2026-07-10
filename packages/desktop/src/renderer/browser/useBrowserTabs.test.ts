import { describe, expect, test } from "bun:test";
import {
  OPEN_TAB_DEDUPE_WINDOW_MS,
  OPEN_TAB_MAX_PER_RATE_WINDOW,
  OPEN_TAB_RATE_WINDOW_MS,
  createGuestLinkGuardState,
  shouldAcceptGuestLinkRequest,
} from "./useBrowserTabs";

describe("shouldAcceptGuestLinkRequest", () => {
  test("dedupes disposition + URL while allowing a different disposition", () => {
    const state = createGuestLinkGuardState();
    const internal = { url: "https://example.com/", disposition: "internal-tab" } as const;
    const external = { url: "https://example.com/", disposition: "external" } as const;

    expect(shouldAcceptGuestLinkRequest(state, internal, 1000)).toBe(true);
    expect(shouldAcceptGuestLinkRequest(state, external, 1001)).toBe(true);
    expect(
      shouldAcceptGuestLinkRequest(state, internal, 1000 + OPEN_TAB_DEDUPE_WINDOW_MS - 1),
    ).toBe(false);
    expect(shouldAcceptGuestLinkRequest(state, internal, 1000 + OPEN_TAB_DEDUPE_WINDOW_MS)).toBe(
      true,
    );
  });

  test("rate-limits trusted gesture bursts and reopens the window later", () => {
    const state = createGuestLinkGuardState();

    for (let index = 0; index < OPEN_TAB_MAX_PER_RATE_WINDOW; index += 1) {
      expect(
        shouldAcceptGuestLinkRequest(
          state,
          { url: `https://example.com/${index}`, disposition: "external" },
          2000,
        ),
      ).toBe(true);
    }
    expect(
      shouldAcceptGuestLinkRequest(
        state,
        { url: "https://example.com/overflow", disposition: "external" },
        2000,
      ),
    ).toBe(false);
    expect(
      shouldAcceptGuestLinkRequest(
        state,
        { url: "https://example.com/after-window", disposition: "external" },
        2000 + OPEN_TAB_RATE_WINDOW_MS,
      ),
    ).toBe(true);
  });
});
