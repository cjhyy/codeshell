import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const denied = () => { throw new Error("settings audit network denied"); };
globalThis.fetch = denied as typeof fetch;
(http as any).request = denied;
(http as any).get = denied;
(https as any).request = denied;
(https as any).get = denied;
(net as any).connect = denied;
(net as any).createConnection = denied;
(tls as any).connect = denied;
if (!process.env.CODE_SHELL_TEST_HOME ||
    process.env.CODE_SHELL_TEST_HOME !== join(process.env.HOME!, ".code-shell")) {
  throw new Error("settings audit requires the guarded runner HOME");
}
const { SettingsManager } = await import("../../../packages/core/src/settings/manager.ts");
const { configTool } = await import("../../../packages/core/src/tool-system/builtin/config.ts");
const { SettingsSchema } = await import("../../../packages/core/src/settings/schema.ts");
import type { ToolContext } from "../../../packages/core/src/tool-system/context.ts";

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-settings-round4-invalid-"));
  owned.push(root);
  const cwd = join(root, "workspace");
  const userConfig = join(root, "user-config");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  mkdirSync(userConfig);
  const manager = new SettingsManager(cwd, "full", true, userConfig);
  const fresh = () => new SettingsManager(cwd, "full", true, userConfig);
  return { cwd, userConfig, manager, fresh };
}

test("observed bug: Config reports success after persisting a known field with an invalid type", async () => {
  const f = fixture();
  const json = join(f.cwd, ".code-shell", "settings.json");
  const initial = { agent: { responseLanguage: "zh", userProfile: "Owned profile" } };
  writeFileSync(json, JSON.stringify(initial));
  expect(f.fresh().get().agent.responseLanguage).toBe("zh");
  const result = await configTool(
    { action: "write", key: "agent.responseLanguage", value: true },
    { cwd: f.cwd } as ToolContext,
  );
  expect(result).toBe("Updated agent.responseLanguage = true");
  const stored = JSON.parse(readFileSync(json, "utf8"));
  expect(stored.agent.responseLanguage).toBe(true);
  expect(stored.agent.userProfile).toBe("Owned profile");
  expect(SettingsSchema.safeParse(stored).success).toBe(false);
  expect(() => f.fresh().get()).toThrow();
  // A corrected ordinary config write restores loadability.
  expect(await configTool(
    { action: "write", key: "agent.responseLanguage", value: "en" },
    { cwd: f.cwd } as ToolContext,
  )).toBe('Updated agent.responseLanguage = "en"');
  expect(f.fresh().get().agent.responseLanguage).toBe("en");
  console.log(JSON.stringify({ case: "Config", result: "success string, persisted boolean, next SettingsManager.get throws; correction restores load" }));
});

test("observed shared root: the user single-setting writer accepts the same invalid type", () => {
  const f = fixture();
  const json = join(f.userConfig, "settings.json");
  writeFileSync(json, JSON.stringify({ agent: { responseLanguage: "zh" } }));
  expect(() => f.manager.saveUserSetting("agent.responseLanguage", true)).not.toThrow();
  expect(JSON.parse(readFileSync(json, "utf8")).agent.responseLanguage).toBe(true);
  expect(() => f.fresh().get()).toThrow();
});

test("control: the atomic writer rejects that invalid shape without changing disk", () => {
  const f = fixture();
  const json = join(f.cwd, ".code-shell", "settings.json");
  const before = JSON.stringify({ agent: { responseLanguage: "zh" } });
  writeFileSync(json, before);
  expect(() => f.manager.mutateSettingsForScope("project", f.cwd, (raw) => {
    (raw.agent as Record<string, unknown>).responseLanguage = true;
  })).toThrow();
  expect(readFileSync(json, "utf8")).toBe(before);
  expect(f.fresh().get().agent.responseLanguage).toBe("zh");
});

test("control: forward-compatible unknown keys remain accepted by the validated writer", () => {
  const f = fixture();
  f.manager.mutateSettingsForScope("project", f.cwd, (raw) => {
    raw.auditExtension = { enabled: true };
  });
  expect((f.fresh().get() as any).auditExtension).toEqual({ enabled: true });
});
