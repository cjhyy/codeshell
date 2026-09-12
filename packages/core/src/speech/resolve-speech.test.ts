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

  test("CosyVoice connections expose supported Chinese speech voices and defaults without credentials", () => {
    const model = "FunAudioLLM/CosyVoice2-0.5B";
    const instance: ModelInstance = {
      id: "chinese-narration",
      catalogId: "siliconflow-speech",
      tag: "speech",
      model,
      credentialId: "siliconflow-key",
    };
    const settings = SettingsSchema.parse({
      modelConnections: [instance],
      credentials: [
        {
          id: "siliconflow-key",
          catalogId: "siliconflow-speech",
          apiKey: "TEST-ONLY-SILICONFLOW-KEY",
        },
      ],
      defaults: { speech: instance.id },
    });
    const result = speechModelsFromSettings(settings, BUILTIN_CATALOG);
    expect(result.models).toHaveLength(1);
    const resolved = result.models[0]!;
    expect(result.defaultModelId).toBe(resolved.description.id);
    expect(resolved.baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(resolved.model).toBe(model);
    expect(resolved.apiKey).toBe("TEST-ONLY-SILICONFLOW-KEY");
    expect(resolved.defaultRate).toBe(1);
    expect(resolved.defaultInstructions).toBeUndefined();
    expect(resolved.description.supportsInstructions).toBe(false);
    expect(resolved.description.defaultVoiceId).toBe(`${model}:anna`);
    expect(resolved.description.voices.map((voice) => voice.id)).toEqual(
      ["alex", "benjamin", "charles", "david", "anna", "bella", "claire", "diana"].map(
        (voice) => `${model}:${voice}`,
      ),
    );
    expect(JSON.stringify(resolved.description)).not.toContain("TEST-ONLY-SILICONFLOW-KEY");
    expect(JSON.stringify(resolved.description)).not.toContain("api.siliconflow.cn");
    for (const paramValues of [
      { voice: "anna" },
      { voice: "coral" },
      { instructions: "不能静默忽略" },
      { speed: 0.25 },
      { speed: 4 },
    ]) {
      expect(
        speechModelsFromSettings(
          {
            ...settings,
            modelConnections: [{ ...instance, paramValues }],
          },
          BUILTIN_CATALOG,
        ).models,
      ).toHaveLength(0);
    }
  });

  test("CosyVoice can share a same-provider credential but cannot receive OpenAI or foreign endpoint keys", () => {
    const catalog = [
      ...BUILTIN_CATALOG,
      {
        id: "siliconflow-text",
        tag: "text" as const,
        adapterKind: "openai",
        displayName: "Configured SiliconFlow text provider",
        description: "Test configured provider",
        defaultBaseUrl: "https://api.siliconflow.cn/v1",
      },
    ];
    const instance: ModelInstance = {
      id: "chinese-narration",
      catalogId: "siliconflow-speech",
      tag: "speech",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      credentialId: "shared-key",
    };
    const sharedKey = {
      id: "shared-key",
      catalogId: "siliconflow-text",
      apiKey: "TEST-ONLY-SHARED-KEY",
    };
    expect(
      speechModelsFromSettings(
        {
          modelConnections: [instance],
          credentials: [sharedKey],
        },
        catalog,
      ).models,
    ).toHaveLength(1);
    for (const credential of [
      { ...sharedKey, catalogId: "openai" },
      { ...sharedKey, baseUrl: "https://foreign.example/v1" },
    ]) {
      expect(
        speechModelsFromSettings(
          {
            modelConnections: [instance],
            credentials: [credential],
          },
          catalog,
        ).models,
      ).toHaveLength(0);
    }
  });
});
