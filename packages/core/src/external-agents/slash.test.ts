import { describe, expect, test } from "bun:test";
import { parseExternalAgentSlash } from "./slash.js";

describe("parseExternalAgentSlash", () => {
  test("parses /cc prompt", () => {
    expect(parseExternalAgentSlash("/cc fix tests")).toEqual({
      kind: "claude-code",
      prompt: "fix tests",
      mode: undefined,
    });
  });

  test("parses /cc --safe prompt", () => {
    expect(parseExternalAgentSlash("/cc --safe fix tests")).toEqual({
      kind: "claude-code",
      prompt: "fix tests",
      mode: "safe",
    });
  });

  test("parses /cc --dangerous prompt", () => {
    expect(parseExternalAgentSlash("/cc --dangerous fix tests")).toEqual({
      kind: "claude-code",
      prompt: "fix tests",
      mode: "dangerous",
    });
  });

  test("parses /codex prompt", () => {
    expect(parseExternalAgentSlash("/codex review diff")).toEqual({
      kind: "codex",
      prompt: "review diff",
      mode: undefined,
    });
  });

  test("returns undefined for normal chat", () => {
    expect(parseExternalAgentSlash("hello")).toBeUndefined();
  });
});
