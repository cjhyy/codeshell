import type { PetLongTaskArtifact } from "@cjhyy/code-shell-pet";
import { topLevelEvent } from "../main/pet/session-outcome.js";
const MAX_PET_LONG_TASK_SUMMARY_LENGTH = 8000;
function extractText(value: unknown): string | undefined {
  const collect = (input: unknown): string[] => {
    if (typeof input === "string") return [input];
    if (!Array.isArray(input)) return [];
    return input.flatMap((block) => {
      if (typeof block === "string") return [block];
      if (!block || typeof block !== "object") return [];
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? [record.text] : [];
    });
  };
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const text = collect(record.content ?? record.text)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? text.slice(0, MAX_PET_LONG_TASK_SUMMARY_LENGTH) : undefined;
}

function generatedImageArtifacts(value: unknown): PetLongTaskArtifact[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const event = value as Record<string, unknown>;
  const result = event.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  if (record.toolName !== "GenerateImage" || record.isError === true || record.error) return [];
  const output = [record.transcriptResult, record.displayResult, record.result].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!output) return [];
  const match = /\bsaved to\s+([^\r\n]+?\.(?:png|jpe?g|gif|webp))(?=$|\s)/iu.exec(output);
  const reference = match?.[1]?.trim().replace(/^`|`$/gu, "");
  return reference
    ? [{ kind: "file", label: "Generated image", reference: reference.slice(0, 2_048) }]
    : [];
}

function safeToolName(event: Record<string, unknown>): string {
  const toolCall = event.toolCall;
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const name = (toolCall as Record<string, unknown>).toolName;
  return typeof name === "string"
    ? name.replace(/[^\p{L}\p{N}_.:@/-]+/gu, " ").slice(0, 80)
    : "tool";
}
export interface MimiTaskEvent {
  type: string;
  runId?: string;
  previousRunId?: string;
  clientMessageId?: string;
  summary?: string;
  status?: string;
  gaps?: string;
  toolName?: string;
  artifacts?: PetLongTaskArtifact[];
}
/** Send the fields the task journal consumes. Tool payloads and unrelated streams stay with the worker. */
export function projectMimiTaskEvent(value: unknown): MimiTaskEvent | undefined {
  const event = topLevelEvent(value);
  if (!event || typeof event.type !== "string") return;
  const input: MimiTaskEvent = { type: event.type };
  if (typeof event.runId === "string") input.runId = event.runId;
  if (typeof event.clientMessageId === "string") input.clientMessageId = event.clientMessageId;
  switch (event.type) {
    case "session_started":
      if (typeof event.previousRunId === "string") input.previousRunId = event.previousRunId;
      break;
    case "tool_use_start":
      input.toolName = safeToolName(event);
      break;
    case "tool_result":
      input.artifacts = generatedImageArtifacts(event);
      if (!input.artifacts.length) return;
      break;
    case "assistant_message":
      input.summary = extractText(event.message);
      break;
    case "turn_complete":
      if (typeof event.text === "string") input.summary = extractText(event);
      break;
    case "goal_progress":
      if (typeof event.status === "string") input.status = event.status;
      if (typeof event.gaps === "string") input.gaps = event.gaps;
      break;
    case "stream_request_start":
    case "context_compact":
    case "goal_cleared":
    case "error":
      break;
    default:
      return;
  }
  return input;
}
