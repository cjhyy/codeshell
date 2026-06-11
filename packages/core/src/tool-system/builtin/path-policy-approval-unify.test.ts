/**
 * TODO 5.1 unification: notebook-edit / apply-patch / glob / grep must route a
 * path-policy "ask" through the interactive approval prompt (like read/write/
 * edit already do), so "用户批准路径后，原工具继续执行". Previously these four
 * used the non-approval enforcePathPolicy that hard-refused on "ask".
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("glob routes outside-workspace ask through approval", () => {
  test("denied → refuses; approved → proceeds", async () => {
    const denied = ctxWith("拒绝");
    const r1 = await execute(
      { id: "c1", toolName: "Glob", args: { pattern: "*", path: outside } },
      denied.ctx,
    );
    expect(denied.asked()).toBe(1);
    expect(String(r1)).toMatch(/path approval denied|blocked by path policy/i);

    writeFileSync(join(outside, "hit.txt"), "x");
    const approved = ctxWith("允许本次");
    const r2 = await execute(
      { id: "c2", toolName: "Glob", args: { pattern: "*", path: outside } },
      approved.ctx,
    );
    expect(approved.asked()).toBe(1);
    expect(String(r2)).not.toMatch(/path approval denied/i);
  });
});

describe("grep routes outside-workspace ask through approval", () => {
  test("denied → refuses; approved → proceeds", async () => {
    writeFileSync(join(outside, "f.txt"), "needle here");
    const denied = ctxWith("拒绝");
    const r1 = await execute(
      { id: "c1", toolName: "Grep", args: { pattern: "needle", path: outside } },
      denied.ctx,
    );
    expect(denied.asked()).toBe(1);
    expect(String(r1)).toMatch(/path approval denied|blocked by path policy/i);

    const approved = ctxWith("允许本次");
    const r2 = await execute(
      { id: "c2", toolName: "Grep", args: { pattern: "needle", path: outside } },
      approved.ctx,
    );
    expect(approved.asked()).toBe(1);
    expect(String(r2)).not.toMatch(/path approval denied/i);
  });
});

describe("notebook-edit routes outside-workspace ask through approval", () => {
  test("denied → refuses", async () => {
    const nb = join(outside, "n.ipynb");
    writeFileSync(
      nb,
      JSON.stringify({ cells: [{ cell_type: "code", source: ["x"] }], nbformat: 4, nbformat_minor: 5, metadata: {} }),
    );
    const denied = ctxWith("拒绝");
    const r1 = await execute(
      {
        id: "c1",
        toolName: "NotebookEdit",
        args: { file_path: nb, action: "replace", cell_index: 0, source: "y" },
      },
      denied.ctx,
    );
    expect(denied.asked()).toBe(1);
    expect(String(r1)).toMatch(/path approval denied|blocked by path policy/i);
  });
});

describe("apply-patch routes outside-workspace ask through approval", () => {
  test("denied → refuses", async () => {
    const target = join(outside, "p.txt");
    writeFileSync(target, "old\n");
    const patch = `*** Begin Patch
*** Update File: ${target}
@@
-old
+new
*** End Patch`;
    const denied = ctxWith("拒绝");
    const r1 = await execute(
      { id: "c1", toolName: "ApplyPatch", args: { patch } },
      denied.ctx,
    );
    expect(denied.asked()).toBeGreaterThanOrEqual(1);
    expect(String(r1)).toMatch(/path approval denied|blocked by path policy/i);
  });
});
