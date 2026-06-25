/**
 * Regression: a tool whose path-policy `arg` is an ARRAY of paths (e.g.
 * GenerateImage's `referenceImages`, GenerateVideo's `images`) must have EACH
 * element run through the path-policy layer. resolvePathPolicyTargets used to
 * only accept a string arg — an array yielded zero targets, so out-of-workspace
 * reads bypassed the "ask" gate that Read/Write enforce.
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
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ppa-ws-"));
  outside = mkdtempSync(join(tmpdir(), "ppa-out-"));
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

/** A tool that reads an array-of-paths arg, declaring path-policy on it. */
function makeArrayPathTool(): RegisteredTool {
  return {
    name: "ReadMany",
    description: "test tool: reads an array of file paths",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } } },
      required: ["paths"],
    },
    source: "builtin",
    permissionDefault: "allow",
    pathPolicy: [{ kind: "arg", arg: "paths", operation: "read" }],
  } as unknown as RegisteredTool;
}

async function execute(call: ToolCall, ctx: ToolContext): Promise<string> {
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(makeArrayPathTool(), async () => "ok");
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    new HookRegistry(),
  );
  executor.setContext(ctx);
  const result = await executor.executeSingle(call);
  return result.error ?? result.result ?? "";
}

describe("path-policy enforces each element of an array path arg", () => {
  test("an outside-workspace element triggers the approval gate (denied → refused)", async () => {
    writeFileSync(join(outside, "ref.png"), "x");
    const denied = ctxWith("拒绝");
    const r = await execute(
      { id: "c1", toolName: "ReadMany", args: { paths: [join(outside, "ref.png")] } },
      denied.ctx,
    );
    expect(denied.asked()).toBe(1); // the array element was checked
    expect(String(r)).toMatch(/path approval denied|blocked by path policy/i);
  });

  test("an in-workspace array element does not prompt", async () => {
    writeFileSync(join(workspace, "ok.png"), "x");
    const approved = ctxWith("允许本次");
    await execute(
      { id: "c2", toolName: "ReadMany", args: { paths: ["ok.png"] } },
      approved.ctx,
    );
    expect(approved.asked()).toBe(0); // in-workspace → allow, no prompt
  });
});
