import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

describe("Engine.forceCompact", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "force-compact-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("can compact a persisted session before this Engine has run it live", () => {
    const engine = new Engine({
      llm: baseLlm,
      cwd: "/tmp",
      sessionStorageDir: dir,
      maxContextTokens: 100,
    });
    const session = engine
      .getSessionManager()
      .create("/tmp", "gpt-5", "openai", "persisted-session");

    for (let i = 0; i < 6; i++) {
      session.transcript.appendMessage("assistant", [
        {
          type: "tool_use",
          id: `read-${i}`,
          name: "Read",
          input: { file_path: `/tmp/file-${i}.txt` },
        },
      ]);
      session.transcript.appendToolUse("Read", `read-${i}`, {
        file_path: `/tmp/file-${i}.txt`,
      });
      session.transcript.appendToolResult(
        `read-${i}`,
        "Read",
        "file contents\n".repeat(400),
      );
    }

    const result = engine.forceCompact("persisted-session");

    expect(result.before).toBeGreaterThan(result.after);
    expect(result.strategy).toBe("compacted");
  });
});
