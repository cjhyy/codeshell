import React, { useMemo, useState } from "react";
import type { Message } from "./types";
import { ToolCard } from "./tool-cards";
import { AssistantMessageView } from "./messages/AssistantMessageView";
import { ThinkingMessageView } from "./messages/ThinkingMessageView";
import { AgentMessageView } from "./messages/AgentMessageView";
import { TaskListMessageView } from "./messages/TaskListMessageView";
import { ContextBoundaryView } from "./messages/ContextBoundaryView";
import { AskUserMessageView } from "./messages/AskUserMessageView";
import { ToolGroupCard } from "./messages/ToolGroupCard";
import { TurnProcessGroupCard } from "./messages/TurnProcessGroupCard";
import { FilesChangedCard } from "./messages/FilesChangedCard";
import { buildStreamItems } from "./messages/streamGroups";
import { useStickToBottom } from "./chat/stickToBottom";
import { decodeWireForDisplay } from "./chat/attachments";
import { Lightbox } from "./chat/Lightbox";

// Stable fallback so memoized AskUserMessageView siblings don't see a
// fresh onAnswer prop on every render.
const NOOP_ON_ANSWER = (): void => undefined;

interface Props {
  messages: Message[];
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  /**
   * Optional trailing slot rendered after the last message but still
   * inside the scrollable stream. Used by the chat shell to drop a
   * pending ApprovalCard at the end of the transcript so it scrolls
   * with the rest of the conversation (Codex-style inline approvals).
   */
  trailing?: React.ReactNode;
  /**
   * Stable identity of `trailing`. When it changes (e.g. a new
   * approval envelope arrives), the stick-to-bottom hook treats it
   * the same as a new message and scrolls into view.
   */
  trailingKey?: string | null;
  /**
   * Monotonic counter incremented on each turn_complete. Forwarded to
   * ToolCard and ToolGroupCard so they force-collapse on each turn
   * boundary.
   */
  turnEpoch?: number;
  /**
   * True while the engine is actively streaming the most recent turn
   * (= reducer.streamingAssistantId !== null). Drives the level-2
   * "live" header so its elapsed ticker stops when the turn ends.
   */
  liveTurnActive?: boolean;
  /**
   * Working directory of the owning chat. Needed for the
   * FilesChangedCard review / undo actions, which call git with
   * this cwd. Null when the session was created without a repo.
   */
  cwd?: string | null;
}

export function MessageStream({
  messages,
  onAskUserAnswer,
  trailing,
  trailingKey,
  turnEpoch,
  liveTurnActive,
  cwd,
}: Props) {
  const ref = useStickToBottom<HTMLDivElement>(
    `${messages.length}:${trailingKey ?? ""}`,
  );
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(
    null,
  );

  // Two-level fold (see messages/streamGroups.ts):
  //   - level 1: adjacent tool calls → ToolGroup
  //   - level 2: per turn, first-tool..last-tool span → TurnProcessGroup.
  //     The most recent turn is "live" iff the engine is currently
  //     streaming; that's the only one whose header ticker keeps
  //     advancing, and the only one that defaults to open.
  const items = useMemo(
    () => buildStreamItems(messages, { liveTurnActive }),
    [messages, liveTurnActive],
  );

  return (
    <div className="stream" ref={ref}>
      {items.map((m) => {
        if (m.kind === "turn_process_group") {
          return <TurnProcessGroupCard key={m.id} group={m} turnEpoch={turnEpoch} />;
        }
        if (m.kind === "tool_group") {
          return <ToolGroupCard key={m.id} group={m} turnEpoch={turnEpoch} />;
        }
        switch (m.kind) {
          case "tool":
            // Tool cards now display their full args/result body inline
            // when expanded — no separate inspector pane to feed.
            return <ToolCard key={m.id} message={m} turnEpoch={turnEpoch} />;
          case "user": {
            const { text, images } = decodeWireForDisplay(m.text);
            return (
              <div key={m.id} className="msg-row msg-row-user">
                <div className="msg-user-bubble">
                  {text && <div className="msg-user-text">{text}</div>}
                  {images.length > 0 && (
                    <div className="msg-user-images">
                      {images.map((img, i) => (
                        <img
                          key={i}
                          src={img.dataUrl}
                          alt={img.name || "image"}
                          title={img.name || undefined}
                          onClick={() =>
                            setZoomed({
                              src: img.dataUrl,
                              alt: img.name || "image",
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          case "assistant":
            return <AssistantMessageView key={m.id} message={m} />;
          case "thinking":
            return <ThinkingMessageView key={m.id} message={m} />;
          case "agent":
            return <AgentMessageView key={m.id} message={m} />;
          case "task_list":
            // task_list is rendered as a pinned panel above the
            // composer (see ChatView), not inline in the scroll stream
            // — that way the user keeps tasks in view as new messages
            // push old ones up.
            return null;
          case "context_boundary":
            return <ContextBoundaryView key={m.id} message={m} />;
          case "ask_user":
            // ask_user is also pinned above the composer. We still
            // render the resolved (answered) cards inline so the chat
            // history reflects the conversation.
            return m.answer !== undefined ? (
              <AskUserMessageView
                key={m.id}
                message={m}
                onAnswer={onAskUserAnswer ?? NOOP_ON_ANSWER}
              />
            ) : null;
          case "system":
            return (
              <div key={m.id} className="msg-row msg-row-system">
                <div className="msg-system">{m.text}</div>
              </div>
            );
          case "files_changed":
            return <FilesChangedCard key={m.id} message={m} cwd={cwd ?? null} />;
        }
      })}
      {trailing}
      {zoomed && (
        <Lightbox
          src={zoomed.src}
          alt={zoomed.alt}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
}
