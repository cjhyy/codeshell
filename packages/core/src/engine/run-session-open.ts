/**
 * Session open — create-or-resume phase of Engine.runExclusive: the three
 * valid session shapes, clientMessageId claiming (duplicate submits return
 * early), user-message append, cold-start summary and the turnSeq bump.
 */
import { getCurrentSid, logger } from "../logging/logger.js";
import type { Message, SessionKind } from "../types.js";
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import { patchOrphanedToolUses } from "./patch-orphaned-tools.js";
import type { ParsedTask } from "./parse-task.js";
import type { buildRunUserMessageContent } from "./run-image-input.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";

export interface OpenRunSessionArgs {
  sessionManager: SessionManager;
  options: EngineRunOptions | undefined;
  parsedTask: ParsedTask;
  taskText: string;
  userMessageContent: ReturnType<typeof buildRunUserMessageContent>;
  cwd: string;
  sessionKind: SessionKind;
  sessionWorkspaceProfile: string | undefined;
  llmModel: string;
  llmProvider: string;
  isSubAgent: boolean;
  origin: EngineConfig["origin"];
  costStore: EngineConfig["costStore"];
  cachedCompactedMessages: Message[] | undefined;
  onAgentDirectionsDelivered:
    | ((envelopeIds: NonNullable<EngineRunOptions["agentDirection"]>["envelopeIds"]) => void)
    | undefined;
}

export interface OpenedRunSession {
  session: SessionBundle;
  messages: Message[];
  freshImageMessage: Message | undefined;
  resumedFromDisk: boolean;
  claimClientMessageId: (
    bundle: SessionBundle,
    clientMessageId: string | undefined,
    source: "submit" | "steer",
  ) => boolean;
  releaseClientMessageId: (clientMessageId: string) => void;
}

export type OpenRunSessionResult =
  | { ok: true; opened: OpenedRunSession }
  | { ok: false; result: EngineResult };

