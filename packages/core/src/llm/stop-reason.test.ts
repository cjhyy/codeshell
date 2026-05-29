import { describe, it, expect } from "bun:test";
import { isTruncatedStop } from "./stop-reason.js";

describe("isTruncatedStop", () => {
  it("treats OpenAI 'length' as a truncated stop", () => {
    // OpenAI/OpenAI-compat endpoints report an output-cap cutoff as
    // finish_reason: "length". The turn loop must recognise this to
    // trigger its max-output continuation.
    expect(isTruncatedStop("length")).toBe(true);
  });

  it("treats Anthropic 'max_tokens' as a truncated stop", () => {
    // Anthropic reports the same condition as stop_reason: "max_tokens".
    expect(isTruncatedStop("max_tokens")).toBe(true);
  });

  it("does not treat a normal completion 'stop' as truncated", () => {
    expect(isTruncatedStop("stop")).toBe(false);
  });

  it("does not treat tool-call stop ('tool_calls'/'tool_use') as truncated", () => {
    expect(isTruncatedStop("tool_calls")).toBe(false);
    expect(isTruncatedStop("tool_use")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isTruncatedStop(undefined)).toBe(false);
  });
});
