import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath } from "./path-policy.js";
import { canonicalPath } from "../workspace/canonical-key.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { RegisteredTool, ToolCall } from "../types.js";
import type { ToolContext } from "./context.js";

describe("PathPolicy multi-root containment", () => {
  test("allows every declared root but not siblings or prefix lookalikes", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-path-roots-"));
    const main = join(dir, "main");
    const secondary = join(dir, "secondary");
    const evil = join(dir, "secondary-evil");
    mkdirSync(main);
    mkdirSync(secondary);
    mkdirSync(evil);
    try {
      const roots = [main, secondary];
      expect(
        classifyPath(join(secondary, "new.ts"), {
          workspaceRoot: main,
          workspaceRoots: roots,
          operation: "write",
        }),
      ).toMatchObject({ decision: "allow", matchedRoot: canonicalPath(secondary) });
      expect(
        classifyPath(join(evil, "new.ts"), {
          workspaceRoot: main,
          workspaceRoots: roots,
          operation: "write",
        }).decision,
      ).toBe("ask");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not let a symlink inside a root escape the root set", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-path-symlink-"));
    const main = join(dir, "main");
    const outside = join(dir, "outside");
    mkdirSync(main);
    mkdirSync(outside);
    symlinkSync(outside, join(main, "escape"));
    try {
      expect(
        classifyPath(join(main, "escape", "file.ts"), {
          workspaceRoot: main,
          workspaceRoots: [main],
          operation: "write",
        }).decision,
      ).toBe("ask");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ToolExecutor authorizes Read/Write/Edit/Glob/Grep and compound paths in secondary roots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-executor-roots-"));
    const main = join(dir, "main");
    const secondary = join(dir, "secondary");
    const outside = join(dir, "outside");
    mkdirSync(main);
    mkdirSync(secondary);
    mkdirSync(outside);
    try {
      const registry = new ToolRegistry({ builtinTools: [] });
      const makeTool = (name: string, operation: "read" | "write"): RegisteredTool =>
        ({
          name,
          description: `${name} test tool`,
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          source: "builtin",
          permissionDefault: "allow",
          pathPolicy: [{ kind: "arg", arg: "path", operation }],
        }) as RegisteredTool;
      for (const [name, operation] of [
        ["Read", "read"],
        ["Write", "write"],
        ["Edit", "write"],
        ["Glob", "read"],
        ["Grep", "read"],
      ] as const) {
        registry.registerTool(makeTool(name, operation), async () => "ok");
      }
      registry.registerTool(
        {
          ...makeTool("Compound", "write"),
          pathPolicy: undefined,
          pathResolver: {
            operation: "write",
            resolve: (args: Record<string, unknown>) => [String(args.path)],
          },
        } as RegisteredTool,
        async () => "ok",
      );
      const executor = new ToolExecutor(
        registry,
        new PermissionClassifier([], "bypassPermissions"),
        new HookRegistry(),
      );
      let asks = 0;
      executor.setContext({
        cwd: main,
        workspace: createWorkspaceContext({
          projectId: "project-1",
          projectRevision: 1,
          sessionMainRootId: "main",
          roots: [
            { id: "main", path: main, role: "primary" },
            { id: "secondary", path: secondary, role: "secondary" },
          ],
        }),
        askUser: async () => {
          asks += 1;
          return "拒绝";
        },
      } as unknown as ToolContext);

      for (const name of ["Read", "Write", "Edit", "Glob", "Grep", "Compound"]) {
        const call: ToolCall = {
          id: name,
          toolName: name,
          args: { path: join(secondary, `${name}.txt`) },
        };
        expect((await executor.executeSingle(call)).isError).not.toBe(true);
      }
      expect(asks).toBe(0);
      expect(
        (await executor.executeSingle({
          id: "outside",
          toolName: "Read",
          args: { path: join(outside, "secret.txt") },
        })).isError,
      ).toBe(true);
      expect(asks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
