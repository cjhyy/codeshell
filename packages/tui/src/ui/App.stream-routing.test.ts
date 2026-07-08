import { describe, expect, test } from "bun:test";
import { shouldAppendThinkingDeltaToMainFeed } from "./App.js";

describe("stream event routing", () => {
  test("routes only main-agent thinking deltas into the main feed", () => {
    expect(shouldAppendThinkingDeltaToMainFeed(undefined)).toBe(true);
    expect(shouldAppendThinkingDeltaToMainFeed("agent-1")).toBe(false);
  });
});
