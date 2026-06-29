/**
 * Resolve which transcription (speech-to-text) provider the desktop voice-input
 * should use, from settings. Mirrors generate-image.ts's resolveImageProvider:
 *
 *   0. Unified store — modelConnections (tag=audio) + credentials, via
 *      genInstancesFromConnections. Honors `defaults.audio` / an explicit
 *      `prefer` id, else the first usable.
 *   1. Fallback — no audio connection configured: reuse any OpenAI-family
 *      credential's key (so a user who only set up OpenAI text/images can
 *      dictate immediately with zero extra config). Targets the official
 *      OpenAI endpoint + gpt-4o-transcribe.
 *
 * Returns null when nothing usable is configured (or an explicit `prefer` isn't
 * usable — no silent fallback in that case, matching the image resolver).
 */
import { SettingsManager } from "../settings/manager.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { genInstancesFromConnections } from "../model-catalog/gen-connections.js";
import type { TranscribeCreds } from "./transcribe.js";

export interface ResolvedTranscribeProvider {
  creds: TranscribeCreds;
  /** Model id to transcribe with (e.g. gpt-4o-transcribe). */
  model: string;
}

/** Catalog ids whose credentials are OpenAI-compatible and carry an OpenAI key
 *  reusable for /audio/transcriptions on the official endpoint. */
const OPENAI_CRED_CATALOG_IDS = new Set(["openai", "openai-images", "openai-transcribe"]);
const OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";

interface GenInstanceSource {
  tag?: string;
  [k: string]: unknown;
}
interface CredentialSource {
  id?: string;
  catalogId?: string;
  apiKey?: string;
  [k: string]: unknown;
}

export function resolveTranscribeProvider(
  cwd: string,
  prefer?: string,
): ResolvedTranscribeProvider | null {
  const settings = new SettingsManager(cwd, "full").get();
  const conns = (settings as { modelConnections?: GenInstanceSource[] }).modelConnections;
  const creds = (settings as { credentials?: CredentialSource[] }).credentials;

  // 0. Unified store: audio connections.
  if (Array.isArray(conns) && conns.some((c) => c.tag === "audio")) {
    const list = genInstancesFromConnections(
      conns as never[],
      (Array.isArray(creds) ? creds : []) as never[],
      getMergedCatalog(),
      "audio",
    );
    const usable = list.filter((p) => !!p.apiKey && !!p.baseUrl);
    const def = (settings as { defaults?: { audio?: string } }).defaults?.audio;
    if (prefer) {
      const chosen = usable.find((p) => p.id === prefer);
      // Explicit request not usable → don't silently fall back.
      if (chosen) {
        return {
          creds: { baseUrl: chosen.baseUrl, apiKey: chosen.apiKey! },
          model: chosen.defaultModel || OPENAI_DEFAULT_TRANSCRIBE_MODEL,
        };
      }
      return null;
    }
    const preferred = def ? usable.find((p) => p.id === def) : undefined;
    const chosen = preferred ?? usable[0];
    if (chosen) {
      return {
        creds: { baseUrl: chosen.baseUrl, apiKey: chosen.apiKey! },
        model: chosen.defaultModel || OPENAI_DEFAULT_TRANSCRIBE_MODEL,
      };
    }
    // audio connections exist but none usable; if explicit prefer was handled
    // above. Fall through to the credential fallback for the implicit case.
  }

  // 1. Fallback: reuse an OpenAI-family credential key (no audio connection set
  // up yet). Only for the implicit path — an explicit `prefer` that didn't
  // resolve above already returned null.
  if (prefer) return null;
  if (Array.isArray(creds)) {
    const openaiCred = creds.find(
      (c) => typeof c.apiKey === "string" && c.apiKey && OPENAI_CRED_CATALOG_IDS.has(c.catalogId ?? ""),
    );
    if (openaiCred?.apiKey) {
      return {
        creds: { baseUrl: OPENAI_AUDIO_BASE_URL, apiKey: openaiCred.apiKey },
        model: OPENAI_DEFAULT_TRANSCRIBE_MODEL,
      };
    }
  }
  return null;
}

/** Tool/UI-visibility guard: is voice input usable (some transcribe provider
 *  resolvable)? Lets the desktop disable/enable the mic button. */
export function isTranscribeAvailable(cwd: string): boolean {
  return resolveTranscribeProvider(cwd) !== null;
}
