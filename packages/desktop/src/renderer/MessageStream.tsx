import React, { useMemo, useRef, useState } from "react";
import type { Message } from "./types";
import { ToolCard } from "./tool-cards";
import { AssistantMessageView } from "./messages/AssistantMessageView";
import { ThinkingMessageView } from "./messages/ThinkingMessageView";
import { AgentMessageView } from "./messages/AgentMessageView";
import { TaskListMessageView } from "./messages/TaskListMessageView";
import { ContextBoundaryView } from "./messages/ContextBoundaryView";
import { GoalProgressView } from "./messages/GoalProgressView";
import { TurnEndMessageView } from "./messages/TurnEndMessageView";
import { AskUserMessageView } from "./messages/AskUserMessageView";
import { ToolGroupCard } from "./messages/ToolGroupCard";
import { CollapsibleContent } from "./messages/CollapsibleContent";
import { TurnProcessGroupCard } from "./messages/TurnProcessGroupCard";
import { FilesChangedCard } from "./messages/FilesChangedCard";
import { LiveActivityLine } from "./messages/LiveActivityLine";
import { buildStreamItems, reconcileStreamItems, type StreamItem } from "./messages/streamGroups";
import { useStickToBottom } from "./chat/stickToBottom";
import { decodeWireForDisplay } from "./chat/attachments";
import { extractAnnotations } from "./chat/anchors";
import { AnnotationsBlock } from "./messages/AnnotationsBlock";
import { formatMessageTime } from "./messages/time";
import { Lightbox } from "./chat/Lightbox";
import { timePhase } from "./perf";

// Stable fallback so memoized AskUserMessageView siblings don't see a
// fresh onAnswer prop on every render.
const NOOP_ON_ANSWER = (): void => undefined;

interface Props {
  messages: Message[];
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  /** Extend the running goal (TODO 3.1). opts target the nearest ceiling. */
  onExtendGoal?: (opts: {
    addTurns?: number;
    addStopBlocks?: number;
    addTokenBudget?: number;
    addTimeBudgetMs?: number;
  }) => void;
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
  onExtendGoal,
  trailing,
  trailingKey,
  turnEpoch,
  liveTurnActive,
  cwd,
}: Props) {
  const ref = useStickToBottom<HTMLDivElement>(
    `${messages.length}:${trailingKey ?? ""}`,
  );
  // Zoom state carries the whole sibling-image group plus the clicked index,
  // so the Lightbox can offer prev/next across the images in one message.
  const [zoomed, setZoomed] = useState<
    { items: { src: string; alt: string; name?: string }[]; index: number } | null
  >(null);

  // Two-level fold (see messages/streamGroups.ts):
  //   - level 1: adjacent tool calls → ToolGroup
  //   - level 2: per turn, first-tool..last-tool span → TurnProcessGroup.
  //     The most recent turn is "live" iff the engine is currently
  //     streaming; that's the only one whose header ticker keeps
  //     advancing, and the only one that defaults to open.
  // Build the folded list, then reconcile group objects against the previous
  // render so unchanged ToolGroup/TurnProcessGroup wrappers keep a stable
  // reference — that's what lets their React.memo actually skip work on the
  // 50ms stream batches. prevItemsRef survives renders; the useMemo only
  // recomputes when messages/liveTurnActive change.
  const prevItemsRef = useRef<StreamItem[]>([]);
  const items = useMemo(
    () =>
      timePhase(
        "stream.build",
        () => {
          const built = buildStreamItems(messages, { liveTurnActive });
          const reconciled = reconcileStreamItems(prevItemsRef.current, built);
          prevItemsRef.current = reconciled;
          return reconciled;
        },
        () => ({ msgs: messages.length }),
      ),
    [messages, liveTurnActive],
  );

  return (
    <div className="flex-1 overflow-y-auto" ref={ref}>
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
            // decodeWireForDisplay drops images with an empty data URL (dead
            // ephemeral screenshots), so a turn that was only such an image
            // decodes to empty text + no images.
            const decoded = decodeWireForDisplay(m.text);
            const images = decoded.images;
            // Pull the pinned-comment block (diff/browser/file anchors) out of
            // the prose so it renders as a styled card, not raw XML.
            const { block: annotations, text } = extractAnnotations(decoded.text);
            const askedAt = formatMessageTime(m.createdAt);
            // Nothing to show (no prose, no annotations, all images were dead) →
            // render no bubble rather than an empty selectable box.
            if (!text && !annotations && images.length === 0) return null;
            return (
              <div key={m.id} className="group flex flex-col items-end px-4 py-1.5">
                <div className="min-w-0 max-w-[80%] rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">
                  {annotations && <AnnotationsBlock block={annotations} />}
                  {text && (
                    <CollapsibleContent>
                      <div className="whitespace-pre-wrap break-words">{text}</div>
                    </CollapsibleContent>
                  )}
                  {images.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2 [&>img]:h-20 [&>img]:rounded-md [&>img]:object-cover [&>img]:cursor-pointer">
                      {images.map((img, i) => (
                        <img
                          key={i}
                          src={img.dataUrl}
                          alt={img.name || "image"}
                          title={img.name || undefined}
                          onClick={() =>
                            setZoomed({
                              items: images.map((g) => ({
                                src: g.dataUrl,
                                alt: g.name || "image",
                                name: g.name || undefined,
                              })),
                              index: i,
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
                {askedAt && (
                  <span className="mt-0.5 px-1 text-[11px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    {askedAt}
                  </span>
                )}
              </div>
            );
          }
          case "assistant":
            return <AssistantMessageView key={m.id} message={m} cwd={cwd ?? null} />;
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
          case "goal_progress":
            return <GoalProgressView key={m.id} message={m} onExtend={onExtendGoal} />;
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
            // Empty system text = a blank centered block; skip it.
            if (m.text.trim() === "") return null;
            return (
              <div key={m.id} className="px-4 py-1 text-center text-xs text-muted-foreground">
                {m.text}
              </div>
            );
          case "files_changed":
            return <FilesChangedCard key={m.id} message={m} cwd={cwd ?? null} />;
          case "turn_end":
            return <TurnEndMessageView key={m.id} message={m} />;
        }
      })}
      {liveTurnActive && <LiveActivityLine messages={messages} running={liveTurnActive} />}
      {trailing}
      {zoomed && (
        <Lightbox
          items={zoomed.items}
          index={zoomed.index}
          src={zoomed.items[zoomed.index]?.src ?? ""}
          alt={zoomed.items[zoomed.index]?.alt ?? "image"}
          name={zoomed.items[zoomed.index]?.name}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
}
