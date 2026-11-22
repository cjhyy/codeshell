export type MediaPreviewKind = "audio" | "video";

export interface MediaPreviewRequest {
  sessionId: string;
  path: string;
  /** Expected Session main root; stale renderer views must fail closed. */
  rootId?: string;
}

export interface MediaPreviewResult {
  url: string;
  kind: MediaPreviewKind;
  name: string;
  mimeType: string;
}

const MEDIA_TYPES: Readonly<Record<string, { kind: MediaPreviewKind; mimeType: string }>> = {
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  aac: { kind: "audio", mimeType: "audio/aac" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  opus: { kind: "audio", mimeType: "audio/ogg" },
  flac: { kind: "audio", mimeType: "audio/flac" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  m4v: { kind: "video", mimeType: "video/mp4" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  webm: { kind: "video", mimeType: "video/webm" },
  ogv: { kind: "video", mimeType: "video/ogg" },
};

/** Browser-safe classification only: this does not authorize paths or promise codec support. */
export function mediaTypeForPath(path: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? (MEDIA_TYPES[extension] ?? null) : null;
}

export function classifyMediaPath(path: string): MediaPreviewKind | null {
  return mediaTypeForPath(path)?.kind ?? null;
}

export const MEDIA_PREVIEW_SCHEME = "csmedia";

export function parseMediaPreviewRequest(input: unknown): MediaPreviewRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const request = input as MediaPreviewRequest;
  if (
    Object.keys(request).some((key) => !["sessionId", "path", "rootId"].includes(key)) ||
    typeof request.sessionId !== "string" ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(request.sessionId) ||
    request.sessionId.includes("..") ||
    typeof request.path !== "string" ||
    !request.path ||
    request.path.length > 16_384 ||
    request.path.includes("\0") ||
    (request.rootId !== undefined &&
      (typeof request.rootId !== "string" || !request.rootId || request.rootId.length > 512))
  )
    return null;
  return request;
}
