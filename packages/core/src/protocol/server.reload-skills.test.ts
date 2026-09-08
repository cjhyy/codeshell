import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentServer } from "./server.js";
import { scanSkills, invalidateSkillCache } from "../skills/scanner.js";
import type { Engine } from "../engine/engine.js";
import { validateSettings } from "../settings/schema.js";

const directories: string[] = [];
afterEach(() => {
  invalidateSkillCache();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("configure reloadSettings refreshes edited Skill content without restarting the worker", () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-skill-reload-"));
  directories.push(cwd);
  const dir = join(cwd, ".code-shell", "skills", "hot-reload");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, "---\ndescription: Original marker\n---\nOld body\n");
  expect(scanSkills(cwd).find((skill) => skill.name === "hot-reload")?.content).toBe("Old body\n");
  writeFileSync(file, "---\ndescription: Updated marker\n---\nNew body\n");
  expect(scanSkills(cwd).find((skill) => skill.name === "hot-reload")?.content).toBe("Old body\n");
  let onMessage: (message: any) => void = () => {};
  const sent: any[] = [];
  const engine = {
    setAskUser() {},
    setPlanMode() {},
    setPermissionMode() {},
    isHeadless: () => false,
    getEffectiveDisabledLists: () => ({
      disabledSkills: [],
      disabledPlugins: [],
      disabledPluginHooks: [],
    }),
    refreshRuntimeConfig() {},
  } as unknown as Engine;
  const server = new AgentServer({
    engine,
    settingsReader: () => validateSettings({}),
    transport: {
      send: (message) => sent.push(message),
      onMessage: (callback) => {
        onMessage = callback;
      },
      close() {},
    } as any,
  });
  onMessage({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadSettings: true } });
  expect(sent.find((message) => message.id === 1)?.result).toEqual({ ok: true });
  expect(scanSkills(cwd).find((skill) => skill.name === "hot-reload")).toMatchObject({
    content: "New body\n",
    description: "Updated marker",
  });
  server.close();
});
