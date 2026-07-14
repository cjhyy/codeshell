import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../context.js";
import { panelTool } from "./panel.js";

function context(panels?: ToolContext["panels"]): ToolContext {
  return { panels } as unknown as ToolContext;
}

describe("Panel tool", () => {
  test("degrades outside an interactive panel host", async () => {
    expect(await panelTool({ action: "list" }, context())).toContain("not available");
  });

  test("lists host and plugin panel ids", async () => {
    const result = await panelTool(
      { action: "list" },
      context({
        list: async () => [
          { id: "quickChat", title: "Quick chat", source: "code" },
          {
            id: "plugin:insights@local:dashboard",
            title: "Build dashboard",
            source: "plugin",
          },
        ],
        open: async (panelId) => ({ ok: true, panelId }),
      }),
    );
    expect(result).toContain("quickChat\tQuick chat\tcode");
    expect(result).toContain("plugin:insights@local:dashboard");
  });

  test("opens a stable panel id through the host bridge", async () => {
    const opened: string[] = [];
    const panels: NonNullable<ToolContext["panels"]> = {
      list: async () => [],
      open: async (panelId) => {
        opened.push(panelId);
        return { ok: true, panelId };
      },
    };
    expect(await panelTool({ action: "open" }, context(panels))).toContain("panel_id is required");
    expect(await panelTool({ action: "open", panel_id: "quickChat" }, context(panels))).toBe(
      "Opened panel quickChat",
    );
    expect(opened).toEqual(["quickChat"]);
  });
});
