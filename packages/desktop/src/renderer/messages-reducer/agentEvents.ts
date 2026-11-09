/**
 * Sub-agent lifecycle events (start, background handoff, heartbeat, end,
 * background completion) plus the shared background-completion text that
 * App.tsx also uses for its toast. Each handler is one case of the reducer
 * switch in ../types.ts, moved verbatim.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import { sanitizeExternalChangedFilesProvenance } from "../externalFileProvenance";
import { translate } from "../i18n/translate";
import type { MessageClock, MessagesReducerState, SystemMessage } from "../messageTypes";
import { loadUILanguage } from "../uiLanguage";
import { freshId, logChangedFiles, sealToolWithoutResult } from "./helpers";
import { attachExternalChangesToOriginTurn } from "./turnDiff";

/** Max chars of a background agent's finalText to inline in the completion
 *  line. The full text already lives in the agent's own card (AgentMessage.text)
 *  — the stream/toast line is just a "✓ done · here's the gist" pointer, not a
 *  place to dump a multi-paragraph subagent report (that's what made completed
 *  background agents flood the transcript). */
const BG_COMPLETION_PREVIEW_CHARS = 160;

function previewLine(text: string, max = BG_COMPLETION_PREVIEW_CHARS): string {
  // Collapse whitespace/newlines so a long multi-line report doesn't render as
  // a tall block, then clip to one short preview.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Shared text for a background-task completion (video etc.) — used by the
 *  reducer (message stream) and App.tsx (toast) so the two never drift. */
export function bgCompletionText(event: {
  name?: string;
  description: string;
  status: "completed" | "failed" | "cancelled";
  workKind?: "agent" | "shell" | "video" | "cc";
  command?: string;
  finalText?: string;
  error?: string;
  exitCode?: number;
  signal?: string;
}): string {
  const lang = loadUILanguage();
  // For background shells, `description` is English wakeup text meant for the
  // agent ("Background shell exited (exit 0): yt-dlp …"). Don't surface that raw
  // in the toast — use a localized name + the command as the preview instead.
  const isShell = event.workKind === "shell";
  const who = isShell
    ? translate(lang, "misc.bgTask.shellName")
    : (event.name ?? translate(lang, "misc.bgTask.defaultName"));
  const completedPreview = isShell
    ? previewLine(event.command ?? event.description)
    : previewLine(event.finalText ?? event.description);
  const shellExitReason = event.signal
    ? translate(lang, "misc.bgTask.signal", { signal: event.signal })
    : Number.isInteger(event.exitCode) && event.exitCode !== 0
      ? translate(lang, "misc.bgTask.exitCode", { code: event.exitCode! })
      : event.error;
  const failedPreview = isShell
    ? [previewLine(event.command ?? event.description, 100), previewLine(shellExitReason ?? "", 80)]
        .filter(Boolean)
        .join(" · ")
    : previewLine(event.error ?? event.description);
  if (event.status === "completed") {
    return translate(lang, "misc.bgTask.completed", {
      name: who,
      preview: completedPreview,
    });
  }
  if (event.status === "cancelled") {
    return translate(lang, "misc.bgTask.cancelled", {
      name: who,
      preview: failedPreview,
    });
  }
  return translate(
    lang,
    isShell && event.signal ? "misc.bgTask.terminated" : "misc.bgTask.failed",
    {
      name: who,
      preview: failedPreview,
    },
  );
}

export function applyAgentStart(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "agent_start" }>,
  now: MessageClock,
): MessagesReducerState {
  const startedAt = now() ?? 0;
  const newIndex = state.messages.length;
  return {
    ...state,
    activeAgents: {
      ...state.activeAgents,
      [event.agentId]: {
        agentId: event.agentId,
        name: event.name,
        description: event.description,
        startedAt,
      },
    },
    messages: [
      ...state.messages,
      {
        kind: "agent",
        id: event.agentId,
        name: event.name,
        agentType: event.agentType,
        description: event.description,
        done: false,
        startedAt,
        toolCalls: [],
        textBuffer: "",
        toolCount: 0,
      },
    ],
    agentMessageIndex: {
      ...state.agentMessageIndex,
      [event.agentId]: newIndex,
    },
  };
}

export function applyAgentBackgrounded(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "agent_backgrounded" }>,
): MessagesReducerState {
  // The sync agent crossed the auto-background threshold and detached. Mark
  // it `backgrounded` (still running, NOT done) so the card renders
  // "转后台 · 运行中" and turn_complete's done-sweep skips it. No-op if the
  // agent already finished (a racing agent_end won the terminal state).
  const idx = state.agentMessageIndex[event.agentId];
  if (idx === undefined) return state;
  const m = state.messages[idx];
  if (!m || m.kind !== "agent" || m.done) return state;
  const msgs = state.messages.slice();
  msgs[idx] = { ...m, backgrounded: true };
  return { ...state, messages: msgs };
}

export function applyAgentHeartbeat(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "agent_heartbeat" }>,
): MessagesReducerState {
  // B: liveness ping. Stamp lastHeartbeat on every still-running agent the
  // worker reports, so the card can flag "可能失联" when pings stop.
  const ids = new Set(event.agentIds);
  if (ids.size === 0) return state;
  let changed = false;
  const msgs = state.messages.map((m) => {
    if (m.kind === "agent" && !m.done && ids.has(m.id)) {
      changed = true;
      return { ...m, lastHeartbeat: event.ts };
    }
    return m;
  });
  return changed ? { ...state, messages: msgs } : state;
}

