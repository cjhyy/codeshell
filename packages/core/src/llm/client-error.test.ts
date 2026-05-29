import { describe, it, expect } from "bun:test";
import { isClientError, isAbortError } from "./client-base.js";
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

  // An abort has no HTTP status, so isClientError must NOT claim it — the
  // dedicated isAbortError check is what stops withRetry from retrying it.
  it("does not treat an aborted request as a client error", () => {
    const abort = new Error("Request was aborted.");
    abort.name = "APIUserAbortError";
    expect(isClientError(abort)).toBe(false);
  });
});

describe("isAbortError", () => {
  it("detects the SDK APIUserAbortError by name", () => {
    const err = new Error("Request was aborted.");
    err.name = "APIUserAbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("detects the WHATWG AbortError by name", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("returns false for ordinary errors and 5xx", () => {
    expect(isAbortError(new Error("network blip"))).toBe(false);
    expect(isAbortError({ status: 503 })).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
