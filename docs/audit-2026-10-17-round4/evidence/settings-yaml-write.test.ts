import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// Install before local Core imports. No fixture needs a connection of any kind.
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

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

const yaml = "agent:\n  responseLanguage: zh\n  userProfile: Owned audit profile\nimages:\n  detail: high\n";
const expected = {
  agent: { responseLanguage: "zh", userProfile: "Owned audit profile" },
  images: { detail: "high" },
};
function fixture(extension: "yaml" | "yml" | "json", project = false) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-settings-round4-"));
  owned.push(root);
  const cwd = join(root, "workspace");
  const userConfig = join(root, "user-config");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  mkdirSync(userConfig);
  const directory = project ? join(cwd, ".code-shell") : userConfig;
  const source = join(directory, `settings.${extension}`);
  writeFileSync(source, extension === "json" ? JSON.stringify(expected) : yaml);
  return {
    cwd, userConfig, source, json: join(directory, "settings.json"),
    manager: new SettingsManager(cwd, "full", true, userConfig),
    fresh: () => new SettingsManager(cwd, "full", true, userConfig),
  };
}

for (const extension of ["yaml", "yml"] as const) {
  test(`observed bug: a user ${extension} preference write shadows unrelated values`, () => {
    const f = fixture(extension);
    expect(f.manager.get().agent.responseLanguage).toBe("zh");
    expect(f.manager.get().images?.detail).toBe("high");
    expect(existsSync(f.json)).toBe(false);
    f.manager.saveUserSetting("agent.responseLanguage", "en");
    expect(JSON.parse(readFileSync(f.json, "utf8"))).toEqual({ agent: { responseLanguage: "en" } });
    expect(f.fresh().get().agent.responseLanguage).toBe("en");
    expect(f.fresh().get().agent.userProfile).toBeUndefined();
    expect(f.fresh().get().images).toBeUndefined();
    expect(readFileSync(f.source, "utf8")).toBe(yaml);
    // Removing only our newly created JSON restores the still-intact YAML.
    rmSync(f.json);
    expect(f.fresh().get().agent.userProfile).toBe("Owned audit profile");
    expect(f.fresh().get().images?.detail).toBe("high");
    console.log(JSON.stringify({ case: extension, result: "new JSON masks userProfile and images; YAML bytes remain intact" }));
  });
}

test("control: a user JSON single-setting write preserves unrelated values", () => {
  const f = fixture("json");
  f.manager.saveUserSetting("agent.responseLanguage", "en");
  expect(f.fresh().get().agent.responseLanguage).toBe("en");
  expect(f.fresh().get().agent.userProfile).toBe("Owned audit profile");
  expect(f.fresh().get().images?.detail).toBe("high");
});

test("control: project single-setting write folds in YAML before creating JSON", () => {
  const f = fixture("yaml", true);
  f.manager.saveProjectSetting("agent.responseLanguage", "en", f.cwd);
  expect(f.fresh().get().agent.responseLanguage).toBe("en");
  expect(f.fresh().get().agent.userProfile).toBe("Owned audit profile");
  expect(f.fresh().get().images?.detail).toBe("high");
  expect(readFileSync(f.source, "utf8")).toBe(yaml);
});

test("control: user atomic mutation folds in YAML before creating JSON", () => {
  const f = fixture("yaml");
  f.manager.mutateSettingsForScope("user", f.cwd, (raw) => {
    (raw.agent as Record<string, unknown>).responseLanguage = "en";
  });
  expect(f.fresh().get().agent.responseLanguage).toBe("en");
  expect(f.fresh().get().agent.userProfile).toBe("Owned audit profile");
  expect(f.fresh().get().images?.detail).toBe("high");
  expect(readFileSync(f.source, "utf8")).toBe(yaml);
});
