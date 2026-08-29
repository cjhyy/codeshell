/**
 * ConfigTool — read or update project settings.
 */

import type { ToolDefinition } from "../../types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, setDottedSetting } from "../../settings/manager.js";
import type { ToolContext } from "../context.js";
import { enforcePathPolicyWithApproval } from "../path-policy.js";

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

export interface ConfigToolDeps {
  makeSettingsManager(cwd: string, scope: "full" | "project"): SettingsManager;
  /** Test seam: awaited inside the write path, after the key/value checks and
   *  before the value is persisted, so a test can park one writer in the
   *  read→write window and drive a deterministic interleaving. */
  beforeWrite?: () => Promise<void>;
}

const DEFAULT_DEPS: ConfigToolDeps = {
  makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
};

/** Factory so tests can inject a SettingsManager (barrier/fake); production
 *  uses the default instance-per-call, matching the other builtins. */
export function makeConfigTool(deps: ConfigToolDeps = DEFAULT_DEPS) {
  return async function configTool(
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<string> {
    return runConfigTool(args, ctx, deps);
  };
}

export async function configTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  return runConfigTool(args, ctx, DEFAULT_DEPS);
}

async function runConfigTool(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: ConfigToolDeps,
): Promise<string> {
  const action = args.action as string;
  const cwd = ctx?.cwd ?? process.cwd();
  const configPath = join(cwd, ".code-shell", "settings.json");

  if (action === "read") {
    const blocked = await enforcePathPolicyWithApproval(configPath, "read", ctx);
    if (blocked) return blocked;
    if (!existsSync(configPath)) {
      return "No project settings found. Use /init to create one.";
    }
    const content = readFileSync(configPath, "utf-8");
    return content;
  }

  if (action === "write") {
    const blocked = await enforcePathPolicyWithApproval(configPath, "write", ctx);
    if (blocked) return blocked;
    const key = args.key as string;
    const value = args.value;
    if (!key) return "Error: 'key' is required for write action.";
    if (value === undefined) return "Error: 'value' is required for write action.";

    // Validate the key BEFORE touching disk, preserving the existing contract
    // that an unsafe dotted key is rejected without creating settings.json.
    // setDottedSetting is the same validator saveProjectSetting applies inside
    // the lock; running it here on a throwaway object only surfaces the error.
    try {
      setDottedSetting({}, key, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }

    await deps.beforeWrite?.();

    // Never resurrect a deleted project root: a recursive mkdir of
    // <cwd>/.code-shell would recreate `cwd` itself as an empty shell when the
    // directory has been deleted (e.g. a stale session pointing at a removed
    // dir). If the project root is gone, the project is gone — don't write.
    if (!existsSync(cwd)) {
      return `Error: project directory does not exist: ${cwd}`;
    }

    // Persist through SettingsManager rather than a hand-rolled
    // read → modify → writeFileSync. That path had no lock and no temp+rename,
    // so two writers that both read before either wrote each persisted their
    // own stale snapshot and silently dropped the other's key (the class
    // documented in utils/file-mutex.ts). saveProjectSetting re-reads inside
    // the lock, writes atomically, and invalidates the merged cache so a
    // following read sees this write.
    // Both this and the old hand-rolled write throw on a hostile state dir (a
    // `.code-shell` that is a file or a link). Every other failure in this tool
    // is reported as a string, so keep that contract rather than letting the
    // exception escape into the tool executor.
    try {
      deps.makeSettingsManager(cwd, "project").saveProjectSetting(key, value, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }

    return `Updated ${key} = ${JSON.stringify(value)}`;
  }

  return `Unknown action: ${action}. Use 'read' or 'write'.`;
}
