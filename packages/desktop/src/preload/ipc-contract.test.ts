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

  test("retires legacy project and cwd project IPC while keeping V2 authorities", () => {
    const mainHandles = registeredMainHandleChannels(sourceFiles("src/main"));
    const preloadInvokes = literalChannels(
      sourceFiles("src/preload"),
      /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g,
    );
    const retired = [
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
      "projectRegistry:list",
      "projectRegistry:beginLegacyMigration",
      "projectRegistry:authorizeLegacyMigration",
      "projectRegistry:completeLegacyMigration",
      "settings:getProject",
      "settings:setProject",
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
});
