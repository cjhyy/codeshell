import { cloneMediaJson } from "./media-storage.js";

// Read-only migration adapter for historical Host receipts. These fields do not
// register processors or validate a Panel's current business schema.
const LEGACY_FIELDS: Record<string, string[]> = {
  prepare: ["assetId", "transcribe"],
  transcribe: ["assetId", "language"],
  inspect: ["assetId"],
  proxy: ["assetId", "width", "height", "maxWidth"],
  thumbnail: ["assetId", "seconds", "width"],
  waveform: ["assetId", "points"],
  silence: ["assetId", "thresholdDb", "minSeconds"],
  scenes: ["assetId", "threshold"],
  render: ["project", "sources", "subtitleMode"],
  scene: ["params"],
  tts: ["modelId", "text", "voiceId", "rate"],
  "tts-managed": ["providerId", "text", "voiceId", "rate"],
  "tts-online": ["modelId", "text", "voiceId", "rate", "instructions"],
  "tts-setup": ["providerId"],
  "audio-extract": ["assetId", "inFrame", "outFrame", "fps"],
  "audio-enhance": ["assetId", "preset", "denoise", "normalize"],
};
const PRIVATE_KEY =
  /(?:path|directory|endpoint|credential|password|secret|token|authorization|api.?key|headers|environment|env$)/i;
function publicValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Historical recipe is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    // Host paths cannot be revived as implicit authority in a Panel process.
    if (/^(?:\/|\\|[a-z]:[\\/]|file:)/i.test(value) || /https?:\/\/[^/\s]*@/i.test(value))
      return undefined;
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => publicValue(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) continue;
    const projected = publicValue(item, depth + 1);
    if (projected !== undefined) out[key] = projected;
  }
  return out;
}
export function legacyJobRecipe(job: { id: string; type: string; input: unknown }) {
  const fields = LEGACY_FIELDS[job.type];
  if (!fields || !job.input || typeof job.input !== "object" || Array.isArray(job.input))
    throw new Error(
      "This historical job cannot be restored safely; select its inputs in the Panel again",
    );
  const input = cloneMediaJson(job.input, 192 * 1024) as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const key of fields) {
    const value = publicValue(input[key]);
    if (value !== undefined) params[key] = value;
  }
  return { id: job.id, type: job.type, params };
}
