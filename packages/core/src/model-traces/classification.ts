import type { ModelTraceCallType } from "./types.js";

/** Stable presentation categories, independent of providers, models and Prompt content. */
export const MODEL_TRACE_CALL_TYPES: readonly ModelTraceCallType[] = Object.freeze([
  "execution",
  "task",
  "panel",
  "summary",
  "context",
  "title",
  "goal",
  "memory",
  "suggestion",
  "speech",
  "transcription",
  "audio",
  "external",
  "other",
]);

export function isModelTraceCallType(value: unknown): value is ModelTraceCallType {
  return typeof value === "string" && MODEL_TRACE_CALL_TYPES.includes(value as ModelTraceCallType);
}

const purposes: Readonly<Record<string, ModelTraceCallType>> = Object.freeze({
  aux_summary: "summary",
  tool_summary: "summary",
  manual_compact: "summary",
  context_package: "context",
  title: "title",
  goal_judge: "goal",
  memory_dream_project: "memory",
  memory_dream_user: "memory",
  session_follow_up: "suggestion",
  tts: "speech",
  "tts-clone": "speech",
  "tts-setup-reference": "speech",
  transcribe: "transcription",
  "interview-transcribe": "transcription",
  "voice-separation": "audio",
  external: "external",
  "external-runtime": "external",
  external_delegation: "external",
});

/**
 * Read-time Host projection: older records need no rewrite and stored/client
 * callType values never override the original attribution. Specific auxiliary
 * and media purposes take precedence over their enclosing task or Panel.
 */
export function deriveModelTraceCallType(entry: {
  purpose?: unknown;
  source?: unknown;
  parentSessionId?: unknown;
}): ModelTraceCallType {
  const rawPurpose = typeof entry.purpose === "string" ? entry.purpose : "";
  const purpose = rawPurpose.startsWith("panel/") ? rawPurpose.slice(6) : rawPurpose;
  if (Object.hasOwn(purposes, purpose)) return purposes[purpose];
  if (typeof entry.source === "string" && entry.source.startsWith("panel:")) return "panel";
  if (rawPurpose === "subagent") return "task";
  if (rawPurpose === "main")
    return typeof entry.parentSessionId === "string" && entry.parentSessionId.length > 0
      ? "task"
      : "execution";
  return "other";
}
