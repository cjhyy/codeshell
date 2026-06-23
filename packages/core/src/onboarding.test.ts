import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendOnboardingResult } from "./onboarding.js";

describe("appendOnboardingResult (unified catalog)", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-onboard-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes credentials + modelConnections + defaults.text, no legacy fields", () => {
    appendOnboardingResult({
      models: [{ instanceId: "deepseek", kind: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-x", baseUrl: "https://api.deepseek.com/v1" }],
      activeId: "deepseek",
    });
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(1);
    expect(s.modelConnections[0]).toMatchObject({ id: "deepseek", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "deepseek-key" });
    expect(s.credentials.some((c: any) => c.apiKey === "sk-x")).toBe(true);
    expect(s.defaults.text).toBe("deepseek");
    expect(s.model).toBeUndefined();
    expect(s.models).toBeUndefined();
    expect(s.activeKey).toBeUndefined();
  });

  it("maps an OpenAI-compatible kind without a catalog entry to 'custom'", () => {
    appendOnboardingResult({
      models: [{ instanceId: "myzai", kind: "zai", model: "glm-4.6", apiKey: "k", baseUrl: "https://api.z.ai/api/paas/v4" }],
      activeId: "myzai",
    });
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections[0].catalogId).toBe("custom");
  });

  it("writes multiple models and sets defaults.text to activeId", () => {
    appendOnboardingResult({
      models: [
        { instanceId: "a", kind: "deepseek", model: "deepseek-v4-flash", apiKey: "k1", baseUrl: "https://api.deepseek.com/v1" },
        { instanceId: "b", kind: "openai", model: "gpt-5.5", apiKey: "k2", baseUrl: "https://api.openai.com/v1" },
      ],
      activeId: "b",
    });
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(2);
    expect(s.defaults.text).toBe("b");
  });

  it("is idempotent on instanceId (no dup)", () => {
    const opts = { models: [{ instanceId: "deepseek", kind: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-x", baseUrl: "https://api.deepseek.com/v1" }], activeId: "deepseek" };
    appendOnboardingResult(opts);
    appendOnboardingResult(opts);
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(1);
    expect(s.credentials).toHaveLength(1);
  });
});
