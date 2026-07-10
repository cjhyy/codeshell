import { describe, expect, test } from "bun:test";
import {
  OPEN_TAB_DEDUPE_WINDOW_MS,
  OPEN_TAB_MAX_PER_RATE_WINDOW,
  OPEN_TAB_RATE_WINDOW_MS,
  OPEN_TAB_SENTINEL,
  buildGuestLinkBridgeScript,
  createOpenTabConsoleGuardState,
  parseGuestLinkConsoleMessage,
  shouldAcceptGuestLinkConsoleRequest,
  type GuestLinkDisposition,
} from "./useBrowserTabs";

const nonce = "nonce-for-test";

function msg(
  url: string,
  disposition: GuestLinkDisposition = "internal-tab",
  extra?: Record<string, unknown>,
): string {
  return `${OPEN_TAB_SENTINEL}${JSON.stringify({ nonce, url, disposition, ...extra })}`;
}

describe("parseGuestLinkConsoleMessage", () => {
  test("requires the sentinel at the start of the message", () => {
    expect(
      parseGuestLinkConsoleMessage(`guest log ${msg("https://example.com")}`, nonce),
    ).toBeNull();
  });

  test("parses both structured http(s) dispositions", () => {
    expect(
      parseGuestLinkConsoleMessage(msg("https://example.com/path?q=1#section", "external"), nonce),
    ).toEqual({ url: "https://example.com/path?q=1#section", disposition: "external" });
    expect(
      parseGuestLinkConsoleMessage(msg("http://localhost:3000/", "internal-tab"), nonce),
    ).toEqual({ url: "http://localhost:3000/", disposition: "internal-tab" });
  });

  test("rejects wrong nonce, unknown disposition, unstructured payloads, and non-http targets", () => {
    expect(
      parseGuestLinkConsoleMessage(
        msg("https://example.com", "external", { nonce: "wrong" }),
        nonce,
      ),
    ).toBeNull();
    expect(
      parseGuestLinkConsoleMessage(
        msg("https://example.com", "external", { disposition: "popup" }),
        nonce,
      ),
    ).toBeNull();
    expect(
      parseGuestLinkConsoleMessage(`${OPEN_TAB_SENTINEL}https://example.com`, nonce),
    ).toBeNull();
    expect(parseGuestLinkConsoleMessage(msg("example.com"), nonce)).toBeNull();
    expect(parseGuestLinkConsoleMessage(msg("javascript:alert(1)"), nonce)).toBeNull();
    expect(parseGuestLinkConsoleMessage(msg("file:///etc/passwd"), nonce)).toBeNull();
  });
});

describe("shouldAcceptGuestLinkConsoleRequest", () => {
  test("dedupes disposition + URL while allowing a different disposition", () => {
    const state = createOpenTabConsoleGuardState();
    const internal = { url: "https://example.com/", disposition: "internal-tab" } as const;
    const external = { url: "https://example.com/", disposition: "external" } as const;

    expect(shouldAcceptGuestLinkConsoleRequest(state, internal, 1000)).toBe(true);
    expect(shouldAcceptGuestLinkConsoleRequest(state, external, 1001)).toBe(true);
    expect(
      shouldAcceptGuestLinkConsoleRequest(state, internal, 1000 + OPEN_TAB_DEDUPE_WINDOW_MS - 1),
    ).toBe(false);
    expect(
      shouldAcceptGuestLinkConsoleRequest(state, internal, 1000 + OPEN_TAB_DEDUPE_WINDOW_MS),
    ).toBe(true);
  });

  test("rate-limits bursts and reopens the window later", () => {
    const state = createOpenTabConsoleGuardState();

    for (let i = 0; i < OPEN_TAB_MAX_PER_RATE_WINDOW; i += 1) {
      expect(
        shouldAcceptGuestLinkConsoleRequest(
          state,
          { url: `https://example.com/${i}`, disposition: "external" },
          2000,
        ),
      ).toBe(true);
    }
    expect(
      shouldAcceptGuestLinkConsoleRequest(
        state,
        { url: "https://example.com/overflow", disposition: "external" },
        2000,
      ),
    ).toBe(false);
    expect(
      shouldAcceptGuestLinkConsoleRequest(
        state,
        { url: "https://example.com/after-window", disposition: "external" },
        2000 + OPEN_TAB_RATE_WINDOW_MS,
      ),
    ).toBe(true);
  });
});

describe("guest link bridge script", () => {
  test("classifies modifier clicks as external and blank/middle clicks as internal tabs", () => {
    let clickListener: ((event: Record<string, unknown>) => void) | null = null;
    const messages: string[] = [];
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousConsole = globalThis.console;

    Object.assign(globalThis, {
      window: {},
      document: {
        addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
          if (type === "click") clickListener = listener;
        },
      },
      console: {
        ...previousConsole,
        info(message: string) {
          messages.push(message);
        },
      },
    });

    try {
      Function(buildGuestLinkBridgeScript(nonce))();
      if (!clickListener) throw new Error("click listener was not installed");
      const anchor = {
        href: "https://example.com/docs",
        target: "_blank",
      };
      const target = {
        closest: () => anchor,
      };
      const event = (overrides: Record<string, unknown> = {}) => ({
        isTrusted: true,
        target,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
        ...overrides,
      });

      clickListener(event({ isTrusted: false }));
      expect(messages).toHaveLength(0);

      anchor.target = "";
      clickListener(event());
      expect(messages).toHaveLength(0);

      clickListener(event({ metaKey: true }));
      expect(messages).toHaveLength(1);
      expect(parseGuestLinkConsoleMessage(messages[0], nonce)).toEqual({
        url: "https://example.com/docs",
        disposition: "external",
      });

      anchor.target = "_blank";
      clickListener(event());
      expect(parseGuestLinkConsoleMessage(messages[1], nonce)?.disposition).toBe("internal-tab");

      anchor.target = "";
      clickListener(event({ button: 1 }));
      expect(parseGuestLinkConsoleMessage(messages[2], nonce)?.disposition).toBe("internal-tab");
    } finally {
      Object.assign(globalThis, {
        window: previousWindow,
        document: previousDocument,
        console: previousConsole,
      });
    }
  });
});
