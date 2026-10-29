/**
 * Wiring for the Computer Use spike: decides whether the helper-owned Cua Driver
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
  resolveComputerUseBundle,
  type ComputerUseBundleOptions,
  type CuaDriverHostOptions,
} from "./cua-driver-host.js";
import type { ComputerActivityBus } from "./computer-activity-bus.js";
import type { InputGate } from "./input-gate.js";

let host: CuaDriverHost | undefined;

export interface CuaComputerUseInputs {
  readonly flags: FeatureFlagOverrides;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath?: string;
  readonly appPath?: string;
  readonly isExecutable?: ComputerUseBundleOptions["isExecutable"];
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: CuaDriverHostOptions["log"];
  readonly createHost?: (options: CuaDriverHostOptions) => CuaDriverHost;
  readonly mcpProxy?: CuaDriverHostOptions["mcpProxy"];
  /** The input gate lives in the proxy; without it the driver is not offered. */
  readonly requireProxy?: boolean;
}

export type CuaComputerUseDecision =
  | {
      readonly enabled: false;
      readonly reason:
        | "flag_off"
        | "unsupported_platform"
        | "driver_not_found"
        | "control_unavailable";
    }
  | { readonly enabled: true; readonly host: CuaDriverHost };

function disabled(
  reason: Extract<CuaComputerUseDecision, { enabled: false }>["reason"],
  log?: CuaDriverHostOptions["log"],
): CuaComputerUseDecision {
  void resetCuaComputerUse().catch((error) => {
    log?.("cua_driver_stop_failed", { error: String(error) });
  });
  return { enabled: false, reason };
}

/** Create (but do not start) the process-wide host when every gate passes. */
export function initCuaComputerUse(inputs: CuaComputerUseInputs): CuaComputerUseDecision {
  if (!isFeatureEnabled(inputs.flags, "computer_use_cua")) return disabled("flag_off", inputs.log);
  // Windows/Linux embedding exists upstream but is out of scope for the spike.
  if (inputs.platform !== "darwin") return disabled("unsupported_platform", inputs.log);
  const bundle = resolveComputerUseBundle({
    appPath: inputs.appPath,
    isExecutable: inputs.isExecutable,
    isPackaged: inputs.isPackaged,
    resourcesPath: inputs.resourcesPath,
  });
  if (!bundle) return disabled("driver_not_found", inputs.log);
  if (inputs.requireProxy && !inputs.mcpProxy) return disabled("control_unavailable", inputs.log);
  if (
    host &&
    host.status().driverPath === bundle.driverPath &&
    host.status().helperPath === bundle.helperPath &&
    host.status().state !== "stopped"
  ) {
    return { enabled: true, host };
  }
  // A changed executable replaces the registration immediately. The previous
  // host retains its own private socket until its bounded shutdown completes.
  void resetCuaComputerUse().catch((error) => {
    inputs.log?.("cua_driver_stop_failed", { error: String(error) });
  });
  const options: CuaDriverHostOptions = {
    ...bundle,
    parentEnv: inputs.env ?? process.env,
    log: inputs.log,
    mcpProxy: inputs.mcpProxy,
  };
  host = (inputs.createHost ?? ((o) => new CuaDriverHost(o)))(options);
  return { enabled: true, host };
}

export function getCuaDriverHost(): CuaDriverHost | undefined {
  return host;
}

let control: { gate: InputGate; bus: ComputerActivityBus } | undefined;

/** Registered by Desktop setup; undefined when the execution gate is absent. */
export function setComputerUseControl(
  value: { gate: InputGate; bus: ComputerActivityBus } | undefined,
): void {
  control = value;
}

function sessionIdOf(params: unknown): string | undefined {
  const value =
    params && typeof params === "object"
      ? (params as { sessionId?: unknown }).sessionId
      : undefined;
  return typeof value === "string" && value ? value : undefined;
}

/** Agent ingress: Stop refuses the Session's further input at the proxy, even
 * for calls already queued; the next run of that Session starts clean. */
export function observeComputerUseRunControl(
  message: { method?: unknown; params?: unknown },
  current = control,
): void {
  if (!current) return;
  const sessionId = sessionIdOf(message.params);
  if (!sessionId) return;
  if (message.method === "agent/cancel") current.gate.cancelSession(sessionId);
  else if (message.method === "agent/run") current.gate.clearSession(sessionId);
}

/** Worker stream: a top-level terminal event is the run's outcome. Only runs
 * that used the computer are presented by the character. A new top-level turn
 * also clears a cancel: a Stop may target one input while queued turns of the
 * same Session continue without another `agent/run`. */
export function observeComputerUseRunEvent(
  sessionId: string,
  value: unknown,
  current = control,
): void {
  if (!current || !value || typeof value !== "object") return;
  const event = value as { type?: unknown; agentId?: unknown; reason?: unknown };
  if (event.agentId) return;
  if (event.type === "session_started") current.gate.clearSession(sessionId);
  else if (event.type === "error") current.bus.publishRun(sessionId, "failed");
  else if (event.type === "turn_complete") {
    const reason = typeof event.reason === "string" ? event.reason : "";
    current.bus.publishRun(
      sessionId,
      reason === "completed" ? "completed" : reason.startsWith("aborted") ? "cancelled" : "failed",
    );
  }
}

/** Test seam and shutdown helper. */
export async function resetCuaComputerUse(): Promise<void> {
  const previous = host;
  host = undefined;
  await previous?.stop();
}

/**
 * Value for CODE_SHELL_HOST_MCP_SERVERS on each worker spawn. `undefined`
 * deletes any inherited value when the spike is off.
 */
export function hostMcpServersEnv(current: CuaDriverHost | undefined = host): string | undefined {
  if (!current) return undefined;
  const state = current.status().state;
  if (state !== "running") return undefined;
  return encodeHostMcpServers({ [CUA_HOST_MCP_SERVER_NAME]: current.mcpDeclaration() });
}
