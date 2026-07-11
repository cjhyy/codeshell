import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import type { RegisteredTool, ToolCall } from "../types.js";
import { ArtifactTracker } from "../run/ArtifactTracker.js";
import type { RunStore } from "../run/RunStore.js";
import type { RunArtifactRef } from "../run/types.js";
import { bashTool } from "./builtin/bash.js";
import { createOffBackend } from "./sandbox/off.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";

const writeDefinition: RegisteredTool = {
  name: "Write",
  description: "protocol probe",
  inputSchema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
  source: "builtin",
  permissionDefault: "allow",
  pathPolicy: [{ kind: "arg", arg: "file_path", operation: "write" }],
};

function call(): ToolCall {
  return { id: "write-1", toolName: "Write", args: { file_path: "out.txt" } };
}

describe("ToolRegistry result protocol", () => {
  it("maps an explicit ToolFailure to an error result", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      writeDefinition,
      async () =>
        ({
          ok: false,
          error: "disk full",
        }) as never,
    );

    const result = await registry.executeTool("Write", { file_path: "out.txt" });

    expect(result.isError).toBe(true);
    expect(result.error).toBe("disk full");
    expect(result.result).toBeUndefined();
  });

  it("keeps Error:-prefixed legacy strings on the failure path", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(writeDefinition, async () => "Error: legacy write failed");

    const result = await registry.executeTool("Write", { file_path: "out.txt" });

    expect(result.isError).toBe(true);
    expect(result.error).toBe("Error: legacy write failed");
  });

  it("does not emit file_changed when Write returns ToolFailure", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      writeDefinition,
      async () =>
        ({
          ok: false,
          error: "write rejected",
        }) as never,
    );
    const hooks = new HookRegistry();
    let fileChanged = 0;
    let observedError: string | undefined;
    hooks.register("file_changed", async () => {
      fileChanged++;
      return {};
    });
    hooks.register("on_tool_end", async (ctx) => {
      observedError = ctx.data.error as string | undefined;
      return {};
    });
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "bypassPermissions"),
      hooks,
    );

    const result = await executor.executeSingle(call());

    expect(result.isError).toBe(true);
    expect(result.error).toBe("write rejected");
    expect(observedError).toBe("write rejected");
    expect(fileChanged).toBe(0);
  });

  it("returns timeout for a handler that never settles", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(writeDefinition, async () => new Promise<never>(() => {}));

    const observed = await Promise.race([
      registry.executeTool("Write", { file_path: "out.txt" }, { timeoutMs: 10 }),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);

    expect(observed).not.toBe("hung");
    expect(observed).toMatchObject({ isError: true });
    expect((observed as { error?: string }).error).toMatch(/timed out/i);
  });

  it("discards a handler success that arrives after timeout or parent abort", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(writeDefinition, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, result: "late success" };
    });

    const timedOut = await registry.executeTool(
      "Write",
      { file_path: "out.txt" },
      { timeoutMs: 5 },
    );
    const controller = new AbortController();
    const abortedPending = registry.executeTool(
      "Write",
      { file_path: "out.txt" },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    const aborted = await abortedPending;

    expect(timedOut).toMatchObject({ isError: true });
    expect(timedOut.error).toMatch(/timed out/i);
    expect(aborted).toMatchObject({ isError: true });
    expect(aborted.error).toMatch(/aborted/i);
  });

  it("normalizes non-Error: strings and object error flags as failures", async () => {
    const variants: unknown[] = [
      "LSP error: server unavailable",
      "MCP tool error: rejected",
      "REPL aborted by signal",
      "REPL timed out after 100ms",
      'Skill "missing" not found. Run /skills to list available skills.',
      'Skill "disabled" is disabled. Enable it in Customize.',
      'Skill "denied" is not available to this sub-agent.',
      { error: "structured failure" },
      { isError: true, result: "flagged failure" },
    ];

    for (const [index, variant] of variants.entries()) {
      const registry = new ToolRegistry({ builtinTools: [] });
      registry.registerTool(
        { ...writeDefinition, name: `Probe${index}` },
        async () => variant as never,
      );
      const result = await registry.executeTool(`Probe${index}`, { file_path: "out.txt" });
      expect(result.isError).toBe(true);
      expect(result.error).toBeTruthy();
    }
  });

  it("marks successful results explicitly with isError:false", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(writeDefinition, async () => ({ ok: true, result: "ok" }));

    expect(await registry.executeTool("Write", { file_path: "out.txt" })).toMatchObject({
      result: "ok",
      isError: false,
    });
  });
});

describe("Bash failure artifact semantics", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns ToolFailure metadata for exit 7 and does not record a redirect artifact", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bash-failure-artifact-"));
    dirs.push(cwd);
    const direct = await bashTool({ command: "printf boom >&2; exit 7" }, {
      cwd,
      sandbox: createOffBackend(),
    } as never);
    expect(direct).toMatchObject({
      ok: false,
      exitCode: 7,
      signal: null,
      stderr: "boom",
    });
    expect(typeof direct !== "string" && !direct.ok ? direct.error : "").toContain("Exit code: 7");

    const registry = new ToolRegistry({ builtinTools: ["Bash"] });
    const command = "sh -c 'exit 7' > failed.txt";
    const result = await registry.executeTool(
      "Bash",
      { command },
      { ctx: { cwd, sandbox: createOffBackend() } as never },
    );
    const refs: RunArtifactRef[] = [];
    const tracker = new ArtifactTracker({
      runId: "run-1",
      store: {
        appendArtifactRef: async (ref: RunArtifactRef) => {
          refs.push(ref);
        },
      } as RunStore,
    });
    await tracker.onStreamEvent({
      type: "tool_use_start",
      toolCall: { id: result.id, toolName: "Bash", args: { command } },
    });
    await tracker.onStreamEvent({ type: "tool_result", result });

    expect(result.isError).toBe(true);
    expect(refs).toEqual([]);
  });
});
