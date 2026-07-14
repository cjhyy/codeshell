import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUILTIN_TOOLS } from "../builtin/index.js";
import { createToolRegistryHarness } from "./tool-registry-harness.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("shared ToolRegistry integration harness", () => {
  test("registers every builtin definition with an executor", () => {
    const harness = createToolRegistryHarness();
    const names = BUILTIN_TOOLS.map((tool) => tool.definition.name);

    expect(harness.registry.listTools()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of BUILTIN_TOOLS) {
      expect(harness.registry.hasExecutor(tool.definition.name)).toBe(true);
      expect(harness.registry.getTool(tool.definition.name)).toMatchObject({
        name: tool.definition.name,
        source: "builtin",
      });
    }
  });

  test("executes file/search tools through the real registry result protocol", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "tool-registry-harness-"));
    const harness = createToolRegistryHarness({
      cwd: tempRoot,
      builtinTools: ["Write", "Read", "Edit", "Glob", "Grep", "ToolSearch"],
    });

    const written = await harness.execute("Write", {
      file_path: "src/example.ts",
      content: "export const before = true;\n",
    });
    expect(written.isError).toBe(false);
    expect(readFileSync(join(tempRoot, "src", "example.ts"), "utf8")).toContain("before");

    const edited = await harness.execute("Edit", {
      file_path: "src/example.ts",
      old_string: "before",
      new_string: "after",
    });
    expect(edited.isError).toBe(false);

    const read = await harness.execute("Read", { file_path: "src/example.ts" });
    expect(read.result).toContain("after");
    const glob = await harness.execute("Glob", { pattern: "**/*.ts" });
    expect(glob.result).toContain("src/example.ts");
    const grep = await harness.execute("Grep", { pattern: "after", output_mode: "content" });
    expect(grep.result).toContain("after");
    const search = await harness.execute("ToolSearch", { query: "read file" });
    expect(search.result).toContain("Read");
  });

  test("injects host bridges without bypassing ToolRegistry", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "tool-registry-host-"));
    const opened: string[] = [];
    const harness = createToolRegistryHarness({
      cwd: tempRoot,
      builtinTools: ["AskUserQuestion", "Panel", "browser_observe"],
      overrides: {
        askUser: async () => "approved",
        panels: {
          list: async () => [{ id: "files", title: "Files", source: "code" }],
          open: async (panelId) => {
            opened.push(panelId);
            return { ok: true, panelId };
          },
        },
        browser: {
          snapshot: async () => ({
            url: "https://example.test",
            title: "Example",
            elements: [{ ref: "e1", role: "button", name: "Continue" }],
          }),
        } as any,
      },
    });

    expect((await harness.execute("AskUserQuestion", { question: "Continue?" })).result).toBe(
      "approved",
    );
    expect((await harness.execute("Panel", { action: "list" })).result).toContain("files");
    expect((await harness.execute("Panel", { action: "open", panel_id: "files" })).isError).toBe(
      false,
    );
    expect(opened).toEqual(["files"]);
    expect((await harness.execute("browser_observe", {})).result).toContain("example.test");
  });

  test("threads an abort signal through the registry into the fake context", async () => {
    const controller = new AbortController();
    const harness = createToolRegistryHarness({ builtinTools: [] });
    harness.registry.registerTool(
      {
        name: "AbortProbe",
        description: "wait for abort",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx) =>
        await new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );

    const pending = harness.registry.executeTool(
      "AbortProbe",
      {},
      {
        ctx: harness.context,
        signal: controller.signal,
      },
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      isError: true,
      error: "Tool aborted: AbortProbe",
    });
  });
});
