import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { SettingsManager } from "../settings/manager.js";
import { persistActiveModel } from "./persist-active-model.js";

// switchModel must persist defaults.text (the unified active-model field),
// NOT the deleted legacy activeKey/model.* mirror.
describe("switchModel persists defaults.text", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-persist-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    // seed a settings.json with two text connections so the pool has keys to switch between
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify(
        {
          credentials: [
            {
              id: "ds-key",
              catalogId: "deepseek",
              apiKey: "k",
              baseUrl: "https://api.deepseek.com/v1",
            },
          ],
          modelConnections: [
            {
              id: "ds",
              catalogId: "deepseek",
              tag: "text",
              model: "deepseek-v4-flash",
              credentialId: "ds-key",
            },
            {
              id: "ds2",
              catalogId: "deepseek",
              tag: "text",
              model: "deepseek-v4-pro",
              credentialId: "ds-key",
            },
          ],
          defaults: { text: "ds" },
        },
        null,
        2,
      ),
    );
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function createEngine() {
    const { Engine } = await import("./engine.js");
    return new Engine({
      llm: {
        provider: "openai",
        model: "deepseek-v4-flash",
        apiKey: "k",
        baseUrl: "https://api.deepseek.com/v1",
      },
      cwd: home,
      settingsScope: "full",
    });
  }

  it("writes defaults.text = the switched key, no legacy fields", async () => {
    const engine = await createEngine();
    engine.switchModel("ds2");
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.defaults.text).toBe("ds2");
    expect(s.activeKey).toBeUndefined();
    expect(s.model).toBeUndefined();
    expect(engine.readSetting("defaults.text")).toBe("ds2");
  });

  it("preserves other keys from the latest disk state and tightens permissions", async () => {
    const engine = await createEngine();
    const path = join(home, ".code-shell", "settings.json");
    const current = JSON.parse(readFileSync(path, "utf-8"));
    current.extensionData = { keep: [1, 2, 3] };
    current.defaults.image = "image-connection";
    writeFileSync(path, JSON.stringify(current));
    chmodSync(path, 0o644);

    engine.switchModel("ds2");

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      ...current,
      defaults: { ...current.defaults, text: "ds2" },
    });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("preserves the selected YAML layer when creating settings.json", async () => {
    const engine = await createEngine();
    const path = join(home, ".code-shell", "settings.json");
    const current = JSON.parse(readFileSync(path, "utf-8"));
    current.extensionData = { keep: true };
    rmSync(path);
    const yamlPath = join(home, ".code-shell", "settings.yaml");
    const original = stringify(current);
    writeFileSync(yamlPath, original);

    engine.switchModel("ds2");

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      ...current,
      defaults: { text: "ds2" },
    });
    expect(readFileSync(yamlPath, "utf-8")).toBe(original);
  });

  it.each(["{ broken", "null", "[]", '{"permissions":{"defaultMode":"invalid"}}'])(
    "keeps an invalid settings layer intact without failing persistence: %s",
    async (original) => {
      const engine = await createEngine();
      const entry = engine.resolveModelEntry("ds2")!;
      const path = join(home, ".code-shell", "settings.json");
      writeFileSync(path, original);

      expect(() => persistActiveModel(entry, new SettingsManager(home, "full"))).not.toThrow();
      expect(readFileSync(path, "utf-8")).toBe(original);
    },
  );

  it("still switches the model when saving the user setting fails", async () => {
    const engine = await createEngine();
    const save = spyOn(SettingsManager.prototype, "saveUserSetting").mockImplementation(() => {
      throw new Error("settings write unavailable");
    });
    try {
      expect(engine.switchModel("ds2").key).toBe("ds2");
      expect(engine.getConfig().llm.model).toBe("deepseek-v4-pro");
    } finally {
      save.mockRestore();
    }
  });

  it("leaves defaults.text untouched when persist is false (per-session switch)", async () => {
    const engine = await createEngine();
    expect(engine.getModelPool().getActiveKey()).toBe("ds");
    const entry = engine.switchModel("ds2", { persist: false });
    expect(entry.key).toBe("ds2");
    expect(engine.getConfig().llm.model).toBe("deepseek-v4-pro");
    // Session-local selection must not become the seed for the next Engine
    // created from this shared runtime pool (Mimi manager -> Work Session).
    expect(engine.getModelPool().getActiveKey()).toBe("ds");
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.defaults.text).toBe("ds");
  });
});
