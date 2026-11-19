import type { ExternalRuntimeStartRequest } from "./external-runtime-service.js";

/**
 * What a live runtime must match to be reused for another caller's turn.
 *
 * A Goal is deliberately not part of it. Whether the Session has one is read
 * live on every tool listing, so the `hasGoal` launch hint changes nothing in
 * the provider; treating it as configuration replaced the runtime every time a
 * Goal paused or resumed, which killed the provider's own background work and
 * the turns queued behind it.
 */
export function externalRuntimeRoutingKey(
  request: ExternalRuntimeStartRequest,
  hostToolsEnabled: boolean,
): string {
  return JSON.stringify({
    kind: request.kind,
    cwd: request.cwd,
    mainRoot: request.mainRoot ?? request.cwd,
    model: request.model ?? null,
    modelKey: request.modelKey ?? null,
    permissionMode: request.permissionMode ?? "default",
    planMode: request.planMode === true,
    hostToolsEnabled,
    ownerWebContentsId: request.ownerWindow?.webContents.id ?? null,
  });
}

/** The routing key plus what only a restart can change (instructions, tool profile). */
export function externalRuntimeConfigurationKey(
  request: ExternalRuntimeStartRequest,
  hostToolsEnabled: boolean,
): string {
  return JSON.stringify({
    routingKey: externalRuntimeRoutingKey(request, hostToolsEnabled),
    developerInstructions: request.developerInstructions ?? null,
    toolProfile: request.toolProfile?.id ?? null,
  });
}
