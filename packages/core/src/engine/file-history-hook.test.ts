import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import { registerFileHistoryHook } from "./file-history-hook.js";

describe("registerFileHistoryHook", () => {
  it("backs up edits, records creates, resolves patches against run cwd, and disposes", async () => {
    const root = mkdtempSync(join(tmpdir(), "file-history-hook-"));
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "session");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "existing.txt"), "before");
    const hooks = new HookRegistry();
    const disposer = registerFileHistoryHook({
      hooks,
      sessionDir,
      cwd,
      getTurnSeq: () => 7,
    });

    try {
      await hooks.emit("on_tool_start", {
        toolName: "Edit",
        args: { file_path: join(cwd, "existing.txt") },
      });
      await hooks.emit("on_tool_start", {
        toolName: "Write",
        args: { file_path: join(cwd, "created.txt") },
      });
      await hooks.emit("on_tool_start", {
        toolName: "ApplyPatch",
        args: { patch: "*** Begin Patch\n*** Update File: existing.txt\n@@\n-before\n+after\n*** End Patch" },
      });

      const index = JSON.parse(
        readFileSync(join(sessionDir, "file-history", "index.json"), "utf8"),
      ) as { snapshots: Array<{ filePath: string; turnSeq: number }>; created: Array<{ filePath: string; turnSeq: number }> };
      expect(index.snapshots).toContainEqual({
        filePath: join(cwd, "existing.txt"),
        turnSeq: 7,
        timestamp: expect.any(Number),
        backupPath: expect.any(String),
        hash: expect.any(String),
        size: 6,
      });
      expect(index.created).toEqual([{ filePath: join(cwd, "created.txt"), turnSeq: 7 }]);

      disposer.dispose();
      expect(hooks.hasHooks("on_tool_start")).toBe(false);
      disposer.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
