/**
 * Wiring for the Computer Use spike: decides whether the embedded Cua Driver
 * runs, and what the worker sees as the host-owned MCP server.
 *
 * Off unless the user-level flag `computer_use_cua` is on, the platform is
 * macOS and a cua-driver executable is found. When off, the worker env value
 * is always cleared so an inherited shell variable cannot inject servers.
 */
import {
  encodeHostMcpServers,
  isFeatureEnabled,
  type FeatureFlagOverrides,
} from "@cjhyy/code-shell-core/extension";
import {
  CUA_HOST_MCP_SERVER_NAME,
  CuaDriverHost,
  resolveCuaDriverPath,
  type CuaDriverHostOptions,
} from "./cua-driver-host.js";

export const CODESHELL_BUNDLE_ID = "com.cjhyy.codeshell";

let host: CuaDriverHost | undefined;

export interface CuaComputerUseInputs {
  readonly flags: FeatureFlagOverrides;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: CuaDriverHostOptions["log"];
  readonly createHost?: (options: CuaDriverHostOptions) => CuaDriverHost;
}

export type CuaComputerUseDecision =
  | { readonly enabled: false; readonly reason: "flag_off" | "unsupported_platform" | "driver_not_found" }
  | { readonly enabled: true; readonly host: CuaDriverHost };

/** Create (but do not start) the process-wide host when every gate passes. */
export function initCuaComputerUse(inputs: CuaComputerUseInputs): CuaComputerUseDecision {
  if (!isFeatureEnabled(inputs.flags, "computer_use_cua")) return { enabled: false, reason: "flag_off" };
  // Windows/Linux embedding exists upstream but is out of scope for the spike.
  if (inputs.platform !== "darwin") return { enabled: false, reason: "unsupported_platform" };
  const driverPath = resolveCuaDriverPath({
    env: inputs.env ?? process.env,
    isPackaged: inputs.isPackaged,
    resourcesPath: inputs.resourcesPath,
  });
  if (!driverPath) return { enabled: false, reason: "driver_not_found" };
  const options: CuaDriverHostOptions = {
    driverPath,
    hostBundleId: CODESHELL_BUNDLE_ID,
    log: inputs.log,
  };
  host = (inputs.createHost ?? ((o) => new CuaDriverHost(o)))(options);
  return { enabled: true, host };
}

export function getCuaDriverHost(): CuaDriverHost | undefined {
  return host;
}

/** Test seam and shutdown helper. */
export function resetCuaComputerUse(): void {
  host = undefined;
}

/**
 * Value for CODE_SHELL_HOST_MCP_SERVERS on each worker spawn. `undefined`
 * deletes any inherited value when the spike is off.
 */
export function hostMcpServersEnv(current: CuaDriverHost | undefined = host): string | undefined {
  if (!current) return undefined;
  const state = current.status().state;
  if (state === "stopped" || state === "failed") return undefined;
  return encodeHostMcpServers({ [CUA_HOST_MCP_SERVER_NAME]: current.mcpDeclaration() });
}
