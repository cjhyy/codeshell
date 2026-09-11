import { createHash } from "node:crypto";
import { SettingsManager } from "../settings/manager.js";
import { getMergedCatalog, type CatalogEntry } from "../model-catalog/index.js";
import { resolveInstance, type Credential, type ModelInstance } from "../model-catalog/resolve.js";

export interface SpeechVoice {
  id: string;
  name: string;
  language: string;
}
export interface SpeechModelDescription {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  reason?: string;
  voices: SpeechVoice[];
  defaultVoiceId?: string;
  maxTextLength: number;
  supportsInstructions: boolean;
}
/** Main-process only. Never return this object over a panel bridge. */
export interface ResolvedSpeechModel {
  description: SpeechModelDescription;
  connectionId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  defaultRate: number;
  defaultInstructions?: string;
}
export interface SpeechConfiguration {
  models: ResolvedSpeechModel[];
  defaultModelId?: string;
}
interface SpeechSettings {
  modelConnections?: ModelInstance[];
  credentials?: Credential[];
  defaults?: { speech?: string };
}

/** A configured endpoint may be local, but never credentials embedded in a URL. */
export function isSpeechEndpointAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** Pure resolver: only explicitly configured speech connections become choices. */
export function speechModelsFromSettings(
  settings: SpeechSettings,
  catalog: CatalogEntry[],
): SpeechConfiguration {
  const models: ResolvedSpeechModel[] = [];
  const seen = new Set<string>();
  for (const connection of settings.modelConnections ?? []) {
    if (connection.tag !== "speech" || seen.has(connection.id)) continue;
    seen.add(connection.id);
    const resolved = resolveInstance(connection, settings.credentials ?? [], catalog);
    if (
      !resolved ||
      resolved.entry.tag !== "speech" ||
      resolved.adapterKind !== "openai" ||
      !resolved.apiKey?.trim() ||
      !resolved.preset ||
      !resolved.model ||
      !isSpeechEndpointAllowed(resolved.baseUrl)
    )
      continue;
    const params = resolved.preset.params ?? [];
    const voiceSpec = params.find((param) => param.name === "voice");
    const voiceIds =
      voiceSpec?.control === "enum"
        ? (voiceSpec.options ?? [])
        : typeof resolved.paramValues.voice === "string"
          ? [resolved.paramValues.voice]
          : [];
    const voices = [...new Set(voiceIds)]
      .filter((id) => id.trim() && id.length <= 200)
      .slice(0, 64)
      .map((id) => ({ id, name: id, language: "und" }));
    if (!voices.length) continue;
    const preferredVoice = resolved.paramValues.voice ?? voiceSpec?.default ?? voices[0]!.id;
    if (typeof preferredVoice !== "string" || !voices.some((voice) => voice.id === preferredVoice))
      continue;
    const defaultRate =
      resolved.paramValues.speed ?? params.find((param) => param.name === "speed")?.default ?? 1;
    if (
      typeof defaultRate !== "number" ||
      !Number.isFinite(defaultRate) ||
      defaultRate < 0.5 ||
      defaultRate > 2
    )
      continue;
    const supportsInstructions =
      params.some((param) => param.name === "instructions") &&
      !["tts-1", "tts-1-hd"].includes(resolved.model);
    const instructions = resolved.paramValues.instructions;
    if (
      instructions !== undefined &&
      (typeof instructions !== "string" ||
        instructions.length > 2000 ||
        (instructions.trim() && !supportsInstructions))
    )
      continue;
    const id = `speech-${createHash("sha256")
      .update(
        JSON.stringify([connection.id, connection.catalogId, resolved.model, resolved.baseUrl]),
      )
      .digest("hex")
      .slice(0, 32)}`;
    models.push({
      description: {
        id,
        name: `${connection.id} · ${resolved.preset.label ?? resolved.model}`.slice(0, 256),
        provider: resolved.entry.displayName,
        available: true,
        voices,
        defaultVoiceId: preferredVoice,
        maxTextLength: 4096,
        supportsInstructions,
      },
      connectionId: connection.id,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      defaultRate,
      ...(typeof instructions === "string" && instructions.trim()
        ? { defaultInstructions: instructions.trim() }
        : {}),
    });
  }
  const preferred = models.find((model) => model.connectionId === settings.defaults?.speech);
  return { models, ...(preferred ? { defaultModelId: preferred.description.id } : {}) };
}

/** Resolve secrets only in the trusted Host when it lists choices or starts a job. */
export function resolveSpeechConfiguration(cwd: string): SpeechConfiguration {
  return speechModelsFromSettings(new SettingsManager(cwd, "full").get(), getMergedCatalog());
}
