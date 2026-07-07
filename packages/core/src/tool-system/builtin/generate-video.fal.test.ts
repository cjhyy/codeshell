import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resolveLocalImageInputForTests,
  __resolveVideoProviderForTests,
  __normalizeImagesForTests,
} from "./generate-video.js";

// Isolate HOME so SettingsManager("full") doesn't merge the developer's real
// ~/.code-shell (which now has modelConnections that would trigger the unified
// resolve path and break the legacy videoGen.providers[] assertions here).
// See memory project_test_pollutes_real_settings.
let homeDir: string;
const realHome = process.env.HOME;
beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "fal-vid-home-"));
  process.env.HOME = homeDir;
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

function tmpWorkspaceWithSettings(settings: object): string {
  const dir = mkdtempSync(join(tmpdir(), "fal-vid-"));
  mkdirSync(join(dir, ".code-shell"), { recursive: true });
  writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify(settings));
  return dir;
}

describe("resolveVideoProvider reads videoGen.providers[]", () => {
  test("resolves a fal entry from videoGen.providers[] with defaultModel", () => {
    const cwd = tmpWorkspaceWithSettings({
      videoGen: {
        defaultProvider: "fal",
        providers: [
          { id: "fal", kind: "fal", baseUrl: "https://queue.fal.run", apiKey: "k", defaultModel: "fal-ai/kling-video/v3/pro/text-to-video" },
        ],
      },
    });
    const r = __resolveVideoProviderForTests(cwd);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("fal");
    expect(r!.creds.apiKey).toBe("k");
    expect(r!.defaultModel).toBe("fal-ai/kling-video/v3/pro/text-to-video");
  });

  test("returns null when fal entry has no apiKey", () => {
    const cwd = tmpWorkspaceWithSettings({
      videoGen: { providers: [{ id: "fal", kind: "fal", baseUrl: "https://queue.fal.run" }] },
    });
    expect(__resolveVideoProviderForTests(cwd)).toBeNull();
  });
});

describe("resolveVideoProvider reads unified modelConnections + credentials", () => {
  test("resolves a fal video connection's key from the referenced credential", () => {
    const cwd = tmpWorkspaceWithSettings({
      credentials: [{ id: "fal-acct", catalogId: "fal-video", apiKey: "sk-fal-unified" }],
      modelConnections: [
        { id: "vid1", catalogId: "fal-video", tag: "video", model: "fal-ai/kling-video/v3/pro/text-to-video", credentialId: "fal-acct" },
      ],
      defaults: { video: "vid1" },
    });
    const r = __resolveVideoProviderForTests(cwd);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("fal");
    expect(r!.creds.apiKey).toBe("sk-fal-unified");
    expect(r!.defaultModel).toBe("fal-ai/kling-video/v3/pro/text-to-video");
  });

  test("two video connections share one credential's key", () => {
    const cwd = tmpWorkspaceWithSettings({
      credentials: [{ id: "fal-acct", catalogId: "fal-video", apiKey: "sk-shared-vid" }],
      modelConnections: [
        { id: "a", catalogId: "fal-video", tag: "video", model: "m", credentialId: "fal-acct" },
        { id: "b", catalogId: "fal-video", tag: "video", model: "m", credentialId: "fal-acct" },
      ],
    });
    expect(__resolveVideoProviderForTests(cwd, "b")!.creds.apiKey).toBe("sk-shared-vid");
  });
});

describe("GenerateVideo image normalization", () => {
  test("local image paths resolve against ctx.cwd before upload, URLs pass through", () => {
    const cwd = "/tmp/video-workspace";

    expect(__resolveLocalImageInputForTests("frame.png", cwd)).toBe(
      join(cwd, "frame.png"),
    );
    expect(__resolveLocalImageInputForTests("https://example.test/frame.png", cwd)).toBe(
      "https://example.test/frame.png",
    );
  });

  test("images[] wins; URLs pass through; >9 → error", async () => {
    const fakeUploader = { kind: "fal", toUrl: async (p: string) => ({ ok: true as const, url: p.startsWith("http") ? p : `https://fal/${p}` }) };
    const ok = await __normalizeImagesForTests(["https://x/a.png", "/local/b.png"], undefined, fakeUploader, { baseUrl: "x", apiKey: "k" });
    expect(ok).toEqual({ ok: true, urls: ["https://x/a.png", "https://fal//local/b.png"] });

    const tooMany = await __normalizeImagesForTests(Array.from({ length: 10 }, (_, i) => `https://x/${i}.png`), undefined, fakeUploader, { baseUrl: "x", apiKey: "k" });
    expect(tooMany.ok).toBe(false);
  });
});
