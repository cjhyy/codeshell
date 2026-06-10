/**
 * ImageUploader — pluggable "local path → public URL" so image-to-video /
 * reference-to-video can accept local files, not just URLs. fal storage is the
 * first impl; swapping in another image host = another impl, no provider change.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface UploaderCreds {
  baseUrl: string;
  apiKey: string;
}

export type UploadResult = { ok: true; url: string } | { ok: false; error: string };

export interface ImageUploader {
  readonly kind: string;
  /** http/https → unchanged; local path → upload, return public URL. */
  toUrl(pathOrUrl: string, creds: UploaderCreds, signal?: AbortSignal): Promise<UploadResult>;
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  return map[ext] ?? "application/octet-stream";
}

export class FalStorageUploader implements ImageUploader {
  readonly kind = "fal";
  // fal upload lives on a different host than queue.fal.run.
  private static readonly UPLOAD_BASE = "https://rest.alpha.fal.ai";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async toUrl(pathOrUrl: string, creds: UploaderCreds, signal?: AbortSignal): Promise<UploadResult> {
    if (isHttpUrl(pathOrUrl)) return { ok: true, url: pathOrUrl };
    try {
      const bytes = await readFile(pathOrUrl);
      const url = await this.uploadBytes(bytes, basename(pathOrUrl), creds, signal);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: `fal upload error for ${pathOrUrl}: ${(err as Error).message}` };
    }
  }

  /**
   * Upload raw bytes to fal storage, return the public URL. Two-step flow
   * (verified against live API 2026-06-10):
   *   1. POST {UPLOAD_BASE}/storage/upload/initiate → { file_url, upload_url }
   *   2. PUT <upload_url> with the bytes (signed URL, no Authorization)
   *   3. file_url is the final public URL.
   */
  private async uploadBytes(bytes: Uint8Array, name: string, creds: UploaderCreds, signal?: AbortSignal): Promise<string> {
    const mime = mimeFromName(name);
    const ini = await this.fetchImpl(`${FalStorageUploader.UPLOAD_BASE}/storage/upload/initiate`, {
      method: "POST",
      headers: { Authorization: `Key ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: mime, file_name: name }),
      signal,
    });
    if (!ini.ok) throw new Error(`initiate failed: HTTP ${ini.status}`);
    const { file_url, upload_url } = (await ini.json()) as { file_url?: string; upload_url?: string };
    if (!file_url || !upload_url) throw new Error("initiate: missing file_url/upload_url");
    const put = await this.fetchImpl(upload_url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: bytes,
      signal,
    });
    if (!put.ok) throw new Error(`upload PUT failed: HTTP ${put.status}`);
    return file_url;
  }
}

export function getImageUploader(kind: string, fetchImpl: typeof fetch = fetch): ImageUploader | null {
  switch (kind) {
    case "fal":
      return new FalStorageUploader(fetchImpl);
    default:
      return null;
  }
}
