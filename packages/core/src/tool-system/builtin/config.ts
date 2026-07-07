/**
 * ConfigTool — read or update project settings.
 */

import type { ToolDefinition } from "../../types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setDottedSetting } from "../../settings/manager.js";

export const configToolDef: ToolDefinition = {
  name: "Config",
  description:
    "Read or update the project's .code-shell/settings.json configuration. " +
    "Use action 'read' to see current settings, or 'write' to update a key.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write"],
        description: "'read' to view settings, 'write' to update a key",
      },
      key: {
        type: "string",
        description: "Dot-notation key path (e.g. 'model.temperature'). Required for 'write'.",
      },
      value: {
        description: "Value to set. Required for 'write'.",
      },
    },
    required: ["action"],
  },
};

export async function configTool(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;
  const cwd = (args.__cwd as string) ?? process.cwd();
  const configPath = join(cwd, ".code-shell", "settings.json");

  if (action === "read") {
    if (!existsSync(configPath)) {
      return "No project settings found. Use /init to create one.";
    }
    const content = readFileSync(configPath, "utf-8");
    return content;
  }

  if (action === "write") {
    const key = args.key as string;
    const value = args.value;
    if (!key) return "Error: 'key' is required for write action.";
    if (value === undefined) return "Error: 'value' is required for write action.";

    // Read or create settings
    let settings: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      settings = JSON.parse(readFileSync(configPath, "utf-8"));
    }

    try {
      setDottedSetting(settings, key, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }

    // Never resurrect a deleted project root: a recursive mkdir of
    // <cwd>/.code-shell would recreate `cwd` itself as an empty shell when the
    // directory has been deleted (e.g. a stale session pointing at a removed
    // dir). If the project root is gone, the project is gone — don't write.
    if (!existsSync(cwd)) {
      return `Error: project directory does not exist: ${cwd}`;
    }
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(settings, null, 2), "utf-8");

    return `Updated ${key} = ${JSON.stringify(value)}`;
  }

  return `Unknown action: ${action}. Use 'read' or 'write'.`;
}
