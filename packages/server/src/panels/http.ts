import type { IncomingMessage, ServerResponse } from "node:http";
import { createPanelManagementHttp, type PanelManagementHttpOptions } from "./management-http.js";
import { createPanelRuntime, panelWebCompatibility } from "./runtime.js";
import { createPanelAgentTaskHost, type PanelAgentTaskHostOptions } from "./agent-task-host.js";

export function createPanelHttp(
  options: PanelManagementHttpOptions & {
    dataDir: string;
    host: "hub" | "desktop";
    agentTaskOptions?: PanelAgentTaskHostOptions;
  },
) {
  const management = createPanelManagementHttp({
    ...options,
    compatibility: options.compatibility ?? panelWebCompatibility,
    onChanged: async (id, kind) => {
      runtime?.invalidate(id);
      await options.onChanged?.(id, kind);
    },
  });
  const runtime = createPanelRuntime({
    ...options,
    snapshot: management.service.snapshot,
    createAgentTasks: (hooks) =>
      createPanelAgentTaskHost({ ...options.agentTaskOptions, ...hooks }),
  });
  return {
    service: management.service,
    activeTaskCount: runtime.activeTaskCount,
    panelAction: runtime.panelAction,
    invalidate: runtime.invalidate,
    ownsAssets: runtime.ownsAssets,
    handleAssets: runtime.handleAssets,
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      return (await runtime.handle(request, response)) || management.handle(request, response);
    },
    cancelOwner(owner: string) {
      runtime.cancelOwner(owner);
      management.cancelOwner(owner);
    },
    close() {
      runtime.close();
      management.close();
    },
  };
}
