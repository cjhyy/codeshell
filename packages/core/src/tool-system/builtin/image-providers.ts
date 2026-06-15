/**
 * ImageProvider — adapter interface for text-to-image generation (TODO 7.1).
 *
 * Lifts the hardcoded OpenAI `gpt-image-2` call out of generate-image.ts so
 * GenerateImage can target multiple providers (OpenAI now; Gemini next) and
 * take an optional provider/model. Each adapter takes resolved credentials +
 * the request and returns a base64 PNG (or an error string). The tool layer
 * owns credential resolution from settings, file writing, and user-facing
 * formatting — adapters are pure "creds + prompt → bytes".
 *
 * `fetch` is injected so adapters are unit-testable without network. Production
 * call sites pass the global `fetch`.
 */

export interface ImageProviderCreds {
  baseUrl: string;
  apiKey: string;
}

/** A decoded reference/input image for image-to-image (edit) requests. */
export interface InputImage {
  /** File name hint (used as the multipart part filename). */
  filename: string;
  /** MIME type, e.g. "image/png" | "image/jpeg" | "image/webp". */
  mimeType: string;
  /** Raw bytes (NOT base64) — the tool layer decodes the workspace file. */
  bytes: Uint8Array;
}

export interface ImageGenerateRequest {
  prompt: string;
  size: string;
  quality: string;
  model: string;
  creds: ImageProviderCreds;
  /**
   * Optional reference images. When present, this becomes an image-TO-image
   * (edit) request rather than text-to-image: the provider conditions the
   * output on these inputs (OpenAI `/images/edits`, Gemini inline_data parts).
   * Empty/undefined = plain text-to-image.
   */
  inputImages?: InputImage[];
  /** Optional cancellation signal forwarded to fetch. */
  signal?: AbortSignal;
}

export type ImageGenerateResult =
  | { ok: true; b64: string }
  | { ok: false; error: string };

export interface ImageProvider {
  /** Adapter id — matches the settings provider `kind` it consumes. */
  readonly kind: string;
  generate(req: ImageGenerateRequest): Promise<ImageGenerateResult>;
}

/**
 * OpenAI Images API adapter (`/images/generations`, b64_json). Identical wire
 * behavior to the pre-refactor generate-image.ts: POST model/prompt/size/
 * quality/n, read data[0].b64_json.
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly kind = "openai";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    // Trim a trailing slash so `${baseUrl}/images/...` doesn't double up.
    const baseUrl = req.creds.baseUrl.replace(/\/+$/, "");
    const hasInputs = !!req.inputImages && req.inputImages.length > 0;
    let resp: Response;
    try {
      if (hasInputs) {
        // Image-to-image → the EDITS endpoint, which takes multipart/form-data
        // with one or more `image[]` parts (gpt-image accepts up to 16). Do NOT
        // set Content-Type manually — fetch sets the multipart boundary.
        const form = new FormData();
        form.append("model", req.model);
        form.append("prompt", req.prompt);
        if (req.size && req.size !== "auto") form.append("size", req.size);
        if (req.quality && req.quality !== "auto") form.append("quality", req.quality);
        form.append("n", "1");
        for (const img of req.inputImages!) {
          // Copy into a fresh Uint8Array so the Blob gets a clean ArrayBuffer
          // (avoids SharedArrayBuffer / offset typing issues across runtimes).
          const buf = Uint8Array.from(img.bytes);
          form.append("image[]", new Blob([buf], { type: img.mimeType }), img.filename);
        }
        resp = await this.fetchImpl(`${baseUrl}/images/edits`, {
          method: "POST",
          headers: { Authorization: `Bearer ${req.creds.apiKey}` },
          body: form,
          signal: req.signal,
        });
      } else {
        resp = await this.fetchImpl(`${baseUrl}/images/generations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${req.creds.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: req.model,
            prompt: req.prompt,
            size: req.size,
            quality: req.quality,
            n: 1,
          }),
          signal: req.signal,
        });
      }
    } catch (err) {
      return { ok: false, error: `request failed: ${(err as Error).message}` };
    }

    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 500);
      return { ok: false, error: `image API returned ${resp.status}: ${body}` };
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      return { ok: false, error: `could not parse image API response: ${(err as Error).message}` };
    }

    const b64 = (json as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) {
      const preview = JSON.stringify(json).slice(0, 500);
      return { ok: false, error: `no image in response: ${preview}` };
    }
    return { ok: true, b64 };
  }
}

/**
 * Gemini Images adapter — the `generateContent` endpoint
 * (`/models/{model}:generateContent`), API key in the `x-goog-api-key`
 * header, prompt as a text content-part, PNG returned base64 in
 * `candidates[].content.parts[].inline_data.data` (REST may camelCase it to
 * `inlineData`; we read both). Wire shape per ai.google.dev image-generation
 * docs. The OpenAI-style `size`/`quality` args don't map 1:1 to Gemini's
 * aspectRatio/imageSize, so we only forward the prompt + IMAGE modality and
 * leave Gemini's own defaults for dimensions (a later pass can map size →
 * aspectRatio if needed).
 */
export class GeminiImageProvider implements ImageProvider {
  readonly kind = "google";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    // Image generation uses the NATIVE Gemini REST path
    // (`{base}/models/{model}:generateContent`). A provider configured for
    // Gemini's OpenAI-compatibility layer carries a `…/openai` baseUrl (fine
    // for chat) — strip that suffix so images hit the native endpoint without
    // the user needing a second provider entry. A native `…/v1beta` baseUrl is
    // left untouched.
    const baseUrl = req.creds.baseUrl.replace(/\/+$/, "").replace(/\/openai$/, "");
    let resp: Response;
    try {
      // Image-to-image: Gemini conditions on input images passed as additional
      // inline_data parts alongside the text prompt (base64, no data: prefix).
      const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
      for (const img of req.inputImages ?? []) {
        parts.push({
          inline_data: {
            mime_type: img.mimeType,
            data: Buffer.from(img.bytes).toString("base64"),
          },
        });
      }
      resp = await this.fetchImpl(`${baseUrl}/models/${req.model}:generateContent`, {
        method: "POST",
        headers: {
          "x-goog-api-key": req.creds.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        signal: req.signal,
      });
    } catch (err) {
      return { ok: false, error: `request failed: ${(err as Error).message}` };
    }

    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 500);
      return { ok: false, error: `image API returned ${resp.status}: ${body}` };
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      return { ok: false, error: `could not parse image API response: ${(err as Error).message}` };
    }

    const parts =
      (json as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })
        ?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      // Accept both snake_case (inline_data) and camelCase (inlineData).
      const inline = (part.inline_data ?? part.inlineData) as { data?: string } | undefined;
      if (inline?.data) return { ok: true, b64: inline.data };
    }
    const preview = JSON.stringify(json).slice(0, 500);
    return { ok: false, error: `no image in response: ${preview}` };
  }
}

/** Default model per provider kind when the caller doesn't specify one. */
export const DEFAULT_IMAGE_MODEL: Record<string, string> = {
  openai: "gpt-image-2",
  // Nano Banana — the current recommended Gemini image model. Override per call
  // via GenerateImage's `model` arg when a newer one (e.g. gemini-3.1-flash-image) is wanted.
  google: "gemini-2.5-flash-image",
};

/** Registry of available image-provider adapters, keyed by `kind`. */
export function getImageProvider(kind: string, fetchImpl: typeof fetch = fetch): ImageProvider | null {
  switch (kind) {
    case "openai":
      return new OpenAIImageProvider(fetchImpl);
    case "google":
      return new GeminiImageProvider(fetchImpl);
    default:
      return null;
  }
}
