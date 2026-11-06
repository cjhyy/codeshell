/**
 * TODO 5.1 unification: glob / grep must route a
 * path-policy "ask" through the interactive approval prompt (like read/write/
 * edit already do), so "用户批准路径后，原工具继续执行". Previously these four
 * used the non-approval enforcePathPolicy that hard-refused on "ask".
 * Reads (including outside the workspace) are never gated any more.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../context.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionClassifier } from "../permission.js";
import { HookRegistry } from "../../hooks/registry.js";
import type { ToolCall } from "../../types.js";

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "pp-ws-"));
  outside = mkdtempSync(join(tmpdir(), "pp-out-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
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

async function execute(call: ToolCall, ctx: ToolContext): Promise<string> {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    new HookRegistry(),
  );
  executor.setContext(ctx);
  const result = await executor.executeSingle(call);
  return result.error ?? result.result ?? "";
}

describe("glob / grep read outside the workspace without prompting", () => {
  test("glob lists an outside directory", async () => {
    writeFileSync(join(outside, "hit.txt"), "x");
    const denied = ctxWith("拒绝"); // would refuse IF wrongly asked
    const r = await execute(
      { id: "c1", toolName: "Glob", args: { pattern: "*", path: outside } },
      denied.ctx,
    );
    expect(denied.asked()).toBe(0);
    expect(String(r)).toContain("hit.txt");
  });

  test("grep searches an outside directory", async () => {
    writeFileSync(join(outside, "f.txt"), "needle here");
    const denied = ctxWith("拒绝");
    const r = await execute(
      { id: "c1", toolName: "Grep", args: { pattern: "needle", path: outside } },
      denied.ctx,
    );
    expect(denied.asked()).toBe(0);
    expect(String(r)).toContain("f.txt");
  });
});
