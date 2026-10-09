/** Bounded, domain-neutral requests for the trusted browser's recording chooser. */
export const panelVideoLimits = Object.freeze({
  maxDurationSeconds: 1200,
  maxBytes: 200 * 1024 * 1024,
  defaultDurationSeconds: 300,
  defaultBytes: 64 * 1024 * 1024,
});

export interface PanelVideoOptions {
  source: "camera" | "screen";
  microphone: boolean;
  systemAudio: boolean;
  maxDurationSeconds: number;
  maxBytes: number;
}

export function panelVideoOptions(raw: unknown): PanelVideoOptions {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !["source", "microphone", "systemAudio", "maxDurationSeconds", "maxBytes"].includes(key),
    ) ||
    (value.source !== "camera" && value.source !== "screen") ||
    (value.microphone !== undefined && typeof value.microphone !== "boolean") ||
    (value.systemAudio !== undefined && typeof value.systemAudio !== "boolean") ||
    (value.source !== "screen" && value.systemAudio === true)
  )
    throw new Error("视频录制请求无效。");
  const maxDurationSeconds = value.maxDurationSeconds ?? panelVideoLimits.defaultDurationSeconds;
  const maxBytes = value.maxBytes ?? panelVideoLimits.defaultBytes;
  if (
    !Number.isSafeInteger(maxDurationSeconds) ||
    Number(maxDurationSeconds) < 1 ||
    Number(maxDurationSeconds) > panelVideoLimits.maxDurationSeconds ||
    !Number.isSafeInteger(maxBytes) ||
    Number(maxBytes) < 1 ||
    Number(maxBytes) > panelVideoLimits.maxBytes
  )
    throw new Error("视频录制限制无效。");
  return {
    source: value.source as "camera" | "screen",
    microphone: value.microphone !== false,
    systemAudio: value.systemAudio === true,
    maxDurationSeconds: Number(maxDurationSeconds),
    maxBytes: Number(maxBytes),
  };
}
