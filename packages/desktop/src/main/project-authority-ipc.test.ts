import { describe, expect, test } from "bun:test";
import {
  registerProjectAuthorityIpc,
  type ProjectAuthorityIpcDependencies,
} from "./project-authority-ipc.js";

const expectedChannels = [
  "projectRegistry:list",
  "projectRegistry:sessionMainRoots",
  "projectRegistry:createFromPicker",
  "projectRegistry:addRootFromPicker",
  "projectRegistry:removeRoot",
  "projectRegistry:migrateSessionMainRoot",
  "projectRegistry:setPrimary",
  "projectRegistry:revealRoot",
  "projectRegistry:openRoot",
  "projectRegistry:rename",
  "projectRegistry:setPinned",
  "projectRegistry:remove",
  "projectRegistry:resolveForCwd",
  "projectRegistry:resolveForCwdBatch",
  "projectRegistry:beginLegacyMigration",
  "projectRegistry:authorizeLegacyMigration",
  "projectRegistry:completeLegacyMigration",
  "workspace:current",
  "workspace:authority",
  "workspace:gitStatus",
  "workspace:gitBranches",
  "workspace:profiles",
  "workspace:list",
  "workspace:diff",
  "workspace:switch",
  "workspace:release",
  "workspace:releaseMany",
  "workspace:cleanup",
] as const;

function harness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let mobileBroadcasts = 0;
  const project = { id: "project-1", name: "Renamed" };
  const projectStore = {
    rename: async () => project,
    list: async () => [project],
  };
  const dependencies = {
    ipcMain: {
      handle(channel: string, handler: (...args: any[]) => unknown) {
        if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
        handlers.set(channel, handler);
      },
    },
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
      {
        isDestroyed: () => true,
        webContents: { send: () => sent.push({ channel: "destroyed", payload: null }) },
      },
    ],
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    applyGitPathFromSettings: async () => undefined,
    projectStore,
    getBridge: () => undefined,
    getTrust: async () => "trusted" as const,
    assertSessionId(value: unknown): asserts value is string {
      if (typeof value !== "string" || !value) throw new Error("invalid session id");
    },
    trackGitRoot: () => undefined,
    broadcastMobileProjects: async () => {
      mobileBroadcasts += 1;
    },
    getGitStatus: async () => ({ branch: null, entries: [], clean: true }),
    getGitBranches: async () => ({ isRepo: false, current: null, branches: [] }),
    revealInFinder: async () => undefined,
    openPath: async () => "",
  } as unknown as ProjectAuthorityIpcDependencies;
  return { dependencies, handlers, sent, project, mobileBroadcasts: () => mobileBroadcasts };
}

describe("project authority IPC registration", () => {
  test("registers the complete project registry and Session workspace handler lifecycle", () => {
    const { dependencies, handlers } = harness();
    registerProjectAuthorityIpc(dependencies);
    expect([...handlers.keys()]).toEqual(expectedChannels);
  });

  test("registry mutations broadcast the refreshed snapshot to live windows and mobile", async () => {
    const { dependencies, handlers, sent, project, mobileBroadcasts } = harness();
    registerProjectAuthorityIpc(dependencies);

    const result = await handlers.get("projectRegistry:rename")!({}, "project-1", "Renamed");

    expect(result).toBe(project);
    expect(sent).toEqual([{ channel: "projectRegistry:changed", payload: [project] }]);
    expect(mobileBroadcasts()).toBe(1);
  });
});
