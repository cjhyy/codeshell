import { describe, expect, test } from "bun:test";
import {
  builtinPanelSource,
  describeBrowserSource,
  isUserOwnedSource,
  parseDebugEndpoint,
  requiresStrictApproval,
  type BrowserSource,
} from "./browser-source";

const attached: BrowserSource = {
  kind: "attached-chrome",
  endpoint: "http://127.0.0.1:9222",
  browserId: "chrome-abc",
};

describe("source classification", () => {
  test("only an attached real browser counts as the user's own", () => {
    // Drives the warning the model sees and the approval strictness below, so
    // getting this backwards would either cry wolf or stay silent on the one
    // browser where a misclick hits real accounts.
    expect(isUserOwnedSource(attached)).toBe(true);
    expect(isUserOwnedSource(builtinPanelSource("p:proj-1"))).toBe(false);
    expect(isUserOwnedSource({ kind: "builtin-headless", profileId: "p:proj-1" })).toBe(false);
  });

  test("a remote server browser is not the user's own browser", () => {
    // It holds server-side logins, not the person's Chrome profile.
    expect(
      isUserOwnedSource({
        kind: "remote",
        endpoint: "https://browser.internal:443",
        browserId: "pod-7",
      }),
    ).toBe(false);
  });
});

describe("approval strictness by source", () => {
  test("external sources always require approval for sensitive actions", () => {
    // A misclick in a sandbox partition pollutes a throwaway cookie jar; the
    // same misclick in the user's Chrome can be a real transfer or a real post.
    expect(requiresStrictApproval(attached)).toBe(true);
    expect(
      requiresStrictApproval({
        kind: "remote",
        endpoint: "https://browser.internal:443",
        browserId: "pod-7",
      }),
    ).toBe(true);
  });

  test("built-in sources keep the existing approval behavior", () => {
    expect(requiresStrictApproval(builtinPanelSource("p:proj-1"))).toBe(false);
  });
});

describe("debug endpoint parsing", () => {
  test("accepts a loopback CDP endpoint", () => {
    expect(parseDebugEndpoint("http://127.0.0.1:9222")).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:9222",
    });
    expect(parseDebugEndpoint("http://localhost:9222").ok).toBe(true);
  });

  test("refuses a non-loopback host", () => {
    // A remote debugging port is unauthenticated: anything that can reach it
    // controls the browser. Attaching across the network would hand the user's
    // logged-in browser to whoever is listening.
    const r = parseDebugEndpoint("http://192.168.1.50:9222");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("not_loopback");
  });

  test("refuses a non-http scheme", () => {
    expect(parseDebugEndpoint("ws://127.0.0.1:9222").ok).toBe(false);
    expect(parseDebugEndpoint("file:///etc/passwd").ok).toBe(false);
  });

  test("refuses garbage instead of throwing", () => {
    expect(parseDebugEndpoint("not a url").ok).toBe(false);
    expect(parseDebugEndpoint("").ok).toBe(false);
  });

  test("refuses a missing port so the default web port is never assumed", () => {
    const r = parseDebugEndpoint("http://127.0.0.1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("no_port");
  });
});

describe("human-readable source", () => {
  test("names the built-in profile", () => {
    expect(describeBrowserSource(builtinPanelSource("p:proj-1"))).toContain("p:proj-1");
  });

  test("marks the user's own browser in words, not just a label", () => {
    // A profile id alone conveys no risk.
    expect(describeBrowserSource(attached)).toMatch(/自己的浏览器|真实/);
  });
});
