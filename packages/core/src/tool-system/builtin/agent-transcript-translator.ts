/**
 * Translate child Engine StreamEvents into ChatEntry-shaped objects so the
 * AgentDock detail view (which reuses App.renderEntry) can show a sub-agent's
 * conversation in the same visual language as the main feed.
 *
 * The transcript is the canonical record for one background sub-agent. State
 * (current thinking entry, currently-streaming assistant_text, in-flight
 * tool_start map) lives in a per-agent translator. Each translator instance
 * appends ChatEntry-shaped objects via `append` and mutates them via `update`,
 * mirroring how App.tsx's handleStreamEvent talks to chatStore but isolated to
 * a single agent's transcript.
 *
 * The output shapes intentionally match `src/ui/store.ts#ChatEntryData` so the
 * existing renderEntry switch picks them up without code changes.
 */
import type { StreamEvent } from "../../types.js";
import {
  asyncAgentRegistry,
  type AgentTranscriptEntry,
} from "./agent-registry.js";

interface TranslatedEntry {
  id: string;
  type: string;
  [key: string]: unknown;
}

let entryIdCounter = 0;
function nextId(agentId: string): string {
  return `bg-${agentId}-${++entryIdCounter}`;
}

/**
 * Create a transcript translator scoped to one background sub-agent. Returned
 * function is a StreamCallback drop-in: feed it the child Engine's events and
 * it maintains the agent's transcript in `asyncAgentRegistry`.
 */
export function createTranscriptTranslator(
  agentId: string,
): (event: StreamEvent) => void {
  // Local state for THIS agent. Background sub-agents run independently so
  // each gets its own translator; no cross-agent state.
  let streamingAssistantId: string | undefined;
  let thinkingId: string | undefined;
  // toolCallId → tool_start entry id. Lets tool_use_args_delta find the right
  // tool_start to patch.
  const toolStartByCallId = new Map<string, string>();

  function patchEntry(
    entryId: string,
    patch: (e: AgentTranscriptEntry) => AgentTranscriptEntry,
  ): void {
    const a = asyncAgentRegistry.get(agentId);
    if (!a?.transcript) return;
    const idx = a.transcript.findIndex((e) => e.id === entryId);
    if (idx < 0) return;
    a.transcript[idx] = patch(a.transcript[idx]!);
    asyncAgentRegistry.touchTranscript(agentId);
  }

  function dropEntry(entryId: string): void {
    const a = asyncAgentRegistry.get(agentId);
    if (!a?.transcript) return;
    a.transcript = a.transcript.filter((e) => e.id !== entryId);
    asyncAgentRegistry.touchTranscript(agentId);
  }

  function append(data: Omit<TranslatedEntry, "id">): string {
    const id = nextId(agentId);
    asyncAgentRegistry.appendToTranscript(agentId, {
      ...data,
      id,
    } as AgentTranscriptEntry);
    return id;
  }

  return (event: StreamEvent) => {
    switch (event.type) {
      // ── thinking ─────────────────────────────────────────────────
      case "stream_request_start": {
        if (thinkingId) {
          dropEntry(thinkingId);
          thinkingId = undefined;
        }
        thinkingId = append({ type: "thinking", agentId });
        break;
      }

      case "thinking_delta": {
        // Sub-agent thinking content is collapsed in the dock view — we
        // don't replicate the verb spinner. Keep the empty thinking
        // placeholder; renderEntry shows it as a spinner row.
        break;
      }

      // ── assistant text (streaming) ───────────────────────────────
      case "text_delta": {
        if (thinkingId) {
          dropEntry(thinkingId);
          thinkingId = undefined;
        }
        if (streamingAssistantId) {
          patchEntry(streamingAssistantId, (e) => ({
            ...e,
            text: String(e.text ?? "") + (event as any).text,
          }));
        } else {
          streamingAssistantId = append({
            type: "assistant_text",
            text: (event as any).text,
            streaming: true,
            agentId,
          });
        }
        break;
      }

      // ── tool call ────────────────────────────────────────────────
      case "tool_use_start": {
        if (streamingAssistantId) {
          patchEntry(streamingAssistantId, (e) => ({ ...e, streaming: false }));
          streamingAssistantId = undefined;
        }
        if (thinkingId) {
          dropEntry(thinkingId);
          thinkingId = undefined;
        }
        const tc = (event as any).toolCall;
        const startId = append({
          type: "tool_start",
          toolName: tc.toolName,
          args: tc.args,
          toolCallId: tc.id,
          agentId,
        });
        if (tc.id) toolStartByCallId.set(tc.id, startId);
        append({ type: "tool_running", toolName: tc.toolName, agentId });
        break;
      }

      case "tool_use_args_delta": {
        const ev = event as any;
        const startId = toolStartByCallId.get(ev.toolCallId);
        if (!startId) break;
        patchEntry(startId, (e) => ({ ...e, args: ev.args }));
        break;
      }

      case "tool_result": {
        const r = (event as any).result;
        const a = asyncAgentRegistry.get(agentId);
        if (a?.transcript) {
          a.transcript = a.transcript.filter(
            (e) => !(e.type === "tool_running" && (e as any).toolName === r.toolName),
          );
          asyncAgentRegistry.touchTranscript(agentId);
        }
        append({
          type: "tool_result",
          toolName: r.toolName,
          result: r.result,
          error: r.error,
          agentId,
        });
        break;
      }

      // ── lifecycle: finalize streaming on turn end ───────────────
      case "turn_complete":
      case "tombstone": {
        if (streamingAssistantId) {
          patchEntry(streamingAssistantId, (e) => ({ ...e, streaming: false }));
          streamingAssistantId = undefined;
        }
        if (thinkingId) {
          dropEntry(thinkingId);
          thinkingId = undefined;
        }
        break;
      }

      // ── errors surface as a card in the transcript ──────────────
      case "error": {
        if (thinkingId) {
          dropEntry(thinkingId);
          thinkingId = undefined;
        }
        append({
          type: "error",
          error: (event as any).error,
          agentId,
        });
        break;
      }

      default:
        break;
    }
  };
}
