import { createPanelResourceUpload } from "./panel-resource-upload.js";

/** Compatibility entry: keep the existing audio formats and byte limit. */
export function createPanelAudioUpload(
  options: Omit<Parameters<typeof createPanelResourceUpload>[0], "maxBytes" | "mimeTypes">,
) {
  return createPanelResourceUpload({
    ...options,
    maxBytes: 25 * 1024 * 1024,
    mimeTypes: ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"],
  });
}
