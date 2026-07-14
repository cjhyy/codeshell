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
  },
): AgentPanelHostResponse {
  if (request.action === "list") {
    const panels = getEnabledPanelEntries(options.availability).map((entry) => ({
      id: entry.key,
      title: panelEntryTitle(entry, options.translate),
      source:
        entry.owner.kind === "plugin"
          ? ("plugin" as const)
          : entry.owner.kind === "code"
            ? ("code" as const)
            : ("builtin" as const),
    }));
    return { requestId: request.requestId, result: { ok: true, panels } };
  }

  const panelId = request.panelId ?? "";
  const entry = getPanelEntry(panelId);
  if (!entry || !entry.enabled(options.availability)) {
    return {
      requestId: request.requestId,
      result: { ok: false, panelId, detail: `panel '${panelId}' is unavailable` },
    };
  }
  options.open(panelId);
  return { requestId: request.requestId, result: { ok: true, panelId } };
}
