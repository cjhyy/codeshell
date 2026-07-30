import type { AgentPanelHostRequest, AgentPanelHostResponse } from "../../shared/agent-panels";
import type { PanelAvailabilityContext } from "./PanelRegistry";
import { getEnabledPanelEntries, getPanelEntry, panelEntryTitle } from "./PanelRegistry";

/** Resolve one trusted main-process panel request against the live registry. */
export function resolveAgentPanelHostRequest(
  request: AgentPanelHostRequest,
  options: {
    availability: PanelAvailabilityContext;
    translate(key: string): string;
    open(panelId: string): void;
    invoke(
      panelId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown>;
  },
): Promise<AgentPanelHostResponse> {
  if (request.action === "list") {
    const panels = getEnabledPanelEntries(options.availability).map((entry) => ({
      id: entry.key,
      title: panelEntryTitle(entry, options.translate),
      source:
        entry.owner.kind === "panel-app"
          ? ("panel-app" as const)
          : entry.owner.kind === "builtin-panel-app"
            ? ("builtin-panel-app" as const)
            : ("builtin" as const),
    }));
    return Promise.resolve({ requestId: request.requestId, result: { ok: true, panels } });
  }

  const panelId = request.panelId ?? "";
  const entry = getPanelEntry(panelId);
  if (!entry || !entry.enabled(options.availability)) {
    return Promise.resolve({
      requestId: request.requestId,
      result: { ok: false, panelId, detail: `panel '${panelId}' is unavailable` },
    });
  }
  if (request.action === "tools") {
    return Promise.resolve({
      requestId: request.requestId,
      result: { ok: true, panelId, tools: entry.agentTools ?? [] },
    });
  }
  options.open(panelId);
  if (request.action === "open") {
    return Promise.resolve({ requestId: request.requestId, result: { ok: true, panelId } });
  }
  const toolName = request.toolName ?? "";
  const tool = entry.agentTools?.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return Promise.resolve({
      requestId: request.requestId,
      result: {
        ok: false,
        panelId,
        detail: `Panel App tool '${toolName}' is unavailable`,
      },
    });
  }
  return options.invoke(panelId, toolName, request.arguments ?? {}).then(
    (result) => ({
      requestId: request.requestId,
      result: { ok: true, panelId, toolName, result },
    }),
    (error) => ({
      requestId: request.requestId,
      result: {
        ok: false,
        panelId,
        detail: error instanceof Error ? error.message : String(error),
      },
    }),
  );
}
