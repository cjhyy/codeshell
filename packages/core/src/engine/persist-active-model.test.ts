import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
            { id: "ds-key", catalogId: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1" },
          ],
          modelConnections: [
            { id: "ds", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "ds-key" },
            { id: "ds2", catalogId: "deepseek", tag: "text", model: "deepseek-v4-pro", credentialId: "ds-key" },
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

  it("writes defaults.text = the switched key, no legacy fields", async () => {
    const { Engine } = await import("./engine.js");
    const engine = new Engine({
      llm: {
        provider: "openai",
        model: "deepseek-v4-flash",
        apiKey: "k",
        baseUrl: "https://api.deepseek.com/v1",
      },
      cwd: process.cwd(),
      settingsScope: "full",
    });
    engine.switchModel("ds2");
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.defaults.text).toBe("ds2");
    expect(s.activeKey).toBeUndefined();
    expect(s.model).toBeUndefined();
  });
});
