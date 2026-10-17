import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type { TurnDiffSnapshot } from "../types.js";
import { registerFileHistoryHook } from "./file-history-hook.js";

describe("file evidence after execution settles", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "settled-file-diff-")));
    roots.push(root);
    const file = join(root, "a.txt");
    writeFileSync(file, "A\n");
    const hooks = new HookRegistry();
    const registry = new ToolRegistry({ builtinTools: [] });
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "bypassPermissions"),
      hooks,
    );
    const snapshots: TurnDiffSnapshot[] = [];
    const disposer = registerFileHistoryHook({
      hooks,
      sessionDir: join(root, "session"),
      cwd: root,
      getTurnSeq: () => 1,
      observeCompletion: (observer) => executor.observeCompletion(observer),
      turnDiff: {
        turnId: "turn",
        onUpdate: (snapshot) => {
          snapshots.push(snapshot);
        },
      },
    });
    return { root, file, hooks, registry, executor, snapshots, disposer };
  }
  test("captures formatter and file_changed hook writes after Write", async () => {
    const h = setup();
    h.registry.registerTool(
      {
        name: "Write",
        description: "fixture",
        inputSchema: { type: "object" },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => {
        writeFileSync(h.file, "B\n");
        return "written";
      },
    );
    h.hooks.register("post_tool_use", () => {
      writeFileSync(h.file, "C\n");
      return {};
    });
    h.hooks.register("file_changed", () => {
      writeFileSync(h.file, "D\n");
      return {};
    });
    const result = await h.executor.executeSingle({
      id: "write",
      toolName: "Write",
      args: { file_path: h.file },
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(h.file, "utf8")).toBe("D\n");
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]!.files[0]!.diff).toContain("-A\n+D\n");
    h.disposer.dispose();
    writeFileSync(h.file, "E\n");
    await h.executor.executeSingle({
      id: "after-dispose",
      toolName: "Write",
      args: { file_path: h.file },
    });
    expect(h.snapshots).toHaveLength(1);
  });
  test("reports actual partial changes when a file tool fails", async () => {
    const h = setup();
    h.registry.registerTool(
      {
        name: "Edit",
        description: "fixture",
        inputSchema: { type: "object" },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => {
        writeFileSync(h.file, "partial\n");
        return { ok: false, error: "failed after mutation" };
      },
    );
    const result = await h.executor.executeSingle({
      id: "partial",
      toolName: "Edit",
      args: { file_path: h.file },
    });
    expect(result.isError).toBe(true);
    expect(h.snapshots.at(-1)!.files[0]!.diff).toContain("-A\n+partial\n");
    h.disposer.dispose();
  });
  test("refreshes known file states after a foreground compound tool finishes", async () => {
    const h = setup();
    for (const [name, content] of [
      ["Edit", "B\n"],
      ["CompoundTask", "C\n"],
    ]) {
      h.registry.registerTool(
        {
          name,
          description: "fixture",
          inputSchema: { type: "object" },
          source: "builtin",
          permissionDefault: "allow",
        },
        async () => {
          writeFileSync(h.file, content);
          return "done";
        },
      );
    }
    await h.executor.executeSingle({
      id: "parent-edit",
      toolName: "Edit",
      args: { file_path: h.file },
    });
    await h.executor.executeSingle({ id: "child-work", toolName: "CompoundTask", args: {} });
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots.at(-1)!.files[0]!.diff).toContain("-A\n+C\n");
    h.disposer.dispose();
  });
});
