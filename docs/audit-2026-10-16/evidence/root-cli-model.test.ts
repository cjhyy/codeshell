import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
globalThis.fetch = (() => { throw new Error("audit denies model/network requests"); }) as typeof fetch;
const { Engine } = await import("../../../packages/core/src/engine/engine.ts");

test("A10 seed Engine replaces explicit CLI model/endpoint/key with configured catalog default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-audit-cli-model-"));
  let engine: InstanceType<typeof Engine> | undefined;
  try {
    mkdirSync(join(dir, ".code-shell"));
    writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify({
      credentials: [{ id: "saved-key", catalogId: "openai", apiKey: "fixture-saved", baseUrl: "https://saved.example.invalid/v1" }],
      modelConnections: [{ id: "saved", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "saved-key" }],
      defaults: { text: "saved" },
    }));
    // Exercise the seed's catalog resync with explicit inputs. runCommand applies model/baseUrl
    // overrides before construction; its resolved branch separately omits the apiKey override.
    engine = new Engine({ cwd: dir, settingsScope: "full", headless: true,
      sessionStorageDir: join(dir, "sessions"),
      llm: { provider: "openai", model: "flag-model", apiKey: "fixture-flag", baseUrl: "https://flag.example.invalid/v1" },
    });
    expect(engine.getConfig().llm.model).toBe("gpt-4o");
    expect(engine.getConfig().llm.apiKey).toBe("fixture-saved");
    expect(engine.getConfig().llm.baseUrl).toBe("https://saved.example.invalid/v1");
  } finally { await engine?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
