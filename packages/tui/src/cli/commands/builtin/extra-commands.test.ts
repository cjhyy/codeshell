import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearAuthSettingsFile, loginConfigureParams } from "./extra-commands.js";

describe("/login", () => {
  it("reloads models and switches the current session to the active/default connection", () => {
    expect(loginConfigureParams("sess-1", "conn-text")).toEqual({
      sessionId: "sess-1",
      reloadModels: true,
      model: "conn-text",
    });
  });
});

describe("/logout", () => {
  it("clears legacy and unified auth/model settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-logout-"));
    const file = join(dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: { provider: "openai" },
        models: { a: {} },
        providers: { openai: {} },
        arena: { models: [] },
        activeKey: "a",
        credentials: [{ id: "key", apiKey: "sk-test" }],
        modelConnections: [{ id: "conn", credentialId: "key" }],
        defaults: { text: "conn" },
        mcpServers: { keep: { command: "x" } },
      }),
    );

    const cleared = clearAuthSettingsFile(file);
    expect(cleared.sort()).toEqual([
      "activeKey",
      "arena",
      "credentials",
      "defaults",
      "model",
      "modelConnections",
      "models",
      "providers",
    ]);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      mcpServers: { keep: { command: "x" } },
    });
  });
});
