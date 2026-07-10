/** CronList tool metadata, shared by registration and presets. */

import type { ToolDefinition } from "../../types.js";

export const cronListToolDef: ToolDefinition = {
  name: "CronList",
  description: "List all scheduled cron jobs.",
  inputSchema: { type: "object", properties: {} },
};
