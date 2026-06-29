/**
 * resolveTranscribeProvider — settings → STT provider resolution.
 * Mirrors generate-image.tool.test.ts's HOME-isolated temp-workspace setup so
 * SettingsManager(cwd,"full") reads ONLY the temp settings.json.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTranscribeProvider, isTranscribeAvailable, describeTranscribe } from "./resolve-transcribe.js";

let ws: string;
let prevHome: string | undefined;
let homeDir: string;

function writeSettings(obj: unknown): void {
  writeFileSync(join(ws, ".code-shell", "settings.json"), JSON.stringify(obj));
}

beforeEach(() => {
  prevHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "stt-home-"));
  process.env.HOME = homeDir;
  ws = mkdtempSync(join(tmpdir(), "stt-ws-"));
  mkdirSync(join(ws, ".code-shell"), { recursive: true });
  writeSettings({});
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(ws, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("resolveTranscribeProvider", () => {
  test("resolves an audio modelConnection + its credential", () => {
    writeSettings({
      credentials: [{ id: "c1", catalogId: "openai-transcribe", apiKey: "sk-aud" }],
      modelConnections: [
        { id: "my-stt", catalogId: "openai-transcribe", tag: "audio", model: "whisper-1", credentialId: "c1" },
      ],
    });
    const r = resolveTranscribeProvider(ws);
    expect(r).not.toBeNull();
    expect(r!.creds.apiKey).toBe("sk-aud");
    expect(r!.creds.baseUrl).toBe("https://api.openai.com/v1");
    expect(r!.model).toBe("whisper-1");
  });

  test("falls back to an OpenAI-family credential when no audio connection exists", () => {
    // User only configured OpenAI text/images — dictation should still work.
    writeSettings({
      credentials: [{ id: "c1", catalogId: "openai", apiKey: "sk-text" }],
    });
    const r = resolveTranscribeProvider(ws);
    expect(r).not.toBeNull();
    expect(r!.creds.apiKey).toBe("sk-text");
    expect(r!.creds.baseUrl).toBe("https://api.openai.com/v1");
    expect(r!.model).toBe("gpt-4o-transcribe");
  });

  test("returns null when nothing usable is configured", () => {
    writeSettings({ credentials: [{ id: "c1", catalogId: "fal-video", apiKey: "fal-x" }] });
    expect(resolveTranscribeProvider(ws)).toBeNull();
    expect(isTranscribeAvailable(ws)).toBe(false);
  });

  test("explicit prefer that isn't usable → null (no silent fallback)", () => {
    writeSettings({
      credentials: [{ id: "c1", catalogId: "openai", apiKey: "sk-text" }],
      modelConnections: [
        { id: "my-stt", catalogId: "openai-transcribe", tag: "audio", model: "whisper-1", credentialId: "c1" },
      ],
    });
    // a usable audio connection exists, but prefer points at a non-existent id
    expect(resolveTranscribeProvider(ws, "does-not-exist")).toBeNull();
  });

  test("isTranscribeAvailable true when resolvable", () => {
    writeSettings({ credentials: [{ id: "c1", catalogId: "openai", apiKey: "sk-text" }] });
    expect(isTranscribeAvailable(ws)).toBe(true);
  });
});

describe("describeTranscribe", () => {
  test("source=connection when an audio connection is configured (key masked)", () => {
    writeSettings({
      credentials: [{ id: "c1", catalogId: "openai-transcribe", apiKey: "sk-abcdef123456" }],
      modelConnections: [
        { id: "my-stt", catalogId: "openai-transcribe", tag: "audio", model: "whisper-1", credentialId: "c1" },
      ],
    });
    const d = describeTranscribe(ws);
    expect(d.source).toBe("connection");
    expect(d.model).toBe("whisper-1");
    expect(d.baseUrl).toBe("https://api.openai.com/v1");
    expect(d.maskedKey).toBe("sk-abc...3456");
    expect(d.maskedKey).not.toContain("def123"); // never the full key
  });

  test("source=fallback (reused OpenAI credential) when no audio connection", () => {
    writeSettings({ credentials: [{ id: "c1", catalogId: "openai", apiKey: "sk-abcdef123456" }] });
    const d = describeTranscribe(ws);
    expect(d.source).toBe("fallback");
    expect(d.model).toBe("gpt-4o-transcribe");
    expect(d.maskedKey).toBe("sk-abc...3456");
    expect(d.reusedCredentialId).toBe("c1");
    expect(d.reusedCredentialCatalogId).toBe("openai");
  });

  test("source=none when nothing usable", () => {
    writeSettings({ credentials: [{ id: "c1", catalogId: "fal-video", apiKey: "x" }] });
    expect(describeTranscribe(ws).source).toBe("none");
  });
});
