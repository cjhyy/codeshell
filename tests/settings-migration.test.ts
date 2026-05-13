import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../src/settings/manager.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sm-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("SettingsManager — legacy models[] migration", () => {
  it("auto-migrates legacy models[] on load and writes .bak", () => {
    const dir = join(tmpHome, ".code-shell");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        models: [
          {
            key: "ds",
            provider: "openai",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "k",
            model: "deepseek-v4-flash",
          },
        ],
      }),
      "utf-8",
    );

    const mgr = new SettingsManager();
    const s = mgr.load();

    expect(s.providers.length).toBe(1);
    expect(s.providers[0].kind).toBe("deepseek");
    expect(s.models[0].providerKey).toBe("deepseek");
    expect(existsSync(`${path}.bak`)).toBe(true);

    // After migration the actual settings.json on disk has new shape too
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(Array.isArray(written.providers)).toBe(true);
    expect(written.providers[0].key).toBe("deepseek");
  });

  it("does not migrate or .bak when already migrated", () => {
    const dir = join(tmpHome, ".code-shell");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: [
          { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
        ],
        models: [{ key: "ds-flash", providerKey: "deepseek", model: "deepseek-v4-flash" }],
      }),
      "utf-8",
    );
    const mgr = new SettingsManager();
    mgr.load();
    expect(existsSync(`${path}.bak`)).toBe(false);
  });
});