export function applyAgentEnd(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "agent_end" }>,
  now: MessageClock,
): MessagesReducerState {
  const endedAt = now() ?? undefined;
  const { [event.agentId]: _omit, ...rest } = state.activeAgents;
  const idx = state.agentMessageIndex[event.agentId];
  const msgs = state.messages.slice();
  if (idx !== undefined) {
    const m = msgs[idx];
    if (m && m.kind === "agent") {
      // Idempotent / first-terminal-state-wins. The engine should now emit
      // exactly one agent_end per agent (the sub-agent wall-clock timeout
      // that raced completion was removed), but stay defensive: if a second
      // agent_end ever arrives for an already-finished agent, do NOT let a
      // later success overwrite an earlier error (a timed-out/failed agent
      // must not flip back to "done" with text). Keep the first terminal
      // result; just refresh activeAgents bookkeeping.
      if (!m.done) {
        const flushed = m.textBuffer.length > 0 ? (m.text ?? "") + m.textBuffer : m.text;
        const toolEndedAt = endedAt ?? m.startedAt;
        msgs[idx] = {
          ...m,
          done: true,
          backgrounded: false, // resolved → clear the "转后台·运行中" flag
          text: event.text ?? flushed,
          textBuffer: "",
          error: event.error,
          endedAt,
          toolCalls: m.toolCalls.map((tool) => sealToolWithoutResult(tool, toolEndedAt)),
        };
      }
    }
  }
  return { ...state, activeAgents: rest, messages: msgs };
}

export function applyBackgroundAgentCompleted(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "background_agent_completed" }>,
  now: MessageClock,
): MessagesReducerState {
  // A backgrounded sub-agent finished. Besides the system "✓ done" line,
  // RESOLVE its card to done — otherwise it stays {backgrounded:true,
  // done:false}, and once heartbeats stop (it's finished) the card wrongly
  // shows "可能失联" (bug: 转后台完成的卡全失联). The success handoff path in
  // core emits this event (not always a UI agent_end), so this is the
  // reliable place to close the card. Carries agentId → locate the card.
  const msgs = state.messages.slice();
  const agentId = (event as { agentId?: string }).agentId;
  let activeAgents = state.activeAgents;
  if (agentId) {
    const { [agentId]: _omit, ...restActiveAgents } = state.activeAgents;
    activeAgents = restActiveAgents;
    const idx = state.agentMessageIndex[agentId];
    if (idx !== undefined) {
      const m = msgs[idx];
      if (m && m.kind === "agent" && !m.done) {
        const isFail = (event as { status?: string }).status === "failed";
        msgs[idx] = {
          ...m,
          done: true,
          backgrounded: false,
          text: (event as { finalText?: string }).finalText ?? m.text,
          error: isFail ? ((event as { error?: string }).error ?? m.error) : m.error,
          endedAt: m.endedAt ?? now(),
        };
      }
    }
  }
  const provenance = sanitizeExternalChangedFilesProvenance(
    event.changedFilesProvenance,
    event.changedFiles ?? [],
  );
  const externalFileChanges =
    event.workKind === "cc" &&
    Array.isArray(event.changedFiles) &&
    event.changedFiles.length > 0 &&
    typeof event.cwd === "string" &&
    event.cwd.length > 0
      ? {
          sourceId: event.agentId,
          cwd: event.cwd,
          files: event.changedFiles,
          ...(provenance ? { provenance } : {}),
          ...(event.originClientMessageId
            ? { originClientMessageId: event.originClientMessageId }
            : {}),
        }
      : undefined;
  if (externalFileChanges) {
    logChangedFiles("renderer.received", {
      sessionId: state.sessionId,
      sourceId: externalFileChanges.sourceId,
      cwd: externalFileChanges.cwd,
      originClientMessageId: externalFileChanges.originClientMessageId,
      size: externalFileChanges.files.length,
      files: externalFileChanges.files,
    });
  }
  const marker: SystemMessage = {
    kind: "system",
    id: freshId("bg-done"),
    text: bgCompletionText(event),
    ...(externalFileChanges ? { externalFileChanges } : {}),
  };
  const attributed = externalFileChanges?.originClientMessageId
    ? attachExternalChangesToOriginTurn(msgs, marker, externalFileChanges.originClientMessageId)
    : { messages: [...msgs, marker] };
  let agentMessageIndex = state.agentMessageIndex;
  if (attributed.insertedAt !== undefined) {
    agentMessageIndex = Object.fromEntries(
      Object.entries(state.agentMessageIndex).map(([id, index]) => [
        id,
        index >= attributed.insertedAt! ? index + 1 : index,
      ]),
    );
  }
  if (attributed.summary) {
    logChangedFiles("renderer.attributed", {
      sessionId: state.sessionId,
      sourceId: externalFileChanges?.sourceId,
      originClientMessageId: externalFileChanges?.originClientMessageId,
      size: attributed.summary.files.length,
      files: attributed.summary.files.map((file) => file.path),
    });
  }
  return {
    ...state,
    activeAgents,
    agentMessageIndex,
    messages: attributed.messages,
  };
}
