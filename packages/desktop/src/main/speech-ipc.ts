import { ipcMain, systemPreferences } from "electron";
import {
  transcribe,
  resolveTranscribeProvider,
  isTranscribeAvailable,
  describeTranscribe,
} from "@cjhyy/code-shell-core/internal";
import { requireRendererProjectPath } from "./renderer-project-path.js";

// ─── Voice input (speech-to-text / 听写) ───
// Renderer records the mic, ships raw audio bytes here; we resolve the
// configured (or OpenAI-fallback) transcription provider and POST to its
// /audio/transcriptions. Pure request/response — NOT an agent tool.
export async function transcribeConfiguredAudio(payload: {
  cwd: string;
  audio: Uint8Array;
  mimeType?: string;
  provider?: string;
  language?: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const resolved = resolveTranscribeProvider(payload.cwd, payload.provider);
  if (!resolved) return { ok: false, error: "no-audio-provider" };
  const mime = payload.mimeType?.trim() || "audio/webm";
  const ext = mime.includes("webm")
    ? "webm"
    : mime.includes("mp4") || mime.includes("m4a")
      ? "m4a"
      : mime.includes("wav")
        ? "wav"
        : "webm";
  return transcribe({
    audio: payload.audio,
    mimeType: mime,
    filename: `audio.${ext}`,
    model: resolved.model,
    creds: resolved.creds,
    language: payload.language,
    fetchImpl: fetch,
  });
}

export async function ensureDesktopMicrophoneAccess(): Promise<{ granted: boolean }> {
  if (process.platform !== "darwin") return { granted: true };
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return { granted: true };
  const granted = await systemPreferences.askForMediaAccess("microphone");
  return { granted };
}

/** Voice input (speech-to-text) and microphone-access routes. */
export function registerSpeechIpc() {
  ipcMain.handle(
    "stt:transcribe",
    async (
      _e,
      payload: {
        cwd: string;
        audio: ArrayBuffer;
        mimeType?: string;
        provider?: string;
        language?: string;
      },
    ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
      const { cwd, audio, mimeType, provider, language } = payload ?? {};
      if (
        typeof cwd !== "string" ||
        !(audio instanceof ArrayBuffer) ||
        audio.byteLength === 0 ||
        audio.byteLength > 25 * 1024 * 1024 ||
        (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.length > 256)) ||
        (provider !== undefined && (typeof provider !== "string" || provider.length > 512)) ||
        (language !== undefined && (typeof language !== "string" || language.length > 64))
      ) {
        return { ok: false, error: "bad-request" };
      }
      const authorizedCwd = await requireRendererProjectPath(cwd);
      return transcribeConfiguredAudio({
        cwd: authorizedCwd,
        audio: new Uint8Array(audio),
        ...(typeof mimeType === "string" ? { mimeType } : {}),
        ...(typeof provider === "string" ? { provider } : {}),
        ...(typeof language === "string" ? { language } : {}),
      });
    },
  );
  ipcMain.handle("stt:available", async (_e, cwd: string) => ({
    available: isTranscribeAvailable(await requireRendererProjectPath(cwd)),
  }));
  // What voice input will ACTUALLY use right now (configured connection vs reused
  // OpenAI key vs none) — key already masked in core. Lets the connection page
  // show the active/fallback config instead of looking unconfigured.
  ipcMain.handle("stt:describe", async (_e, cwd: string) =>
    describeTranscribe(await requireRendererProjectPath(cwd)),
  );
  // macOS gates microphone access at the OS level (TCC). Ask BEFORE getUserMedia
  // so the user gets the system prompt with our NSMicrophoneUsageDescription, and
  // so a previously-denied state is reported back (renderer then shows guidance).
  // No-op / always-true on other platforms. Returns whether access is granted.
  ipcMain.handle("stt:ensureMicAccess", async (): Promise<{ granted: boolean }> => {
    return ensureDesktopMicrophoneAccess();
  });
}
