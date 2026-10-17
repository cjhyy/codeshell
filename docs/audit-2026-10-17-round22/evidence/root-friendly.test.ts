import { describe, expect, it } from "bun:test";
import {
  friendlyError,
  formatFriendlyError,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/friendly-error.ts";
import { LLMRateLimitError } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/exceptions.ts";

describe("round22 actual friendly-error leaf, owned messages only", () => {
  it("keeps an ordinary temporary rate limit actionable", () => {
    const actual = friendlyError("429 Too Many Requests");
    expect(actual.message).toBe("Rate limited by the provider.");
    expect(actual.suggestion).toContain("lower request frequency");
  });
  it("recognizes a quota message without a status prefix", () => {
    const actual = friendlyError("insufficient_quota: check billing");
    expect(actual.message).toBe("The provider rejected the request for billing/quota reasons.");
    expect(actual.suggestion).toContain("quota/billing");
  });
  it("characterizes 429 taking precedence over explicit quota content", () => {
    const actual = friendlyError("429 insufficient_quota: check billing");
    expect(actual.message).toBe("Rate limited by the provider.");
    expect(actual.suggestion).not.toContain("quota/billing");
  });
  it("characterizes a status-prefixed credit message", () => {
    const actual = friendlyError("429 credit balance exhausted");
    expect(actual.message).toBe("Rate limited by the provider.");
    expect(actual.suggestion).toContain("Wait a moment");
  });
  it("reads only the Error message rather than structured billing metadata", () => {
    const error = Object.assign(new Error("429 credit balance exhausted"), {
      status: 429,
      code: "credit_balance_exhausted",
      type: "insufficient_quota",
    });
    expect(friendlyError(error).message).toBe("Rate limited by the provider.");
    expect(friendlyError(error).suggestion).toContain("lower request frequency");
  });
  it("accepts the actual lightweight exception class used by the static wrapper", () => {
    const error = new LLMRateLimitError("openai");
    expect(error.message).toBe("Rate limit exceeded for openai");
    expect(formatFriendlyError(error)).toContain("Rate limited by the provider.");
    expect(error.details).toEqual({ retryAfter: undefined });
  });
  it("preserves a timeout's raw detail", () => {
    const actual = friendlyError(new Error("ETIMEDOUT while waiting for a response"));
    expect(actual.message).toBe("ETIMEDOUT while waiting for a response");
    expect(actual.suggestion).toContain("timed out");
  });
  it("maps a network connection error", () => {
    const actual = friendlyError("fetch failed: ECONNRESET");
    expect(actual.message).toBe("Network error reaching the provider.");
    expect(actual.suggestion).toContain("connection");
  });
  it("maps a plain context-window error", () => {
    const actual = friendlyError("maximum context length exceeded");
    expect(actual.message).toContain("context window");
    expect(actual.suggestion).toContain("/compact");
  });
  it("maps a temporary service error", () => {
    const actual = friendlyError("503 service unavailable");
    expect(actual.message).toBe("The provider had a server-side error.");
    expect(actual.suggestion).toContain("retry shortly");
  });
  it("leaves unknown ordinary errors visible", () => {
    const actual = friendlyError(new Error("the helper could not finish"));
    expect(actual).toEqual({ message: "the helper could not finish" });
    expect(formatFriendlyError("the helper could not finish")).toBe("the helper could not finish");
  });
  it("formats the actual message and suggestion with a newline arrow", () => {
    const raw = "insufficient_quota: check billing";
    const actual = friendlyError(raw);
    expect(formatFriendlyError(raw)).toBe(`${actual.message}\n→ ${actual.suggestion}`);
    expect(formatFriendlyError(raw)).toContain("quota/billing");
  });
});
