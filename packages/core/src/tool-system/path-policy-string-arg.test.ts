/**
 * Regression (#9): a tool whose path-policy `arg` is a SINGLE STRING (e.g.
 * Read/Write/Edit `file_path`, Grep/Glob `path`) must resolve a RELATIVE path
 * against ctx.cwd before classification — exactly like the array branch and the
 * apply_patch branch already do. resolvePathPolicyTargets used to `return [raw]`
 * verbatim for the string case, so classifyPath fell back to process.cwd()-based
 * resolution and mis-placed an in-workspace relative path as "outside workspace",
 * over-prompting on routine in-workspace reads/writes.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./context.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolCall, RegisteredTool } from "../types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "pps-ws-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function ctxWith(answer: string): { ctx: ToolContext; asked: () => number } {
  let count = 0;
  const ctx = {
    cwd: workspace,
    planMode: false,
    askUser: async () => {
      count++;
      return answer;
    },
  } as unknown as ToolContext;
  return { ctx, asked: () => count };
}

/** A tool that reads a single string path arg, declaring path-policy on it. */
function makeStringPathTool(operation: "read" | "write"): RegisteredTool {
  return {
    name: "ReadOne",
    description: "test tool: reads a single file path",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
    source: "builtin",
    permissionDefault: "allow",
    pathPolicy: [{ kind: "arg", arg: "file_path", operation }],
  } as unknown as RegisteredTool;
}

async function execute(
  call: ToolCall,
  ctx: ToolContext,
  operation: "read" | "write" = "read",
): Promise<string> {
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(makeStringPathTool(operation), async () => "ok");
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    new HookRegistry(),
  );
  executor.setContext(ctx);
  const result = await executor.executeSingle(call);
  return result.error ?? result.result ?? "";
}

describe("path-policy resolves a single-string relative path arg against ctx.cwd", () => {
  test("an in-workspace RELATIVE path does not prompt (the #9 over-prompt bug)", async () => {
    writeFileSync(join(workspace, "ok.txt"), "x");
    const approved = ctxWith("拒绝"); // would refuse IF wrongly asked
    const r = await execute(
      { id: "c1", toolName: "ReadOne", args: { file_path: "ok.txt" } },
      approved.ctx,
    );
    expect(approved.asked()).toBe(0); // in-workspace → allow, no prompt
    expect(String(r)).toBe("ok");
  });

  test("a genuinely outside-workspace absolute path still prompts", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pps-out-"));
    try {
      writeFileSync(join(outside, "x.txt"), "x");
      const denied = ctxWith("拒绝");
      const r = await execute(
        { id: "c2", toolName: "ReadOne", args: { file_path: join(outside, "x.txt") } },
        denied.ctx,
      );
      expect(denied.asked()).toBe(1);
      expect(String(r)).toMatch(/path approval denied|blocked by path policy/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
