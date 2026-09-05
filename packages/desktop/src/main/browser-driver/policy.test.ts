import { describe, expect, test } from "bun:test";
import { isDomainAllowed, isSensitiveAction, isWriteAction, DEFAULT_POLICY } from "./policy";

describe("isDomainAllowed", () => {
  test("empty whitelist → allow all (permissive default)", () => {
    expect(isDomainAllowed("https://anything.com/x", DEFAULT_POLICY)).toBe(true);
  });

  test("exact host match", () => {
    const p = { allowedDomains: ["xiaohongshu.com"] };
    expect(isDomainAllowed("https://xiaohongshu.com/explore", p)).toBe(true);
    expect(isDomainAllowed("https://xiaohongshu.com:8443/explore", p)).toBe(true);
    expect(isDomainAllowed("https://www.xiaohongshu.com/explore", p)).toBe(false); // exact only
    expect(isDomainAllowed("https://evil.com", p)).toBe(false);
  });

  test("suffix match with leading dot", () => {
    const p = { allowedDomains: [".xiaohongshu.com"] };
    expect(isDomainAllowed("https://www.xiaohongshu.com/x", p)).toBe(true);
    expect(isDomainAllowed("https://xiaohongshu.com/x", p)).toBe(true);
    expect(isDomainAllowed("https://notxiaohongshu.com/x", p)).toBe(false);
  });

  test("unparseable url under active whitelist → not allowed", () => {
    expect(isDomainAllowed("not a url", { allowedDomains: ["x.com"] })).toBe(false);
  });
});

describe("isSensitiveAction", () => {
  test("typing a card-number-shaped value is sensitive", () => {
    expect(isSensitiveAction({ action: "type", text: "4111 1111 1111 1111" })).toBe(true);
    expect(isSensitiveAction({ action: "type", text: "4111-1111-1111-1111" })).toBe(true);
  });

  test("typing normal text is not sensitive", () => {
    expect(isSensitiveAction({ action: "type", text: "美食探店" })).toBe(false);
  });

  test("non-type actions are not flagged by this cheap gate", () => {
    expect(isSensitiveAction({ action: "click", ref: "e1" })).toBe(false);
    expect(isSensitiveAction({ action: "snapshot" })).toBe(false);
  });
});

describe("write actions require tab control", () => {
  test("classifies page-mutating actions as writes", () => {
    // Only these can change the page or submit something, so only these need an
    // exclusive-writer check. Reads must stay cheap and lock-free.
    for (const action of ["click", "type", "navigate", "selectOption", "pressKey"]) {
      expect(isWriteAction(action)).toBe(true);
    }
  });

  test("observation and navigation-state actions are not writes", () => {
    // scroll and waitForLoad move the viewport / wait, but submit nothing;
    // gating them would make ordinary reading contend for a lock.
    for (const action of [
      "snapshot",
      "readContent",
      "extractLinks",
      "fetchImages",
      "screenshot",
      "listTabs",
      "scroll",
      "waitForLoad",
      "hover",
    ]) {
      expect(isWriteAction(action)).toBe(false);
    }
  });

  test("an unknown action is treated as a write, not waved through", () => {
    // Fail closed: a newly added action must not silently bypass the gate.
    expect(isWriteAction("teleport")).toBe(true);
  });
});
