import { describe, expect, test } from "bun:test";
import { browserInspectTool } from "./browser-inspect.js";
import { browserActTool } from "./browser-tools.js";
import type { ToolContext } from "../context.js";

describe("developer browser tools", () => {
  test("rejects unsupported modes without reaching the page", async () => {
    let calls = 0;
    const ctx = {
      browser: {
        inspect: async () => {
          calls++;
          return { ok: true };
        },
      },
    } as unknown as ToolContext;
    expect(
      await browserInspectTool({ mode: "evaluate", expression: "fetch('/delete')" }, ctx),
    ).toContain("unsupported");
    expect(calls).toBe(0);
  });

  test("forwards bounded options and omits arbitrary protocol fields", async () => {
    let observed: unknown;
    const ctx = {
      browser: {
        inspect: async (options: unknown) => {
          observed = options;
          return { ok: true, mode: "dom", data: { nodes: [] } };
        },
      },
    } as unknown as ToolContext;
    await browserInspectTool(
      { mode: "dom", selector: "#main", max_entries: 10000, expression: "bad" },
      ctx,
    );
    expect(observed).toEqual({ mode: "dom", selector: "#main", maxEntries: 100 });
  });

  test("resuming is explicit and requires a new snapshot", async () => {
    let resumed = 0;
    const ctx = {
      browser: {
        resumeControl: async () => {
          resumed++;
          return { ok: true };
        },
      },
    } as unknown as ToolContext;
    expect(await browserActTool({ action: "resume_control" }, ctx)).toContain("new snapshot");
    expect(resumed).toBe(1);
    expect(await browserInspectTool({ mode: "dom" })).toContain("unavailable");
  });
});
