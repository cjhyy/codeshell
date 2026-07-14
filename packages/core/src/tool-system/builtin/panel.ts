import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";

export const panelToolDef: ToolDefinition = {
  name: "Panel",
  description:
    "List or open/focus a panel in the interactive host. Use action='list' to discover " +
    "stable panel ids, then action='open' with panel_id. Opening a panel only changes the " +
    "host UI; use that panel plugin's own tools to perform domain work.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "open"],
        description: "Whether to list available panels or open/focus one.",
      },
      panel_id: {
        type: "string",
        description: "Stable id returned by action='list'. Required for action='open'.",
      },
    },
    required: ["action"],
  },
};

const NO_PANEL_HOST =
  "Error: panel hosting is not available in this session. This tool requires an interactive Desktop host.";

export async function panelTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const bridge = ctx?.panels;
  if (!bridge) return NO_PANEL_HOST;

  const action = args.action;
  if (action === "list") {
    const panels = await bridge.list();
    if (panels.length === 0) return "(no panels available)";
    return panels.map((panel) => `${panel.id}\t${panel.title}\t${panel.source}`).join("\n");
  }
  if (action === "open") {
    const panelId = typeof args.panel_id === "string" ? args.panel_id.trim() : "";
    if (!panelId) return "Error: panel_id is required for action='open'";
    const result = await bridge.open(panelId);
    return result.ok
      ? `Opened panel ${result.panelId}`
      : `Error: ${result.detail ?? `could not open panel ${panelId}`}`;
  }
  return `Error: unknown panel action '${String(action)}'`;
}
