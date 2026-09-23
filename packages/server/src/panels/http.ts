import type { IncomingMessage, ServerResponse } from "node:http";
import { createPanelManagementHttp, type PanelManagementHttpOptions } from "./management-http.js";
import type { PanelDirectoryAuthorizer } from "./directory-bookmarks.js";
import type { SharedPanelToolHost } from "./shared-tool-jobs.js";
import { createPanelRuntime, panelWebCompatibility } from "./runtime.js";
import { createPanelAgentTaskHost, type PanelAgentTaskHostOptions } from "./agent-task-host.js";

export function createPanelHttp(
  options: PanelManagementHttpOptions & {
    dataDir: string;
    host: "hub" | "desktop";
    publicPathPrefix?: string;
    agentTaskOptions?: PanelAgentTaskHostOptions;
    sharedToolJobs?: SharedPanelToolHost;
    authorizePanelDirectory?: PanelDirectoryAuthorizer;
  },
) {
  // Embedded Desktop hosts opt in once their native coordinator and protocol
  // implement the same selection. The current Desktop composition does so.
  const projectPackages = options.projectPackages ?? options.host === "hub";
  const management = createPanelManagementHttp({
    ...options,
    projectPackages,
    compatibility: options.compatibility ?? panelWebCompatibility,
    onChanged: async (id, kind) => {
      await runtime?.invalidate(id);
      await options.onChanged?.(id, kind);
    },
  });
  const runtime = createPanelRuntime({
    ...options,
    projectPackages,
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
    async close() {
      await runtime.close();
      management.close();
    },
  };
}
