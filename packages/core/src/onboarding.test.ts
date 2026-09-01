import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes credentials + modelConnections + defaults.text, no legacy fields", () => {
    appendOnboardingResult({
      models: [
        {
          instanceId: "deepseek",
          kind: "deepseek",
          model: "deepseek-v4-flash",
          apiKey: "sk-x",
          baseUrl: "https://api.deepseek.com/v1",
        },
      ],
      activeId: "deepseek",
    });
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(1);
    expect(s.modelConnections[0]).toMatchObject({
      id: "deepseek",
      catalogId: "deepseek",
      tag: "text",
      model: "deepseek-v4-flash",
      credentialId: "deepseek-key",
    });
    expect(s.credentials.some((c: any) => c.apiKey === "sk-x")).toBe(true);
    expect(s.defaults.text).toBe("deepseek");
    expect(s.model).toBeUndefined();
    expect(s.models).toBeUndefined();
    expect(s.activeKey).toBeUndefined();
  });

  it("maps an OpenAI-compatible kind without a catalog entry to 'custom'", () => {
    appendOnboardingResult({
      models: [
        {
          instanceId: "myzai",
          kind: "zai",
          model: "glm-4.6",
          apiKey: "k",
          baseUrl: "https://api.z.ai/api/paas/v4",
        },
      ],
      activeId: "myzai",
    });
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections[0].catalogId).toBe("custom");
  });

  it("writes multiple models and sets defaults.text to activeId", () => {
    appendOnboardingResult({
      models: [
        {
          instanceId: "a",
          kind: "deepseek",
          model: "deepseek-v4-flash",
          apiKey: "k1",
          baseUrl: "https://api.deepseek.com/v1",
        },
        {
          instanceId: "b",
          kind: "openai",
          model: "gpt-5.5",
          apiKey: "k2",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
      activeId: "b",
    });
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(2);
    expect(s.defaults.text).toBe("b");
  });

  it("is idempotent on instanceId (no dup)", () => {
    const opts = {
      models: [
        {
          instanceId: "deepseek",
          kind: "deepseek",
          model: "deepseek-v4-flash",
          apiKey: "sk-x",
          baseUrl: "https://api.deepseek.com/v1",
        },
      ],
      activeId: "deepseek",
    };
    appendOnboardingResult(opts);
    appendOnboardingResult(opts);
    const s = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf-8"));
    expect(s.modelConnections).toHaveLength(1);
    expect(s.credentials).toHaveLength(1);
  });

  it("fails closed without changing a corrupt settings file", () => {
    const settingsDir = join(home, ".code-shell");
    const settingsFile = join(settingsDir, "settings.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsFile, '{"credentials":[');

    expect(() =>
      appendOnboardingResult({
        models: [
          {
            instanceId: "safe",
            kind: "openai",
            model: "gpt-5.5",
            apiKey: "secret",
          },
        ],
        activeId: "safe",
      }),
    ).toThrow(/did not overwrite/i);
    expect(readFileSync(settingsFile, "utf8")).toBe('{"credentials":[');
  });

  it("serializes concurrent onboarding writers without losing connections", async () => {
    const total = 16;
    const modulePath = join(import.meta.dir, "onboarding.ts");
    const processes = Array.from({ length: total }, (_, index) => {
      const script = `
        import { appendOnboardingResult } from ${JSON.stringify(modulePath)};
        appendOnboardingResult({
          models: [{
            instanceId: ${JSON.stringify(`model-${index}`)},
            kind: "openai",
            model: ${JSON.stringify(`gpt-test-${index}`)},
            apiKey: ${JSON.stringify(`key-${index}`)},
          }],
          activeId: ${JSON.stringify(`model-${index}`)},
        });
      `;
      return Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    expect(await Promise.all(processes.map((process) => process.exited))).toEqual(
      Array(total).fill(0),
    );

    const settings = JSON.parse(readFileSync(join(home, ".code-shell", "settings.json"), "utf8"));
    expect(settings.modelConnections).toHaveLength(total);
    expect(settings.credentials).toHaveLength(total);
    expect(
      new Set(settings.modelConnections.map((connection: { id: string }) => connection.id)).size,
    ).toBe(total);
  }, 60_000);
});
