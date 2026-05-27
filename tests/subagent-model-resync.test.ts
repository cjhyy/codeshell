import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../packages/core/src/engine/engine.ts";

// Isolate settings: SettingsManager reads $HOME/.code-shell/settings.json and
// <cwd>/.code-shell/settings.json. Point both at temp dirs so the real user
// settings don't leak in.
let home: string;
let cwd: string;
let prevHome: string | undefined;

const settings = {
  activeKey: "primary",
  providers: [
    { key: "p", kind: "openai", baseUrl: "https://primary.example/v1", apiKey: "pk" },
    { key: "f", kind: "openai", baseUrl: "https://flash.example/v1", apiKey: "fk" },
  ],
  models: [
    { key: "primary", provider: "openai", providerKey: "p", model: "primary-model", baseUrl: "https://primary.example/v1", apiKey: "pk" },
    { key: "flash", provider: "openai", providerKey: "f", model: "flash-model", baseUrl: "https://flash.example/v1", apiKey: "fk" },
  ],
};

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "subagent-home-"));
  cwd = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
  mkdirSync(join(home, ".code-shell"), { recursive: true });
  writeFileSync(join(home, ".code-shell", "settings.json"), JSON.stringify(settings));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("sub-agent model resync", () => {
  it("a sub-agent keeps its explicitly-routed model, ignoring settings.activeKey", () => {
    // The parent would route a child to the 'flash' role. The child Engine is
    // constructed with the flash llm + isSubAgent. Settings.activeKey points to
    // 'primary' — the resync must NOT clobber the child's flash model.
    const child = new Engine({
      llm: { provider: "openai", model: "flash-model", baseUrl: "https://flash.example/v1", apiKey: "fk" },
      cwd,
      isSubAgent: true,
    });
    expect(child.getConfig().llm.model).toBe("flash-model");
  });

  it("a top-level Engine still resyncs to settings.activeKey", () => {
    // Sanity: the resync behavior is preserved for non-sub-agent engines.
    const top = new Engine({
      llm: { provider: "openai", model: "whatever", baseUrl: "https://x/v1", apiKey: "x" },
      cwd,
    });
    expect(top.getConfig().llm.model).toBe("primary-model");
  });
});
