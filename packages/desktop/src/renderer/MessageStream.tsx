import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Message } from "./types";
import { ToolCard } from "./tool-cards";
import { AssistantMessageView } from "./messages/AssistantMessageView";
import { ThinkingMessageView } from "./messages/ThinkingMessageView";
import { AgentMessageView } from "./messages/AgentMessageView";
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
import { foldAgentGroups } from "./messages/agentGroup";
import { AgentGroupCard } from "./messages/AgentGroupCard";
import { useStickToBottom } from "./chat/stickToBottom";
import { buildScrollTrigger } from "./chat/scrollTrigger";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "./ui/icons";
import { decodeWireForDisplay } from "./chat/attachments";
import { extractAnnotations } from "./chat/anchors";
import { AnnotationsBlock } from "./messages/AnnotationsBlock";
import { formatMessageTime } from "./messages/time";
import { Lightbox } from "./chat/Lightbox";
import { timePhase } from "./perf";
import { useT } from "./i18n/I18nProvider";
import type { SummaryForkSessionResult } from "../preload/types";
import {
  buildSelectableContextTurns,
  selectedTurnRange,
  type SelectableContextTurn,
} from "./contextSelection";
import { DriveAgentJobsLoader } from "./tool-cards/DriveAgentJobsContext";

// Stable fallback so memoized AskUserMessageView siblings don't see a
// fresh onAnswer prop on every render.
const NOOP_ON_ANSWER = (): void => undefined;

export interface ContextPackageCreatedOptions {
  /** Re-check immediately before navigating because registration may itself be asynchronous. */
  shouldActivate: () => boolean;
}

export type ContextPackageCreatedHandler = (
  result: SummaryForkSessionResult,
  options?: ContextPackageCreatedOptions,
) => void | Promise<void>;

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
  /** Engine session id — the latest Files-Changed card uses it for turn undo/redo. */
  engineSessionId?: string | null;
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
  /**
   * Monotonic counter bumped by ChatView on each user send. Forces the
   * stream to snap to the bottom + re-arm follow so the user always sees
   * their own message, even if they had scrolled up. Kept separate from
   * the session id so a send never reads as a session switch.
   */
  sendEpoch?: number;
  /** Registers a summary fork as a normal host session after core publishes it. */
  onContextPackageCreated?: ContextPackageCreatedHandler;
}

