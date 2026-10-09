import { isClosedInlineHook } from "../hooks/configured-tool-hooks.js";
import { createConstrainedDockerProcessHost } from "../runtime/constrained-process/docker.js";
import { sha256 } from "../runtime/constrained-process/resources.js";
import type { ConstrainedDockerRuntime } from "../runtime/constrained-process/types.js";
import type { OperationHookProcesses } from "./operation-hooks.js";

/**
 * Native Host startup configuration, never merged project Settings/env and
 * never accepted by IPC. The explicit command hashes approve finite literal
 * inline code only. Installed-plugin resource authority is not inferred here.
 */
export function createOperationHookHost(configuration: string | undefined):
  | {
      hookProcesses: OperationHookProcesses;
      dispose(): Promise<void>;
    }
  | undefined {
  if (configuration === undefined) return undefined;
  if (configuration.length > 32768) throw new Error("Invalid operation Hook Host configuration");
  const parsed = JSON.parse(configuration) as {
    runtime: ConstrainedDockerRuntime;
    inlineCommandSha256: string[];
  };
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "inlineCommandSha256,runtime" ||
    !Array.isArray(parsed.inlineCommandSha256) ||
    parsed.inlineCommandSha256.length > 256 ||
    parsed.inlineCommandSha256.some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("Invalid operation Hook Host configuration");
  const allowed = new Set(parsed.inlineCommandSha256);
  const host = createConstrainedDockerProcessHost(parsed.runtime);
  return {
    hookProcesses: {
      host,
      resolveClosure(hook) {
        if (
          hook.cwd !== undefined ||
          !allowed.has(sha256(hook.command)) ||
          !isClosedInlineHook(hook.command)
        )
          return undefined;
        return {};
      },
    },
    dispose: () => host.dispose(),
  };
}
