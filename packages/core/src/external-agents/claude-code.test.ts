import { describe, expect, test } from "bun:test";
import { buildClaudeCodeSpawn, pathWithCommonBins } from "./adapters/claude-code.js";

describe("ClaudeCodeAdapter", () => {
  test("builds safe spawn args", () => {
    expect(
      buildClaudeCodeSpawn({ command: "claude", prompt: "fix tests", mode: "safe", args: [] }),
    ).toEqual({ command: "claude", args: ["fix tests"] });
  });

  test("prepends --print for claude-code (non-interactive) but not for codex", () => {
    expect(
      buildClaudeCodeSpawn({ command: "claude", prompt: "hi", mode: "safe", args: [], kind: "claude-code" }),
    ).toEqual({ command: "claude", args: ["--print", "hi"] });
    expect(
      buildClaudeCodeSpawn({ command: "codex", prompt: "hi", mode: "safe", args: [], kind: "codex" }),
    ).toEqual({ command: "codex", args: ["hi"] });
  });

  test("pathWithCommonBins prepends Homebrew/usr-local and dedupes", () => {
    const p = pathWithCommonBins({ PATH: "/opt/homebrew/bin:/custom/bin" });
    const parts = p.split(":");
    expect(parts[0]).toBe("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/custom/bin");
    // no duplicate of the already-present homebrew dir
    expect(parts.filter((x) => x === "/opt/homebrew/bin")).toHaveLength(1);
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
