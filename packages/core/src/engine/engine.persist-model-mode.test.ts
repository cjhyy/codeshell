import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

/**
 * R-1 regression: persistActiveModel writes model.apiKey (plaintext) into the
 * user settings.json. Like the SettingsManager/onboarding writers, it must
 * write the file owner-only (0o600), not world-readable. This was the THIRD
 * settings.json writer and was initially missed by the R-1 sweep.
 */
describe("persistActiveModel writes settings.json owner-only (0o600)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevCsHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "persist-model-home-"));
    prevHome = process.env.HOME;
    prevCsHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = home;
    // Seed a user settings.json with two text connections (unified catalog
    // shape) so switchModel resolves. Legacy models[]/activeKey were removed —
    // the pool now loads from modelConnections[] + credentials[].
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({
        credentials: [
          { id: "ds-key", catalogId: "deepseek", apiKey: "sk-one", baseUrl: "https://api.deepseek.com/v1" },
        ],
        modelConnections: [
          { id: "m1", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "ds-key" },
          { id: "m2", catalogId: "deepseek", tag: "text", model: "deepseek-v4-pro", credentialId: "ds-key" },
        ],
        defaults: { text: "m1" },
      }),
    );
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCsHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevCsHome;
    require("node:fs").rmSync(home, { recursive: true, force: true });
  });

  it("the file is 0o600 after a model switch, and the key round-trips", () => {
    // cwd:home so the SettingsManager reads the seeded modelConnections[] into
    // the pool (a cwd-less Engine doesn't register user-scope connections —
    // separate behavior).
    const engine = new Engine({ llm: baseLlm, cwd: home });
    engine.switchModel("m2");
    const file = join(home, ".code-shell", "settings.json");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    // sanity: the switch persisted the active key into the unified defaults.text
    // (legacy activeKey is gone).
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    expect(saved.defaults.text).toBe("m2");
    expect(saved.activeKey).toBeUndefined();
  });
});
