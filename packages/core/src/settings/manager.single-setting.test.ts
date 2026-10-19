import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "./manager.js";
import { configTool } from "../tool-system/builtin/config.js";
import type { ToolContext } from "../tool-system/context.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-single-setting-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const user = join(root, "user");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  mkdirSync(user);
  return { cwd, user, manager: new SettingsManager(cwd, "full", true, user) };
}

for (const extension of ["yaml", "yml"]) {
  test(`a user single-setting write preserves the existing ${extension} layer`, () => {
    const { cwd, user, manager } = fixture();
    const yaml = join(user, `settings.${extension}`);
    const original =
      "agent:\n  responseLanguage: zh\n  userProfile: Existing profile\nimages:\n  detail: high\n";
    writeFileSync(yaml, original);
    expect(manager.get().agent.userProfile).toBe("Existing profile");

    manager.saveUserSetting("agent.responseLanguage", "en");

    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({
      agent: { responseLanguage: "en", userProfile: "Existing profile" },
      images: { detail: "high" },
    });
    expect(readFileSync(yaml, "utf8")).toBe(original);
    expect(manager.get().agent.userProfile).toBe("Existing profile");
    expect(new SettingsManager(cwd, "full", true, user).get().images?.detail).toBe("high");
  });
}

test("a malformed user YAML layer cannot be shadowed by a successful single-setting write", () => {
  const { user, manager } = fixture();
  const yaml = join(user, "settings.yaml");
  const original = "agent: [unclosed\n";
  writeFileSync(yaml, original);

  expect(() => manager.saveUserSetting("agent.responseLanguage", "en")).toThrow();
  expect(readFileSync(yaml, "utf8")).toBe(original);
  expect(existsSync(join(user, "settings.json"))).toBe(false);
});

test("a user single-setting write keeps JSON precedence over a sibling YAML file", () => {
  const { user, manager } = fixture();
  writeFileSync(join(user, "settings.yaml"), "agent:\n  userProfile: Shadowed YAML\n");
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({ agent: { userProfile: "Selected JSON" } }),
  );
  manager.saveUserSetting("agent.responseLanguage", "en");
  expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({
    agent: { userProfile: "Selected JSON", responseLanguage: "en" },
  });
});

for (const scope of ["user", "project", "local"] as const) {
  function writer() {
    const { cwd, user, manager } = fixture();
    const path =
      scope === "user"
        ? join(user, "settings.json")
        : join(cwd, ".code-shell", scope === "local" ? "settings.local.json" : "settings.json");
    const save = (key: string, value: unknown) => {
      if (scope === "user") manager.saveUserSetting(key, value);
      else if (scope === "project") manager.saveProjectSetting(key, value, cwd);
      else manager.saveLocalSetting(key, value, cwd);
    };
    return { cwd, user, manager, path, save };
  }

  test(`${scope} single-setting writes reject invalid types without changing an existing file`, () => {
    const { cwd, user, manager, path, save } = writer();
    const original = '{"agent":{"responseLanguage":"zh","userProfile":"Keep profile"}}\n';
    writeFileSync(path, original);
    expect(manager.get().agent.responseLanguage).toBe("zh");

    expect(() => save("agent.responseLanguage", true)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(new SettingsManager(cwd, "full", true, user).get().agent.responseLanguage).toBe("zh");
  });

  test(`${scope} invalid first writes do not create an unreadable settings file`, () => {
    const { path, save } = writer();
    expect(() => save("agent.responseLanguage", true)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  test(`${scope} validated single-setting writes preserve unknown fields and null tombstones`, () => {
    const { path, save } = writer();
    const original = {
      extensionData: { keep: [1, 2, 3] },
      mcpServers: { example: { command: "node", env: { REMOVED: null, KEEP: "yes" } } },
    };
    writeFileSync(path, JSON.stringify(original));
    save("agent.responseLanguage", "en");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...original,
      agent: { responseLanguage: "en" },
    });
  });
}

test("Config reports an invalid value as an error and preserves readable project settings", async () => {
  const { cwd } = fixture();
  const path = join(cwd, ".code-shell", "settings.json");
  const original = '{"agent":{"responseLanguage":"zh"}}\n';
  writeFileSync(path, original);

  const result = await configTool({ action: "write", key: "agent.responseLanguage", value: true }, {
    cwd,
  } as ToolContext);

  expect(result).toStartWith("Error:");
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(new SettingsManager(cwd, "project").get().agent.responseLanguage).toBe("zh");
});
