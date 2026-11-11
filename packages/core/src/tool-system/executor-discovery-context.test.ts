import { expect, test } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import { joinToolResultText, toolDiscoverySchemaBlock } from "../utils/tool-schema-discovery.js";
import type { ToolResult } from "../types.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";
import type { InvestigationGuard } from "./investigation-guard.js";
import type { ToolContext } from "./context.js";
import { RunToolSurface } from "./run-tool-surface.js";

const schema = toolDiscoverySchemaBlock({
  name: "Discovered",
  description: "fixture",
  inputSchema: { type: "object", properties: {} },
});

async function execute(output: {
  result?: string;
  contentBlocks?: ToolResult["contentBlocks"];
  ok?: boolean;
  error?: string;
}) {
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(
    {
      name: "ToolSearch",
      description: "fixture",
      inputSchema: { type: "object" },
      source: "builtin",
      permissionDefault: "allow",
      pathPolicyExempt: true,
    },
    async () => output,
  );
  const hooks = new HookRegistry();
  hooks.register("post_tool_use", () => ({ additionalContext: "Post-hook reminder." }));
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    hooks,
  );
  executor.setInvestigationGuard({
    preToolCheck: () => ({ prepend: "Guard reminder." }),
  } as InvestigationGuard);
  return executor.executeSingle({ id: "discover", toolName: "ToolSearch", args: {} });
}

test("guard and post-hook context survive structured discovery without changing schema annotations", async () => {
  const contentBlocks = [schema, { type: "text" as const, text: "\n\nUse the exact tool name." }];
  const original = structuredClone(contentBlocks);
  const result = await execute({ result: joinToolResultText(contentBlocks, ""), contentBlocks });
  expect(result.isError).toBe(false);
  expect(result.result).toBe(
    "Guard reminder.\n" +
      schema.text +
      "\n\nUse the exact tool name.\n\n--- additional context from post_tool_use hook ---\nPost-hook reminder.",
  );
  expect(joinToolResultText(result.contentBlocks!, "\n\n")).toBe(result.result);
  expect(result.contentBlocks![0]).toEqual({ type: "text", text: "Guard reminder.\n" });
  expect(result.contentBlocks![1]).toEqual(schema);
  expect(result.contentBlocks!.at(-1)?.discoveredTool).toBeUndefined();
  expect(contentBlocks).toEqual(original);
});

test("plain-string tool result retains its existing contract", async () => {
  const result = await execute({ result: "plain output" });
  expect(result.contentBlocks).toBeUndefined();
  expect(result.result).toBe(
    "Guard reminder.\nplain output\n\n" +
      "--- additional context from post_tool_use hook ---\nPost-hook reminder.",
  );
});

test("media blocks keep order and identity when guard and post-hook text is attached", async () => {
  const image = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "fixture" },
  };
  const result = await execute({
    result: "caption",
    contentBlocks: [{ type: "text", text: "caption" }, image],
  });
  expect(result.contentBlocks?.map((block) => block.type)).toEqual([
    "text",
    "text",
    "image",
    "text",
  ]);
  expect(result.contentBlocks?.[2]).toBe(image);
  expect(result.contentBlocks?.at(-1)?.text).toContain("Post-hook reminder.");
});

test("failed tool results receive no success guard or post-hook context", async () => {
  const result = await execute({ ok: false, error: "fixture rejected" });
  expect(result.isError).toBe(true);
  expect(result.error).toBe("fixture rejected");
  expect(result.contentBlocks).toBeUndefined();
});

test("a deferred wire declaration grants no execution until discovery and still obeys revocation", async () => {
  let calls = 0;
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(
    {
      name: "Deferred",
      description: "fixture",
      inputSchema: { type: "object" },
      source: "builtin",
      permissionDefault: "allow",
      pathPolicyExempt: true,
    },
    async () => {
      calls++;
      return "executed";
    },
  );
  const search = { name: "ToolSearch", description: "fixture", inputSchema: { type: "object" } };
  const surface = new RunToolSurface([], { toolDiscovery: "tool-reference" });
  surface.updateCatalog([search, ...registry.getToolDefinitions()]);
  const request = JSON.stringify(surface.requestSnapshot());
  expect(surface.requestSnapshot().find((tool) => tool.name === "Deferred")?.deferLoading).toBe(
    true,
  );
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    new HookRegistry(),
  );
  executor.setContext({ runToolSurface: surface } as ToolContext);
  const call = { id: "deferred", toolName: "Deferred", args: {} };
  const denied = await executor.executeSingle(call);
  expect(denied.isError).toBe(true);
  expect(denied.error).toContain("ToolSearch");
  expect(calls).toBe(0);
  surface.select(["Deferred"]);
  expect((await executor.executeSingle(call)).isError).toBe(false);
  expect(calls).toBe(1);
  surface.updateCatalog([search]);
  expect((await executor.executeSingle(call)).isError).toBe(true);
  expect(calls).toBe(1);
  expect(JSON.stringify(surface.requestSnapshot())).toBe(request);
});