export function openRunSession(args: OpenRunSessionArgs): OpenRunSessionResult {
  const { options } = args;
  const claimedClientMessageIds = new Set<string>();

  let session: SessionBundle;
  let messages: Message[];
  let freshImageMessage: Message | undefined;
  let resumedFromDisk = false;
  const claimClientMessageId = (
    bundle: SessionBundle,
    clientMessageId: string | undefined,
    source: "submit" | "steer",
  ): boolean => {
    if (!clientMessageId) return true;
    if (
      claimedClientMessageIds.has(clientMessageId) ||
      bundle.transcript.hasClientMessageId(clientMessageId)
    ) {
      logger.info("engine.client_message.duplicate_ignored", {
        sessionId: bundle.state.sessionId,
        clientMessageId,
        source,
      });
      return false;
    }
    claimedClientMessageIds.add(clientMessageId);
    return true;
  };

  if (options?.sessionId && args.sessionManager.exists(options.sessionId)) {
    resumedFromDisk = true;
    session = args.sessionManager.resume(options.sessionId);
    const cachedCompacted = args.cachedCompactedMessages;
    messages = cachedCompacted ? [...cachedCompacted] : session.transcript.toMessages();
    // If the previous run was Ctrl+C'd or crashed between an assistant
    // tool_use and the matching tool_result being persisted, the
    // loaded sequence is invalid for OpenAI (which 400s on dangling
    // tool_calls). Patch synthetic tool_results so the next API call
    // doesn't fail before the turn even starts.
    const patched = patchOrphanedToolUses(messages);
    if (patched.gapsPatched > 0) {
      logger.warn("engine.resume.patched_orphaned_tool_uses", {
        sessionId: options.sessionId,
        gaps: patched.gapsPatched,
        toolResults: patched.toolResultsInjected,
      });
    }
    // Restore cost state from previous session, if the caller injected a store
    if (session.state.costState && args.costStore) {
      args.costStore.restore(session.state.costState);
    }
    // Append new user message
    const userMsg: Message = { role: "user", content: args.userMessageContent };
    if (!claimClientMessageId(session, options?.clientMessageId, "submit")) {
      const usage = session.state.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      return {
        ok: false,
        result: {
          text: "",
          reason: "completed",
          sessionId: session.state.sessionId,
          turnCount: session.state.turnCount ?? 0,
          usage: {
            promptTokens: usage.promptTokens ?? 0,
            completionTokens: usage.completionTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          },
        },
      };
    }
    if (args.parsedTask.hasImages) freshImageMessage = userMsg;
    messages.push(userMsg);
    session.transcript.appendMessage("user", args.userMessageContent, {
      injected: options?.injected === true,
      clientMessageId: options?.clientMessageId,
      ...(options?.agentDirection
        ? {
            authority: "agent" as const,
            source: "agent-direction" as const,
            envelopeIds: options.agentDirection.envelopeIds,
            correlationIds: options.agentDirection.correlationIds,
          }
        : {}),
    });
    if (options?.agentDirection) {
      args.onAgentDirectionsDelivered?.(options.agentDirection.envelopeIds);
    }
    // Flush "active" status to disk immediately. resume() set it in memory
    // (session-manager.ts), but without this write the on-disk state.json
    // still shows the previous run's terminal reason — so any external
    // observer (another CLI process, /sid, the session list) would think
    // the session is still errored/aborted while we're actually running.
    args.sessionManager.saveStateOrUpdateFields(session.state, {
      status: session.state.status,
    });
  } else {
    // Cold start: shape (2) reuses the host-supplied sid; shape (3)
    // lets sessionManager generate one with nanoid.
    session = args.sessionManager.create(
      args.cwd,
      args.llmModel,
      args.llmProvider,
      options?.sessionId,
      args.isSubAgent ? getCurrentSid() : undefined,
      args.isSubAgent ? "subagent" : args.origin,
      args.sessionKind,
    );
    const userMsg: Message = { role: "user", content: args.userMessageContent };
    claimClientMessageId(session, options?.clientMessageId, "submit");
    if (args.parsedTask.hasImages) freshImageMessage = userMsg;
    messages = [userMsg];
    session.transcript.appendMessage("user", args.userMessageContent, {
      injected: options?.injected === true,
      clientMessageId: options?.clientMessageId,
      ...(options?.agentDirection
        ? {
            authority: "agent" as const,
            source: "agent-direction" as const,
            envelopeIds: options.agentDirection.envelopeIds,
            correlationIds: options.agentDirection.correlationIds,
          }
        : {}),
    });
    if (options?.agentDirection) {
      args.onAgentDirectionsDelivered?.(options.agentDirection.envelopeIds);
    }
    // Save first user message as session summary — text only. The summary
    // shows up in the session list; "[image]" is more informative than a
    // truncated `[object Object]` when the prompt was purely visual.
    const summarySrc = args.parsedTask.hasImages
      ? args.parsedTask.text ||
        `[image${args.parsedTask.images.length > 1 ? `s × ${args.parsedTask.images.length}` : ""}]`
      : args.taskText;
    session.state.summary = summarySrc.slice(0, 80).replace(/\n/g, " ");
    args.sessionManager.saveStateOrUpdateFields(session.state, {
      summary: session.state.summary,
    });
  }

  // Bump the conversation-turn counter: this user message starts a new turn.
  // One user message = one turn, regardless of how many turn-loop iterations
  // or tool calls it spans. File-history snapshots taken below are tagged
  // with this value so `/undo` reverts exactly this turn's file changes.
  // (Both resume and cold-start paths converge here.)
  if (
    args.sessionWorkspaceProfile &&
    session.state.workspaceProfile !== args.sessionWorkspaceProfile
  ) {
    session.state.workspaceProfile = args.sessionWorkspaceProfile;
    args.sessionManager.saveStateOrUpdateFields(session.state, {
      workspaceProfile: args.sessionWorkspaceProfile,
    });
  }
  session.state.turnSeq = (session.state.turnSeq ?? 0) + 1;

  return {
    ok: true,
    opened: {
      session,
      messages,
      freshImageMessage,
      resumedFromDisk,
      claimClientMessageId,
      releaseClientMessageId: (id) => {
        claimedClientMessageIds.delete(id);
      },
    },
  };
}
