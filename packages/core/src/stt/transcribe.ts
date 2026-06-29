/**
 * Speech-to-text transcription service (voice input / dictation).
 *
 * A NON-tool, pure "creds + audio bytes → text" service: the desktop composer
 * records the user's voice and calls this to fill the input box (Codex-style
 * dictation). It is deliberately NOT an agent tool — the user is speaking their
 * own prompt, not asking the model to transcribe a file.
 *
 * Targets the OpenAI-compatible `/audio/transcriptions` endpoint, which a single
 * adapter covers across OpenAI (whisper-1 / gpt-4o-transcribe), Groq
 * (whisper-large-v3-turbo), and self-hosted whisper.cpp servers — they share
 * the same multipart wire shape; only baseUrl + model differ.
 *
 * `fetch` is injected so this is unit-testable without network (mirrors
 * image-providers.ts). Production callers pass the global `fetch`.
 */

export interface TranscribeCreds {
  baseUrl: string;
  apiKey: string;
}

export interface TranscribeRequest {
  /** Raw audio bytes (NOT base64) — e.g. a webm/opus recording. */
  audio: Uint8Array;
  /** MIME type of the audio, e.g. "audio/webm". */
  mimeType: string;
  /** Multipart part filename hint (extension matters to some servers). */
  filename: string;
  /** Model id, e.g. "gpt-4o-transcribe" | "whisper-1". */
  model: string;
  creds: TranscribeCreds;
  /** Optional ISO-639-1 language hint (improves accuracy / latency). */
  language?: string;
  /** Optional cancellation signal forwarded to fetch. */
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Transcribe audio via an OpenAI-compatible `/audio/transcriptions` endpoint.
 * Posts multipart/form-data (file + model + response_format[+ language]) with a
 * Bearer key; reads `{ text }` from the JSON response. Do NOT set Content-Type
 * manually — fetch derives the multipart boundary from the FormData body.
 */
export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  const fetchImpl = req.fetchImpl ?? fetch;
  // Trim trailing slashes so `${baseUrl}/audio/...` doesn't double up.
  const baseUrl = req.creds.baseUrl.replace(/\/+$/, "");

  const form = new FormData();
  // Copy into a fresh Uint8Array so the Blob gets a clean ArrayBuffer (avoids
  // SharedArrayBuffer / byteOffset typing issues across runtimes).
  const buf = Uint8Array.from(req.audio);
  form.append("file", new Blob([buf], { type: req.mimeType }), req.filename);
  form.append("model", req.model);
  form.append("response_format", "json");
  if (req.language) form.append("language", req.language);

  let resp: Response;
  try {
    resp = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${req.creds.apiKey}` },
      body: form,
      signal: req.signal,
    });
  } catch (err) {
    return { ok: false, error: `request failed: ${(err as Error).message}` };
  }

  if (!resp.ok) {
    const body = (await resp.text().catch(() => "")).slice(0, 500);
    return { ok: false, error: `transcription API returned ${resp.status}: ${body}` };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    return { ok: false, error: `could not parse transcription response: ${(err as Error).message}` };
  }

  const text = (json as { text?: unknown })?.text;
  if (typeof text !== "string") {
    const preview = JSON.stringify(json).slice(0, 500);
    return { ok: false, error: `no text in transcription response: ${preview}` };
  }
  return { ok: true, text };
}
