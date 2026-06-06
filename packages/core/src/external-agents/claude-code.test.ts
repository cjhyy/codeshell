import { describe, expect, test } from "bun:test";
import { buildClaudeCodeSpawn } from "./adapters/claude-code.js";

describe("ClaudeCodeAdapter", () => {
  test("builds safe spawn args", () => {
    expect(
      buildClaudeCodeSpawn({ command: "claude", prompt: "fix tests", mode: "safe", args: [] }),
    ).toEqual({ command: "claude", args: ["fix tests"] });
  });

  test("builds dangerous spawn args without shell interpolation", () => {
    expect(
      buildClaudeCodeSpawn({
        command: "claude",
        prompt: "fix tests; rm -rf /",
        mode: "dangerous",
        args: ["--dangerously-skip-permissions"],
      }),
    ).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions", "fix tests; rm -rf /"],
    });
  });
});
