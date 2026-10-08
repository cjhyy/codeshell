import { describe, it, expect } from "bun:test";
import { friendlyError, formatFriendlyError } from "./friendly-error.js";

describe("friendlyError", () => {
  it("explains fail-closed request custody and durability without provider credentials", () => {
    const custody = formatFriendlyError(
      new Error("Model request boundary validation failed (custody)"),
    );
    expect(custody).toContain("Host could not securely sign this Session");
    expect(custody).toContain("system keyring");
    expect(custody).toContain("This attempt was stopped before sending");
    const durability = formatFriendlyError(
      new Error("Model request boundary validation failed (transcript)"),
    );
    expect(durability).toContain("recorded durably");
    expect(durability).toContain("storage is writable");
    expect(durability).not.toContain("retried automatically");
  });

  it("maps 401 / invalid key to an auth message + suggestion", () => {
    const f = friendlyError(new Error("Request failed: 401 invalid api key"));
    expect(f.message).toContain("Authentication failed");
    expect(f.suggestion).toContain("apiKey");
  });

  it("maps 429 / rate limit", () => {
    const f = friendlyError("429 Too Many Requests");
    expect(f.message).toContain("Rate limited");
    expect(f.suggestion).toContain("retry");
  });

  it("keeps the raw message for a timeout but adds a suggestion", () => {
    const f = friendlyError(new Error("ETIMEDOUT"));
    expect(f.message).toBe("ETIMEDOUT");
    expect(f.suggestion).toContain("timed out");
  });

  it("maps network errors", () => {
    const f = friendlyError(new Error("fetch failed: ECONNREFUSED"));
    expect(f.message).toContain("Network error");
    expect(f.suggestion).toContain("connection");
  });

  it("maps context-limit errors", () => {
    const f = friendlyError(new Error("maximum context length exceeded"));
    expect(f.message).toContain("context window");
    expect(f.suggestion).toContain("compact");
  });

  it("maps 5xx / overloaded", () => {
    const f = friendlyError(new Error("503 service unavailable"));
    expect(f.message).toContain("server-side error");
  });

  it("passes unknown errors through with no suggestion", () => {
    const f = friendlyError(new Error("something weird happened"));
    expect(f.message).toBe("something weird happened");
    expect(f.suggestion).toBeUndefined();
  });

  it("formatFriendlyError joins message + suggestion", () => {
    expect(formatFriendlyError("401")).toContain("→");
    expect(formatFriendlyError("totally unknown xyz")).toBe("totally unknown xyz");
  });
});
