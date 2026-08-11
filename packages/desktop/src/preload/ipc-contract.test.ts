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
    for (const match of source.matchAll(/(?:ipcMain|options\.ipcMain)\.handle\(\s*([A-Z][A-Z0-9_]*)/g)) {
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
});
