import { describe, expect, test } from "bun:test";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

describe("Pet tool argument boundary", () => {
  test("accepts the ToolRegistry execution signal without relaxing public arguments", () => {
    const signal = new AbortController().signal;

    expect(hasOnlyDeclaredToolArguments({ action: "list", __signal: signal }, ["action"])).toBe(
      true,
    );
    expect(hasOnlyDeclaredToolArguments({ action: "list", injected: true }, ["action"])).toBe(
      false,
    );
    expect(hasOnlyDeclaredToolArguments({ action: "list", __future: true }, ["action"])).toBe(
      false,
    );
  });
});