export function MessageStream({
  messages,
  onAskUserAnswer,
  onExtendGoal,
  trailing,
  trailingKey,
  turnEpoch,
  engineSessionId,
  liveTurnActive,
  cwd,
  sendEpoch,
  onContextPackageCreated,
}: Props) {
  const { t } = useT();
  // The LAST files_changed message = the most recent turn's file edits. Only
  // that card gets interactive undo/redo (snapshots only peel newest-first);
  // older cards are informational. Computed from the raw message list (1:1 with
  // completed turns — the reducer strips prior same-turn cards), not turnEpoch.
  let lastFilesChangedId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "files_changed") {
      lastFilesChangedId = messages[i].id;
      break;
    }
  }
  const { ref, showJump, scrollToBottom } = useStickToBottom<HTMLDivElement>({
    // Trigger encodes message count + trailing key + bucketed streaming tail
    // length, so growth within a single streaming message keeps following.
    trigger: buildScrollTrigger(messages, liveTurnActive, trailingKey),
    // Session switch → snap to bottom instantly (before paint), no scroll flash.
    jumpKey: engineSessionId ?? null,
    // User send → unconditional re-arm + snap (separate dep from session id).
    sendEpoch,
  });
  // Zoom state carries the whole sibling-image group plus the clicked index,
  // so the Lightbox can offer prev/next across the images in one message.
  const [zoomed, setZoomed] = useState<{
    items: { src: string; alt: string; name?: string }[];
    index: number;
  } | null>(null);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selectionTurns, setSelectionTurns] = useState<SelectableContextTurn[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [selectionStatus, setSelectionStatus] = useState<"idle" | "loading" | "packaging">("idle");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionLoadEpochRef = useRef(0);
  const currentSessionIdRef = useRef(engineSessionId);
  currentSessionIdRef.current = engineSessionId;

  useEffect(() => {
    selectionLoadEpochRef.current += 1;
    setSelectionOpen(false);
    setSelectionTurns([]);
    setSelectionAnchor(null);
    setSelectionEnd(null);
    setSelectionStatus("idle");
    setSelectionError(null);
  }, [engineSessionId]);

  const openContextSelection = async () => {
    if (!engineSessionId || liveTurnActive) return;
    const loadEpoch = ++selectionLoadEpochRef.current;
    setSelectionOpen(true);
    setSelectionStatus("loading");
    setSelectionError(null);
    try {
      const raw = await window.codeshell.getSessionRawEvents(engineSessionId);
      if (loadEpoch !== selectionLoadEpochRef.current) return;
      setSelectionTurns(buildSelectableContextTurns(raw, false));
      setSelectionAnchor(null);
      setSelectionEnd(null);
    } catch (error) {
      if (loadEpoch !== selectionLoadEpochRef.current) return;
      setSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (loadEpoch === selectionLoadEpochRef.current) setSelectionStatus("idle");
    }
  };

  const chooseTurn = (index: number) => {
    if (selectionAnchor === null || selectionEnd === null) {
      setSelectionAnchor(index);
      setSelectionEnd(index);
      return;
    }
    const low = Math.min(selectionAnchor, selectionEnd);
    const high = Math.max(selectionAnchor, selectionEnd);
    if (index < low || index > high) {
      setSelectionAnchor(Math.min(low, index));
      setSelectionEnd(Math.max(high, index));
      return;
    }
    if (low === high) {
      setSelectionAnchor(null);
      setSelectionEnd(null);
      return;
    }
    if (index === low) {
      setSelectionAnchor(low + 1);
      setSelectionEnd(high);
      return;
    }
    if (index === high) {
      setSelectionAnchor(low);
      setSelectionEnd(high - 1);
      return;
    }
    // A closed context package cannot contain a hole. Clicking a selected
    // middle row starts a new one-row selection, matching message-forwarding
    // UIs without silently forwarding rows the user just deselected.
    setSelectionAnchor(index);
    setSelectionEnd(index);
  };

  const createContextPackage = async () => {
    if (!engineSessionId || selectionAnchor === null || selectionEnd === null) return;
    const operationEpoch = selectionLoadEpochRef.current;
    const sourceSessionId = engineSessionId;
    const operationIsCurrent = () =>
      operationEpoch === selectionLoadEpochRef.current &&
      sourceSessionId === currentSessionIdRef.current;
    setSelectionStatus("packaging");
    setSelectionError(null);
    try {
      const from = Math.min(selectionAnchor, selectionEnd);
      const to = Math.max(selectionAnchor, selectionEnd);
      const range = selectedTurnRange(selectionTurns, from, to);
      const result = await window.codeshell.forkSession({
        sourceSessionId,
        mode: "summary",
        ...range,
      });
      if (result.mode !== "summary") throw new Error("Unexpected full-fork response");
      const selectedTitle = selectionTurns[from]?.preview.trim();
      await onContextPackageCreated?.(
        selectedTitle && !result.titleSuggestion
          ? { ...result, titleSuggestion: selectedTitle.slice(0, 60) }
          : result,
        { shouldActivate: operationIsCurrent },
      );
      if (!operationIsCurrent()) return;
      setSelectionOpen(false);
    } catch (error) {
      if (!operationIsCurrent()) return;
      setSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (operationIsCurrent()) setSelectionStatus("idle");
    }
  };

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
          // Post-pass: collapse runs of ≥2 sibling sub-agents into a summary
          // card. Runs after reconcile so it reads the latest AgentMessage
          // refs and a live agent's rollup stats stay fresh each rebuild.
          return foldAgentGroups(reconciled);
        },
        () => ({ msgs: messages.length }),
      ),
    [messages, liveTurnActive],
  );

  return (
    <DriveAgentJobsLoader sessionId={engineSessionId} messages={messages}>
      <div className="relative min-w-0 max-w-full flex-1 overflow-hidden">
        {engineSessionId && onContextPackageCreated && !liveTurnActive && !selectionOpen && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute right-4 top-2 z-20"
            onClick={() => void openContextSelection()}
          >
            {t("chat.contextPackage.select")}
          </Button>
        )}
        {selectionOpen && (
          <div className="absolute inset-x-4 top-2 z-30 max-h-[70%] overflow-auto rounded-lg border border-border bg-background p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{t("chat.contextPackage.title")}</div>
                <div className="text-xs text-muted-foreground">{t("chat.contextPackage.hint")}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectionOpen(false)}
              >
                {t("chat.contextPackage.cancel")}
              </Button>
            </div>
            {selectionStatus === "loading" ? (
              <div className="py-3 text-sm text-muted-foreground">
                {t("chat.contextPackage.loading")}
              </div>
            ) : selectionTurns.length === 0 ? (
              <div className="py-3 text-sm text-muted-foreground">
                {t("chat.contextPackage.empty")}
              </div>
            ) : (
              <div className="space-y-1">
                {selectionTurns.map((turn, index) => {
                  const low = Math.min(selectionAnchor ?? -1, selectionEnd ?? -1);
                  const high = Math.max(selectionAnchor ?? -1, selectionEnd ?? -1);
                  const selected = selectionAnchor !== null && index >= low && index <= high;
                  return (
                    <button
                      type="button"
                      key={`${turn.fromEventId}:${turn.toEventId}`}
                      className={
                        "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm " +
                        (selected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-muted/50")
                      }
                      aria-pressed={selected}
                      onClick={() => chooseTurn(index)}
                    >
                      <span
                        className={
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border " +
                          (selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/50")
                        }
                        aria-hidden="true"
                      >
                        {selected && <Check size={12} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="mr-2 text-xs text-muted-foreground">
                          #{turn.turnNumber + 1}
                        </span>
                        <span className="break-words">{turn.preview}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {selectionError && (
              <div className="mt-2 text-sm text-status-err">
                {t("chat.contextPackage.failed", { error: selectionError })}
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={
                  selectionAnchor === null || selectionEnd === null || selectionStatus !== "idle"
                }
                onClick={() => void createContextPackage()}
              >
                {selectionStatus === "packaging"
                  ? t("chat.contextPackage.packaging")
                  : t("chat.contextPackage.create")}
              </Button>
            </div>
          </div>
        )}
        <div className="h-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto" ref={ref}>
          <div className="min-w-0 max-w-full">
            {items.map((m) => {
              if (m.kind === "turn_process_group") {
                return (
                  <TurnProcessGroupCard key={m.id} group={m} turnEpoch={turnEpoch} cwd={cwd} />
                );
              }
              if (m.kind === "tool_group") {
                return <ToolGroupCard key={m.id} group={m} turnEpoch={turnEpoch} cwd={cwd} />;
              }
              if (m.kind === "agent_group") {
                return <AgentGroupCard key={m.id} group={m} />;
              }
              switch (m.kind) {
                case "tool":
                  // Tool cards now display their full args/result body inline
                  // when expanded — no separate inspector pane to feed.
                  return <ToolCard key={m.id} message={m} turnEpoch={turnEpoch} cwd={cwd} />;
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
                    <div
                      key={m.id}
                      className="group flex min-w-0 max-w-full flex-col items-end px-4 py-1.5"
                    >
                      {m.isGoal && (
                        // Persistent-goal marker (CC /goal). This send set/advanced a goal.
                        <span className="mb-0.5 flex items-center gap-1 px-1 text-[11px] font-medium text-status-running">
                          ◎ {t("msg.user.goal")}
                        </span>
                      )}
                      <div
                        className={
                          "min-w-0 max-w-[80%] rounded-xl border px-3 py-2 text-sm " +
                          (m.isGoal
                            ? "border-status-running/50 bg-status-running/10"
                            : "border-border bg-muted/40")
                        }
                      >
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
                  return (
                    <FilesChangedCard
                      key={m.id}
                      message={m}
                      cwd={cwd ?? null}
                      sessionId={engineSessionId ?? null}
                      isLatest={m.id === lastFilesChangedId}
                    />
                  );
                case "turn_end":
                  return <TurnEndMessageView key={m.id} message={m} />;
              }
            })}
            {liveTurnActive && <LiveActivityLine messages={messages} running={liveTurnActive} />}
            {trailing}
          </div>
        </div>
        {showJump && (
          <Button
            type="button"
            variant="solid"
            size="icon"
            onClick={scrollToBottom}
            aria-label={t("chat.stream.jumpToBottomAria")}
            title={t("chat.stream.jumpToBottomTitle")}
            className="absolute bottom-4 right-4 h-9 w-9 rounded-full shadow-md"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        )}
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
    </DriveAgentJobsLoader>
  );
}
