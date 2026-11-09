import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "../..");

function sourceFiles(relativeRoot: string): string[] {
  const root = join(desktopRoot, relativeRoot);
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(file))
    .map((file) => join(root, file));
}

function literalChannels(files: string[], expression: RegExp): Set<string> {
  const channels = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(expression)) channels.add(match[1]!);
  }
  return channels;
}

function registeredMainHandleChannels(files: string[]): Set<string> {
  const channels = literalChannels(
    files,
    /(?:ipcMain|options\.ipcMain)\.handle\(\s*["']([^"']+)["']/g,
  );
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g)) {
      constants.set(match[1]!, match[2]!);
    }
    for (const match of source.matchAll(
      /(?:ipcMain|options\.ipcMain)\.handle\(\s*([A-Z][A-Z0-9_]*)/g,
    )) {
      const channel = constants.get(match[1]!);
      if (channel) channels.add(channel);
    }
  }
  return channels;
}

describe("desktop IPC contract", () => {
  test("every literal preload invoke has a main-process handler", () => {
    const mainHandles = registeredMainHandleChannels(sourceFiles("src/main"));
    const preloadInvokes = literalChannels(
      sourceFiles("src/preload"),
      /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g,
    );
    const missing = [...preloadInvokes].filter((channel) => !mainHandles.has(channel)).sort();

    expect(missing).toEqual([]);
    expect(preloadInvokes.size).toBeGreaterThan(300);
  });

  test("exposes Session-authoritative workspace, git/profile, and file APIs end to end", () => {
    const mainHandles = registeredMainHandleChannels(sourceFiles("src/main"));
    const preloadInvokes = literalChannels(
      sourceFiles("src/preload"),
      /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g,
    );
    const channels = [
      "agent:pendingApprovals",
      "workspace:authority",
      "projectRegistry:migrateSessionMainRoot",
      "sessions:setArchived",
      "workspace:gitStatus",
      "workspace:gitBranches",
      "workspace:profiles",
      "review:status",
      "review:diff",
      "review:recentCommits",
      "fsSession:readDir",
      "fsSession:readFile",
      "fsSession:exists",
    ];

    for (const channel of channels) {
      expect(preloadInvokes).toContain(channel);
      expect(mainHandles).toContain(channel);
    }
  });

  test("native cloud environments replace the remote project window bridge", () => {
    const main = sourceFiles("src/main")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const preload = sourceFiles("src/preload")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(main).toContain("registerCloudEnvironmentIpc");
    expect(preload).toContain("cloudEnvironment: cloudEnvironmentApi");
    expect(main).not.toContain('ipcMain.handle("cloud:open-project"');
    expect(preload).not.toContain('ipcRenderer.invoke("cloud:open-project"');
  });

  test("retires legacy project and cwd project IPC while keeping V2 authorities", () => {
    const mainHandles = registeredMainHandleChannels(sourceFiles("src/main"));
    const preloadInvokes = literalChannels(
      sourceFiles("src/preload"),
      /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g,
    );
    const retired = [
      "dialog:pickDir",
      "projects:list",
      "projects:resolveRoot",
      "projects:add",
      "projects:remove",
      "projects:setPinned",
      "files:search",
      "fs:readDir",
      "fs:readFile",
      "fs:exists",
      "sources:workspaceAccess",
      "sources:bind",
      "sources:unbind",
      "sources:pickAndUpload",
      "sources:deleteUpload",
    ];
    const v2 = [
      "projectRegistry:createFromPicker",
      "projectRegistry:addRootFromPicker",
      "projectRegistry:list",
      "projectRegistry:beginLegacyMigration",
      "projectRegistry:authorizeLegacyMigration",
      "projectRegistry:completeLegacyMigration",
      "settings:getConfiguration",
      "settings:setConfiguration",
      "sources:projectAccess",
      "sources:bindProject",
      "sources:unbindProject",
      "sources:pickAndUploadProject",
      "sources:deleteProjectUpload",
      "files:searchProject",
      "fsRoot:readDir",
      "fsRoot:readFile",
      "fsRoot:exists",
      "fsSession:readDir",
      "fsSession:readFile",
      "fsSession:exists",
    ];

    for (const channel of retired) {
      expect(preloadInvokes).not.toContain(channel);
      expect(mainHandles).not.toContain(channel);
    }
    for (const channel of v2) {
      expect(preloadInvokes).toContain(channel);
      expect(mainHandles).toContain(channel);
    }
  });

  test("exposes the Mimi notice bell, system rule and notification state end to end", async () => {
    const mainHandles = registeredMainHandleChannels(sourceFiles("src/main"));
    const preloadInvokes = literalChannels(
      sourceFiles("src/preload"),
      /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g,
    );
    for (const channel of [
      "pet:notices:get-state",
      "pet:notices:session-bell",
      "pet:notices:set-session-bell",
      "pet:notices:set-system-rule",
    ]) {
      expect(preloadInvokes).toContain(channel);
      expect(mainHandles).toContain(channel);
    }
    const { createPetApi } = await import("./pet-api.js");
    const invoked: Array<[string, unknown]> = [];
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const api = createPetApi({
      invoke: async (channel, payload) => {
        invoked.push([channel, payload]);
        return { on: false };
      },
      send: () => undefined,
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel) => listeners.delete(channel),
    });
    await api.getNoticesState?.();
    await api.getSessionBell?.("s-work");
    await api.setSessionBell?.("s-work", true);
    await api.setSystemNoticeRule?.({ state: "active" });
    expect(invoked).toEqual([
      ["pet:notices:get-state", undefined],
      ["pet:notices:session-bell", "s-work"],
      ["pet:notices:set-session-bell", { sessionId: "s-work", on: true }],
      ["pet:notices:set-system-rule", { state: "active" }],
    ]);
    let changes = 0;
    const off = api.onNoticesChanged?.(() => {
      changes += 1;
    });
    listeners.get("pet:notices:changed")?.({}, null);
    off?.();
    expect(changes).toBe(1);
    expect(listeners.has("pet:notices:changed")).toBe(false);
  });
});

test("preload version bridge forwards opaque authority ids and reference", async () => {
  const { createProjectAuthorityApi } = await import("./project-authority-api.js");
  const calls: unknown[][] = [];
  const api = createProjectAuthorityApi({
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "unavailable", reason: "object-missing" };
    },
  } as any);
  const ref = { kind: "git-blob" } as any;
  await api.readSessionFileVersion("session", "root", ref);
  await api.readProjectFileVersion("project", "root", ref);
  expect(calls).toEqual([
    ["fsSession:readFileVersion", "session", "root", ref],
    ["fsRoot:readFileVersion", "project", "root", ref],
  ]);
});
