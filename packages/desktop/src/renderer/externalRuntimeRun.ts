/**
 * Running one turn on an external Agent Runtime (Codex / Claude Code).
 *
 * The renderer treats these exactly like a model choice: the user picks
 * `codex/gpt-5.6-sol` from the ordinary dropdown and sends. This module is the only
 * place that knows the turn goes somewhere else, and it exists to make the
 * external path return the SAME shape as `window.codeshell.run`, so the caller's
 * bookkeeping — busy clearing, error surfacing, logging — stays shared.
 *
 * Duplicating that bookkeeping is how one path ends up permanently stuck
 * "busy" after a failure the other path handles, so the seam is deliberately
 * this narrow.
 */
import type { InputAttachmentMeta } from "../preload/types";
import type { Message } from "./types";

/** The subset of the preload surface this needs. Injected for testability. */
export interface ExternalRuntimeBridge {
  start(payload: {
    sessionId: string;
    cwd: string;
    modelKey: string;
    permissionMode?: string;
    planMode?: boolean;
    hasGoal?: boolean;
    initialContext?: string;
    developerInstructions?: string;
  }): Promise<{ kind: string; runtimeSessionId: string | null; tools: string[] }>;
  send(payload: {
    sessionId: string;
    text: string;
    clientMessageId?: string;
    attachments?: InputAttachmentMeta[];
  }): Promise<{ ok: boolean; reason?: string; text?: string; streamed?: boolean } | void>;
}

export interface ExternalRuntimeTurnArgs {
  sessionId: string;
  cwd: string;
  modelKey: string;
  text: string;
  clientMessageId?: string;
  attachments?: InputAttachmentMeta[];
  permissionMode?: string;
  planMode?: boolean;
  hasGoal?: boolean;
  initialContext?: string;
  developerInstructions?: string;
  runtime: ExternalRuntimeBridge;
}

/**
 * Mirrors the engine's RunResult closely enough for the shared `.then` handler:
 * it reads `ok`/`reason`/`text` to decide whether to surface an early failure.
 */
export interface ExternalRuntimeRunResult {
  ok: boolean;
  reason?: string;
  text?: string;
  streamed?: boolean;
}

/**
 * Sessions already started on this runtime, so a follow-up turn does not
 * restart the process and lose its context.
 *
 * Keyed by session id. `start` is idempotent in the service (it closes and
 * replaces), which is exactly what must NOT happen mid-conversation: a restart
 * would drop the runtime's own thread and the user would silently lose history.
 *
 * This renderer cache is deliberately in-memory. Desktop persists the real
 * runtime thread binding beside the canonical Session transcript, so after an
 * app restart the first `start` call resumes that thread (or falls back to the
 * bounded transcript handoff supplied by the renderer). Keeping this map
 * durable as well would create a second, stale source of truth.
 */
const startedSessions = new Map<string, string>();
/** Serializes the renderer's start-if-needed + send transaction per session. */
const turnTails = new Map<string, Promise<void>>();
/** Invalidates queued/in-flight cache updates when a session is forgotten. */
const sessionEpochs = new Map<string, number>();

const MAX_HANDOFF_CHARS = 48_000;

/** Bounded renderer projection used only when no durable runtime thread resumes. */
export function buildExternalRuntimeHandoff(messages: readonly Message[]): string | undefined {
  const lines = messages.flatMap((message): string[] => {
    switch (message.kind) {
      case "user":
        return [`USER: ${message.text}`];
      case "assistant":
        return message.text ? [`ASSISTANT: ${message.text}`] : [];
      case "system":
        return message.text ? [`SYSTEM NOTE: ${message.text}`] : [];
      case "tool": {
        const result = message.error ?? message.result;
        return result
          ? [`TOOL ${message.toolName}: ${result}`]
          : [`TOOL ${message.toolName} called with ${message.args}`];
      }
      default:
        return [];
    }
  });
  if (lines.length === 0) return undefined;
  const selected: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.slice(0, 12_000);
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

/** Forget a session's runtime binding (session deleted, or runtime stopped). */
export function forgetExternalRuntimeSession(sessionId: string): void {
  startedSessions.delete(sessionId);
  turnTails.delete(sessionId);
  sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetExternalRuntimeSessions(): void {
  startedSessions.clear();
  turnTails.clear();
  sessionEpochs.clear();
}

/**
 * Provider-side thread ids must never become CodeShell business session ids.
 * External runs are anchored to the stable UI id; native legacy sessions keep
 * honoring their existing engine binding.
 */
export function resolveRunSessionId(
  uiSessionId: string,
  boundEngineSessionId: string | undefined,
  externalRuntime: boolean,
): string {
  return externalRuntime ? uiSessionId : (boundEngineSessionId ?? uiSessionId);
}

/**
 * Start the session if needed, then send one turn.
 *
 * Resolves when the turn completes, matching `agent/run`: the caller treats
 * resolution as "the turn is over", and resolving early would clear busy while
 * the model is still streaming.
 */
export function runExternalRuntimeTurn(args: ExternalRuntimeTurnArgs): Promise<ExternalRuntimeRunResult> {
  const { sessionId } = args;
  const epoch = sessionEpochs.get(sessionId) ?? 0;
  const previous = turnTails.get(sessionId) ?? Promise.resolve();
  const result = previous.then(
    () => runExternalRuntimeTurnExclusive(args, epoch),
    () => runExternalRuntimeTurnExclusive(args, epoch),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  turnTails.set(sessionId, tail);
  void tail.then(() => {
    if (turnTails.get(sessionId) === tail) turnTails.delete(sessionId);
  });
  return result;
}

async function runExternalRuntimeTurnExclusive({
  sessionId,
  cwd,
  modelKey,
  text,
  clientMessageId,
  attachments,
  permissionMode,
  planMode,
  hasGoal,
  initialContext,
  developerInstructions,
  runtime,
}: ExternalRuntimeTurnArgs, epoch: number): Promise<ExternalRuntimeRunResult> {
  try {
    if ((sessionEpochs.get(sessionId) ?? 0) !== epoch) {
      return {
        ok: false,
        reason: "external_runtime_error",
        text: "External runtime session was closed before its queued turn started.",
      };
    }
    // Restart only when the model actually changed. Switching Codex → Claude
    // mid-session has to rebuild the backend; re-sending on the same one must
    // not, or every turn would begin with an empty context.
    const configurationKey = JSON.stringify({ modelKey, permissionMode, planMode });
    if (startedSessions.get(sessionId) !== configurationKey) {
      await runtime.start({
        sessionId,
        cwd,
        modelKey,
        ...(permissionMode ? { permissionMode } : {}),
        ...(planMode !== undefined ? { planMode } : {}),
        ...(hasGoal !== undefined ? { hasGoal } : {}),
        ...(initialContext ? { initialContext } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      });
      if ((sessionEpochs.get(sessionId) ?? 0) !== epoch) {
        return {
          ok: false,
          reason: "external_runtime_error",
          text: "External runtime session was closed while it was starting.",
        };
      }
      startedSessions.set(sessionId, configurationKey);
    }
    const result = await runtime.send({
      sessionId,
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    if (
      result &&
      !result.ok &&
      (sessionEpochs.get(sessionId) ?? 0) === epoch
    ) {
      startedSessions.delete(sessionId);
    }
    return result ?? { ok: true };
  } catch (error) {
    // A failed start leaves no usable session — drop the binding so the next
    // attempt retries the start instead of sending into a runtime that is not
    // there.
    if ((sessionEpochs.get(sessionId) ?? 0) === epoch) startedSessions.delete(sessionId);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "external_runtime_error", text: message };
  }
}
