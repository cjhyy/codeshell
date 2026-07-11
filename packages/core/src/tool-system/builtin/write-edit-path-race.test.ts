import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../../hooks/registry.js";
import type { ToolCall, ToolResult } from "../../types.js";
import type { ToolContext } from "../context.js";
import { ToolExecutor } from "../executor.js";
import type { ApprovalBackend } from "../permission.js";
import { PermissionClassifier } from "../permission.js";
import { ToolRegistry } from "../registry.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "write-edit-path-race-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function executorWithApproval(onApproval?: () => void): ToolExecutor {
  const backend: ApprovalBackend = {
    requestApproval: async () => {
      onApproval?.();
      return { approved: true };
    },
  };
  const executor = new ToolExecutor(
    new ToolRegistry(),
    new PermissionClassifier([], "default", backend),
    new HookRegistry(),
  );
  executor.setContext({ cwd: workspace, permissionMode: "default" } as ToolContext);
  return executor;
}

function replaceParentWithOutsideSymlink(parent: string): void {
  renameSync(parent, `${parent}-original`);
  symlinkSync(outside, parent, "dir");
}

async function execute(executor: ToolExecutor, call: ToolCall): Promise<ToolResult> {
  return executor.executeSingle(call);
}

describe("Write/Edit revalidate the final write target after approval", () => {
  it("Write refuses when an approved in-workspace parent becomes an outside symlink", async () => {
    const parent = join(workspace, "parent");
    const target = join(parent, "new.txt");
    const outsideTarget = join(outside, "new.txt");
    mkdirSync(parent);
    const executor = executorWithApproval(() => replaceParentWithOutsideSymlink(parent));

    const result = await execute(executor, {
      id: "write-race",
      toolName: "Write",
      args: { file_path: target, content: "must stay inside" },
    });

    expect(result.result).toMatch(/^Error:/);
    expect(existsSync(outsideTarget)).toBe(false);
    expect(existsSync(join(`${parent}-original`, "new.txt"))).toBe(false);
  });

  it("Edit refuses when an approved in-workspace parent becomes an outside symlink", async () => {
    const parent = join(workspace, "parent");
    const target = join(parent, "edit.txt");
    const outsideTarget = join(outside, "edit.txt");
    mkdirSync(parent);
    writeFileSync(target, "before\n");
    writeFileSync(outsideTarget, "before\n");
    const executor = executorWithApproval(() => replaceParentWithOutsideSymlink(parent));

    const result = await execute(executor, {
      id: "edit-race",
      toolName: "Edit",
      args: { file_path: target, old_string: "before", new_string: "after" },
    });

    expect(result.result).toMatch(/^Error:/);
    expect(readFileSync(outsideTarget, "utf-8")).toBe("before\n");
    expect(readFileSync(join(`${parent}-original`, "edit.txt"), "utf-8")).toBe("before\n");
  });

  it("keeps normal in-workspace Write creation and parent-directory creation working", async () => {
    const target = join(workspace, "nested", "deep", "new.txt");

    const result = await execute(executorWithApproval(), {
      id: "write-normal",
      toolName: "Write",
      args: { file_path: target, content: "created" },
    });

    expect(result.result).toContain("Successfully wrote");
    expect(readFileSync(target, "utf-8")).toBe("created");
  });

  it("keeps normal in-workspace Edit working", async () => {
    const target = join(workspace, "edit.txt");
    writeFileSync(target, "before\n");

    const result = await execute(executorWithApproval(), {
      id: "edit-normal",
      toolName: "Edit",
      args: { file_path: target, old_string: "before", new_string: "after" },
    });

    expect(result.result).toContain("Successfully edited");
    expect(readFileSync(target, "utf-8")).toBe("after\n");
  });
});
