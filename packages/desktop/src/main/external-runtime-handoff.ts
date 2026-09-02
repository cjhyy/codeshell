import type { RawTranscriptEvent } from "./rawTranscript.js";

const MAX_HANDOFF_CHARS = 48_000;
const MAX_LINE_CHARS = 12_000;

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MAX_LINE_CHARS);
  } catch {
    return "[unserializable]";
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value): string[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const block = value as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        return [`TOOL CALL ${name}: ${boundedJson(block.input ?? {})}`];
      }
      if (block.type === "tool_result") {
        return [`TOOL RESULT: ${contentText(block.content) || boundedJson(block.content)}`];
      }
      return [];
    })
    .join("\n");
}

/**
 * Build the same bounded continuity handoff as the renderer path, but from the
 * canonical on-disk transcript. Panel App submissions originate in main and do
 * not have access to the renderer's folded message state.
 */
export function buildExternalRuntimeHandoffFromEvents(
  events: readonly RawTranscriptEvent[],
): string | undefined {
  const lines = events.flatMap((event): string[] => {
    if (event.type !== "message") return [];
    const text = contentText(event.data.content).trim();
    if (!text) return [];
    const role = event.data.role;
    if (role === "assistant") return [`ASSISTANT: ${text}`];
    if (role === "system" || event.data.injected === true) return [`SYSTEM NOTE: ${text}`];
    if (role === "user") return [`USER: ${text}`];
    return [];
  });
  if (lines.length === 0) return undefined;

  const selected: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.slice(0, MAX_LINE_CHARS);
    if (used + line.length > MAX_HANDOFF_CHARS) break;
    selected.unshift(line);
    used += line.length;
  }
  return [
    "<codeshell_conversation_handoff>",
    "Continue the existing CodeShell task using this recent conversation. Do not ask the user to repeat context already present here.",
    ...selected,
    "</codeshell_conversation_handoff>",
  ].join("\n\n");
}
