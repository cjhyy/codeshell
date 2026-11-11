import type { ToolDefinition } from "../../types.js";

/** The executor resolves this static wire wrapper before applying tool policy. */
export const callToolDef: ToolDefinition = {
  name: "CallTool",
  description:
    "Call a tool whose schema was returned by ToolSearch. " +
    "Pass the exact tool name and an args object that matches that schema.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name from ToolSearch." },
      args: { type: "object", description: "Arguments matching the tool's schema." },
    },
    required: ["name", "args"],
  },
};
