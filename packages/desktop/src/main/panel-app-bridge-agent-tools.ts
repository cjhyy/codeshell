/**
 * Agent → Panel tool calls: validates an Agent's invocation against the tool
 * the selected Panel package declares, waits briefly for that Panel's guest to
 * bind, relays the request into the guest under the project execution gate,
 * and settles it from the guest's response (only the same guest may answer).
 */
import { BrowserWindow, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { validateToolArgsStrict } from "@cjhyy/code-shell-core";
import { panelExecutionGate } from "@cjhyy/code-shell-server/panels";
import type { PanelAppAgentToolInvocation } from "../shared/panel-apps.js";
import type { GuestBinding, PanelAppBridgeInternals } from "./panel-app-bridge-types.js";
import {
  AGENT_TOOL_GUEST_WAIT_MS,
  CALL_TIMEOUT_MS,
  MAX_PARAMS_BYTES,
  MAX_RESULT_BYTES,
  jsonBytes,
} from "./panel-app-bridge-support.js";

function waitForAgentToolBinding(
  bridge: PanelAppBridgeInternals,

  appDescriptorId: string,
  bucket: string,
  ownerWindowId: number,
): Promise<GuestBinding> {
  const existing = bridge.findAgentToolBinding(appDescriptorId, bucket, ownerWindowId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveBinding, reject) => {
    const startedAt = Date.now();
    const check = (): void => {
      const binding = bridge.findAgentToolBinding(appDescriptorId, bucket, ownerWindowId);
      if (binding) {
        resolveBinding(binding);
        return;
      }
      if (Date.now() - startedAt >= AGENT_TOOL_GUEST_WAIT_MS) {
        reject(new Error(`Panel App '${appDescriptorId}' did not become ready`));
        return;
      }
      setTimeout(check, 50);
    };
    setTimeout(check, 0);
  });
}

export async function panelInvokeAgentTool(
  bridge: PanelAppBridgeInternals,

  sender: WebContents,
  input: PanelAppAgentToolInvocation,
): Promise<unknown> {
  if (
    !input ||
    typeof input.appDescriptorId !== "string" ||
    !input.appDescriptorId.startsWith("panel-app:") ||
    typeof input.bucket !== "string" ||
    input.bucket.length === 0 ||
    input.bucket.length > 512 ||
    typeof input.toolName !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(input.toolName) ||
    !input.arguments ||
    typeof input.arguments !== "object" ||
    Array.isArray(input.arguments)
  ) {
    throw new Error("invalid Panel App Agent tool invocation");
  }
  if (jsonBytes(input.arguments) > (bridge.options.limits?.maxParamsBytes ?? MAX_PARAMS_BYTES)) {
    throw new Error("Panel App Agent tool arguments are too large");
  }
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner) throw new Error("Panel App Agent tool requires a live host window");
  const binding = await waitForAgentToolBinding(
    bridge,
    input.appDescriptorId,
    input.bucket,
    owner.id,
  );
  bridge.assertProjectBinding(binding);
  const declaration = binding.resource.descriptor.agent?.tools.find(
    (tool) => tool.name === input.toolName,
  );
  if (!declaration) {
    throw new Error(`Panel App tool '${input.toolName}' is not declared`);
  }
  const validationError = validateToolArgsStrict(
    input.toolName,
    input.arguments,
    declaration.inputSchema,
  );
  if (validationError) {
    throw new Error(`Invalid Panel App tool input: ${validationError}`);
  }
  if (
    [...bridge.pendingAgentToolCalls.values()].filter(
      (pending) => pending.guestId === binding.guest.id,
    ).length >= 16
  )
    throw new Error("Panel App has too many unfinished Agent tool calls");
  const releaseExecution = panelExecutionGate.enter({
    appId: binding.resource.descriptor.appId,
    projectPath: binding.projectPath,
    holder: { kind: "agent-tool", guestId: binding.guest.id },
  });
  const requestId = randomUUID();
  const result = await new Promise<unknown>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      // A timeout stops waiting, not the guest operation. Retain the lease until
      // its late response or guest revocation proves it can no longer execute.
      reject(new Error(`Panel App tool '${input.toolName}' timed out`));
    }, bridge.options.limits?.callTimeoutMs ?? CALL_TIMEOUT_MS);
    bridge.pendingAgentToolCalls.set(requestId, {
      releaseExecution,
      guestId: binding.guest.id,
      resolve: resolveResult,
      reject,
      timer,
    });
    try {
      binding.guest.send("panel-app:agent-tool-request", {
        requestId,
        toolName: input.toolName,
        arguments: input.arguments,
      });
    } catch (error) {
      clearTimeout(timer);
      bridge.pendingAgentToolCalls.delete(requestId);
      releaseExecution();
      reject(
        error instanceof Error
          ? error
          : new Error("Panel App closed before its Agent tool request was sent"),
      );
    }
  });
  if (jsonBytes(result) > (bridge.options.limits?.maxResultBytes ?? MAX_RESULT_BYTES)) {
    throw new Error("Panel App Agent tool result is too large");
  }
  return result;
}

export function panelHandleAgentToolResponse(
  bridge: PanelAppBridgeInternals,
  sender: WebContents,
  raw: unknown,
): void {
  const response = raw as {
    requestId?: unknown;
    ok?: unknown;
    result?: unknown;
    error?: unknown;
  } | null;
  if (!response || typeof response.requestId !== "string") return;
  const pending = bridge.pendingAgentToolCalls.get(response.requestId);
  if (!pending || pending.guestId !== sender.id) return;
  bridge.pendingAgentToolCalls.delete(response.requestId);
  pending.releaseExecution();
  clearTimeout(pending.timer);
  if (response.ok === true) {
    pending.resolve(response.result ?? null);
    return;
  }
  pending.reject(
    new Error(
      typeof response.error === "string" ? response.error.slice(0, 1_000) : "Panel App tool failed",
    ),
  );
}
