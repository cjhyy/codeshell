import type { MediaPreviewRequest, MediaPreviewResult } from "./media-preview.js";

/** Only the native csmedia handler can open/pull a stream. A renderer receives
 * the opaque preview URL and never an open stream identifier or file path. */
export interface MediaProtocolOperations {
  "media/create": {
    input: { ownerId: number; request: MediaPreviewRequest };
    result: MediaPreviewResult | null;
  };
  "media/release": { input: { ownerId: number; url: string }; result: void };
  "media/releaseOwner": { input: number; result: void };
  "media/releaseSession": { input: string; result: void };
  "media/open": {
    input: { stream: string; url: string; method: string; range: string | null };
    result: { status: number; headers: Record<string, string>; body: boolean };
  };
  "media/pull": { input: string; result: Uint8Array | null };
  "media/cancel": { input: string; result: void };
}
