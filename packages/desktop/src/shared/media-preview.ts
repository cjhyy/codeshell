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
