import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HookRegistry,
  PermissionClassifier,
  ToolExecutor,
  ToolRegistry,
  type ToolCall,
  type ToolContext,
} from "@cjhyy/code-shell-core";
import { CODING_TOOLS } from "./index.js";

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "coding-path-ws-"));
  outside = mkdtempSync(join(tmpdir(), "coding-path-out-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function rejectingContext(): { context: ToolContext; asked: () => number } {
  let count = 0;
  return {
    context: {
      cwd: workspace,
      planMode: false,
      askUser: async () => {
        count++;
        return "拒绝";
      },
    } as unknown as ToolContext,
    asked: () => count,
  };
}

async function execute(call: ToolCall, context: ToolContext): Promise<string> {
  const executor = new ToolExecutor(
    new ToolRegistry({ toolCatalog: CODING_TOOLS }),
    new PermissionClassifier([], "bypassPermissions"),
    new HookRegistry(),
  );
  executor.setContext(context);
  const result = await executor.executeSingle(call);
  return result.error ?? result.result ?? "";
}

describe("coding capability path policy", () => {
  test("NotebookEdit routes an outside path through approval", async () => {
    const target = join(outside, "n.ipynb");
    writeFileSync(
      target,
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    );
    const rejected = rejectingContext();
    const result = await execute(
      {
        id: "notebook",
        toolName: "NotebookEdit",
        args: { file_path: target, action: "insert", source: "x" },
      },
      rejected.context,
    );
    expect(rejected.asked()).toBe(1);
    expect(result).toMatch(/path approval denied|blocked by path policy/i);
  });

  test("ApplyPatch uses its compound resolver before execution", async () => {
    const target = join(outside, "p.txt");
    writeFileSync(target, "old\n");
    const patch = `*** Begin Patch
*** Update File: ${target}
@@
-old
+new
*** End Patch`;
    const rejected = rejectingContext();
    const result = await execute(
      { id: "patch", toolName: "ApplyPatch", args: { patch } },
      rejected.context,
    );
    expect(rejected.asked()).toBeGreaterThanOrEqual(1);
    expect(result).toMatch(/path approval denied|blocked by path policy/i);
  });
});
