import { describe, expect, test } from "bun:test";
import { isDomainAllowed, isSensitiveAction, DEFAULT_POLICY } from "./policy";

describe("isDomainAllowed", () => {
  test("empty whitelist → allow all (permissive default)", () => {
    expect(isDomainAllowed("https://anything.com/x", DEFAULT_POLICY)).toBe(true);
  });

  test("exact host match", () => {
    const p = { allowedDomains: ["xiaohongshu.com"] };
    expect(isDomainAllowed("https://xiaohongshu.com/explore", p)).toBe(true);
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
