import { describe, expect, test } from "bun:test";
import { BUILTIN_CATALOG } from "../model-catalog/builtin.js";
import { SettingsSchema } from "../settings/schema.js";
import { speechModelsFromSettings, isSpeechEndpointAllowed } from "./resolve-speech.js";
import type { ModelInstance } from "../model-catalog/resolve.js";

const connection: ModelInstance = {
  id: "narration",
  catalogId: "openai-speech",
  tag: "speech",
  model: "gpt-4o-mini-tts",
  credentialId: "shared-openai",
  paramValues: { voice: "cedar", speed: 1.2, instructions: "温柔地朗读" },
};
const credentials = [{ id: "shared-openai", catalogId: "openai", apiKey: "TEST-ONLY-SECRET" }];
const resolve = (connections: ModelInstance[] = [connection]) =>
  speechModelsFromSettings(
    {
      modelConnections: connections,
      credentials,
      defaults: { speech: "narration" },
    },
    BUILTIN_CATALOG,
  );

describe("speech connections", () => {
  test("reuse compatible credentials, preserve model-specific controls and expose no secret in descriptions", () => {
    const result = resolve(),
      model = result.models[0]!;
    expect(result.defaultModelId).toBe(model.description.id);
    expect(model.model).toBe("gpt-4o-mini-tts");
    expect(model.apiKey).toBe("TEST-ONLY-SECRET");
    expect(model.description.defaultVoiceId).toBe("cedar");
    expect(model.description.supportsInstructions).toBe(true);
    expect(model.description.maxTextLength).toBe(4096);
    expect(model.defaultRate).toBe(1.2);
    expect(model.defaultInstructions).toBe("温柔地朗读");
    expect(JSON.stringify(model.description)).not.toContain("TEST-ONLY-SECRET");
    expect(JSON.stringify(model.description)).not.toContain("api.openai.com");
  });

  test("speech and audio defaults stay independent and dictation connections never become voices", () => {
    const stt: ModelInstance = {
      ...connection,
      id: "dictation",
      tag: "audio",
      catalogId: "openai-transcribe",
      model: "whisper-1",
    };
    const settings = SettingsSchema.parse({
      modelConnections: [connection, stt],
      credentials,
      defaults: { audio: "dictation", speech: "narration" },
    });
    expect(settings.defaults.audio).toBe("dictation");
    expect(settings.defaults.speech).toBe("narration");
    const models = speechModelsFromSettings(settings, BUILTIN_CATALOG).models;
    expect(models.map((model) => model.connectionId)).toEqual(["narration"]);
    expect(resolve([stt]).models).toEqual([]);
  });

  test("model IDs bind the connection, model and endpoint so old selections cannot route elsewhere", () => {
    const id = resolve().models[0]!.description.id;
    for (const changed of [
      { id: "another" },
      { model: "gpt-4o-mini-tts-2025-12-15" },
      { baseUrl: "https://api.openai.com/v2" },
    ])
      expect(resolve([{ ...connection, ...changed }]).models[0]!.description.id).not.toBe(id);
    expect(resolve().models[0]!.description.id).toBe(id);
  });

  test("missing keys, foreign credentials, wrong tags and unsupported options are not offered", () => {
    for (const changed of [
      { credentialId: "missing" },
      { catalogId: "openai-transcribe" },
      { model: "not-in-catalog" },
      { baseUrl: "https://other.example/v1" },
      { paramValues: { voice: "not-a-voice" } },
      { paramValues: { speed: 4 } },
      { paramValues: { instructions: "字".repeat(2001) } },
      { model: "tts-1", paramValues: { voice: "alloy", instructions: "不能静默忽略" } },
    ])
      expect(resolve([{ ...connection, ...changed }]).models).toHaveLength(0);
    const legacy = resolve([{ ...connection, model: "tts-1", paramValues: { voice: "alloy" } }])
      .models[0]!;
    expect(legacy.description.supportsInstructions).toBe(false);
    expect(legacy.description.voices.some((voice) => voice.id === "cedar")).toBe(false);
    expect(
      speechModelsFromSettings({ modelConnections: [connection], credentials: [] }, BUILTIN_CATALOG)
        .models,
    ).toEqual([]);
  });

  test("speech endpoint validation permits secure providers and local development only", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8000/v1",
    ])
      expect(isSpeechEndpointAllowed(url)).toBe(true);
    for (const url of [
      "http://public.example/v1",
      "file:///private",
      "https://key:secret@api.openai.com/v1",
      "https://api.openai.com/v1?key=secret",
      "https://api.openai.com/v1#secret",
    ])
      expect(isSpeechEndpointAllowed(url)).toBe(false);
  });
});
