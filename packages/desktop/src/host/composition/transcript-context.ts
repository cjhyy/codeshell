import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { assertDesktopSessionId } from "../../main/session-validation.js";
import { getSessionEvents } from "../../main/rawTranscript.js";
import { buildExternalRuntimeHandoffFromEvents } from "../../main/external-runtime-handoff.js";
import type { ShellBusinessOperations } from "../../shared/shell-business-contracts.js";

type Input = ShellBusinessOperations["transcripts/context"]["input"];
const MAX_MESSAGE = 12_000;

/** The text of one transcript message (its text blocks); undefined when it has none. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
  return text || undefined;
}

/** The text of a Session's last message from its user, from its transcript events. */
export function lastUserMessageIn(
  events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "message" || event.data.role !== "user") continue;
    // Host-injected continuations and agent / policy messages are not the user's.
    if (event.data.injected === true) continue;
    const authority = event.data.authority;
    if (authority !== undefined && authority !== "user") continue;
    const text = messageText(event.data.content);
    return text && text.length <= MAX_MESSAGE ? text : undefined;
  }
  return undefined;
}

/** Parse the potentially large raw tail in the storage worker; only bounded text crosses the port. */
export async function readTranscriptContext(root: string, input: Input) {
  assertDesktopSessionId(input.sessionId);
  if (input.kind !== "handoff" && input.kind !== "lastUserMessage")
    throw Error("Unknown transcript context");
  const events = await getSessionEvents(input.sessionId, undefined, root);
  return input.kind === "handoff"
    ? buildExternalRuntimeHandoffFromEvents(events)
    : lastUserMessageIn(events);
}

export function transcriptContextOperation(storage: Promise<StateStorage>) {
  return async (input: Input) => {
    const db = await storage;
    const text = await db.request<string | undefined>("transcripts/context", input);
    if (text === null) throw Error("Transcript storage unavailable");
    return text;
  };
}
