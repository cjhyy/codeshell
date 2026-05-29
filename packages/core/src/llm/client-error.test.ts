import { describe, it, expect } from "bun:test";
import { isClientError } from "./client-base.js";
import { LLMError } from "../exceptions.js";

describe("isClientError", () => {
  it("detects a 4xx on a raw SDK error (top-level status)", () => {
    expect(isClientError({ status: 400 })).toBe(true);
    expect(isClientError({ status: 404 })).toBe(true);
  });

  it("detects a 4xx buried in LLMError.details (wrapped provider error)", () => {
    // openai.ts handleApiError wraps the SDK error as
    // new LLMError(msg, "openai", { status: 400 }) — the status lands in
    // FrameworkError.details, not a top-level .status. Without reading
    // details, every wrapped 400/401/404 was retried 3× (~9s wasted).
    const wrapped = new LLMError("OpenAI API error: bad request", "openai", { status: 400 });
    expect(isClientError(wrapped)).toBe(true);
  });

  it("does not treat 429 as a non-retryable client error", () => {
    expect(isClientError({ status: 429 })).toBe(false);
    expect(isClientError(new LLMError("rate", "openai", { status: 429 }))).toBe(false);
  });

  it("does not treat 5xx as a client error (stays retryable)", () => {
    expect(isClientError({ status: 503 })).toBe(false);
    expect(isClientError(new LLMError("upstream", "openai", { status: 502 }))).toBe(false);
  });

  it("returns false for errors with no status anywhere", () => {
    expect(isClientError(new Error("network blip"))).toBe(false);
    expect(isClientError(new LLMError("no status", "openai"))).toBe(false);
  });
});
