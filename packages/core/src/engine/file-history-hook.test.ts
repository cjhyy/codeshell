import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      contributions: [
        {
          toolName: "ExampleCompoundEdit",
          resolveTargets: (_args, runCwd) => [join(runCwd, "existing.txt")],
        },
      ],
    });

    try {
      await hooks.emit("on_tool_start", {
        toolName: "Edit",
        toolCallId: "edit-existing",
        args: { file_path: join(cwd, "existing.txt") },
      });
      await hooks.emit("on_tool_start", {
        toolName: "Write",
        toolCallId: "write-created",
        args: { file_path: join(cwd, "created.txt") },
      });
      writeFileSync(join(cwd, "created.txt"), "created");
      await hooks.emit("on_tool_end", {
        toolName: "Write",
        toolCallId: "write-created",
        isError: false,
      });
      await hooks.emit("on_tool_start", {
        toolName: "ExampleCompoundEdit",
        toolCallId: "compound",
        args: { input: "opaque" },
      });

      const index = JSON.parse(
        readFileSync(join(sessionDir, "file-history", "index.json"), "utf8"),
      ) as {
        snapshots: Array<{
          filePath: string;
          turnSeq: number;
          timestamp: number;
          backupPath: string;
          hash: string;
          size: number;
        }>;
        created: Array<{ filePath: string; turnSeq: number; realPath?: string }>;
      };
      expect(index.snapshots).toContainEqual(
        expect.objectContaining({
          filePath: join(cwd, "existing.txt"),
          turnSeq: 7,
          timestamp: expect.any(Number),
          backupPath: expect.any(String),
          hash: expect.any(String),
          size: 6,
        }),
      );
      expect(index.created).toEqual([
        {
          filePath: join(cwd, "created.txt"),
          turnSeq: 7,
          realPath: expect.stringContaining("/created.txt"),
        },
      ]);

      disposer.dispose();
      expect(hooks.hasHooks("on_tool_start")).toBe(false);
      expect(hooks.hasHooks("on_tool_end")).toBe(false);
      disposer.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits create markers only after success and never marks an existing symlink", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "file-history-hook-failure-"));
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "session");
    mkdirSync(cwd, { recursive: true });
    const outside = join(root, "outside.txt");
    const linked = join(cwd, "linked.txt");
    writeFileSync(outside, "keep");
    symlinkSync(outside, linked);
    const hooks = new HookRegistry();
    const disposer = registerFileHistoryHook({
      hooks,
      sessionDir,
      cwd,
      getTurnSeq: () => 9,
    });

    try {
      await hooks.emit("on_tool_start", {
        toolName: "Write",
        toolCallId: "failed-create",
        args: { file_path: join(cwd, "failed.txt") },
      });
      await hooks.emit("on_tool_end", {
        toolName: "Write",
        toolCallId: "failed-create",
        isError: true,
      });
      await hooks.emit("on_tool_start", {
        toolName: "Write",
        toolCallId: "symlink-write",
        args: { file_path: linked },
      });
      await hooks.emit("on_tool_end", {
        toolName: "Write",
        toolCallId: "symlink-write",
        isError: true,
      });

      const indexPath = join(sessionDir, "file-history", "index.json");
      expect(() => readFileSync(indexPath, "utf8")).toThrow();
      expect(readFileSync(outside, "utf8")).toBe("keep");
    } finally {
      disposer.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
