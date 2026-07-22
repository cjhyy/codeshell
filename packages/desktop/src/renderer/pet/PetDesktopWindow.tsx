import type { PetDelegationReceiptGroup, PetLongTaskSnapshot } from "../../preload/types";
import type { PetWorkMemorySegment } from "../../preload/pet-api";
import React from "react";
import { Markdown } from "../Markdown";
import { useT } from "../i18n";
import type { Message } from "../types";
import { PetActivityPreview } from "./PetActivityPreview";
import { PetDelegationCard, selectPetChatRows, type PetChatRow } from "./PetChatHost";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";
import { PetWidget } from "./PetWidget";
import { usePetProjectionState } from "./usePetProjectionState";
import { petExternalSessionLocator } from "./petExternalSession";
import {
  PET_WIDGET_RECEIPTS_KEY,
  buildPetWidgetActivity,
  initialPetWidgetReceiptState,
  markPetWidgetCompletionSeen,
  parsePetWidgetReceiptState,
  type PetWidgetActivityItem,
  type PetWidgetReceiptState,
} from "./petWidgetActivity";

type PetMiniPanel = "chat" | "activity" | null;

export interface MiniChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  source?: string;
}

export function selectMiniChatMessages(messages: readonly Message[]): MiniChatMessage[] {
  return selectMiniChatRows(messages).flatMap<MiniChatMessage>((row) =>
    row.role === "user" || row.role === "assistant"
      ? [
          {
            id: row.id,
            role: row.role,
            text: row.text,
            ...(row.source ? { source: row.source } : {}),
          },
        ]
      : [],
  );
}

export function selectMiniChatRows(
  messages: readonly Message[],
  delegationReceipts: readonly PetDelegationReceiptGroup[] = [],
  segments: readonly PetWorkMemorySegment[] = [],
  longTasks: PetLongTaskSnapshot | null = null,
  workReceipts: PetWidgetReceiptState | null = null,
): PetChatRow[] {
  const visibleMessages = messagesAfterSeenCompletion(messages, longTasks, workReceipts);
  const rows = selectPetChatRows(visibleMessages, segments, delegationReceipts);
  let latestBoundary = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role !== "history-boundary" && rows[index]?.role !== "segment-divider") {
      continue;
    }
    latestBoundary = index;
    break;
  }
  return rows
    .slice(latestBoundary + 1)
    .filter((row) => row.role === "user" || row.role === "assistant" || row.role === "delegation");
}

function messagesAfterSeenCompletion(
  messages: readonly Message[],
  longTasks: PetLongTaskSnapshot | null,
  workReceipts: PetWidgetReceiptState | null,
): readonly Message[] {
  if (!longTasks || !workReceipts) return messages;
  const seenKeys = new Set(workReceipts.seenCompletionKeys);
  const seenTaskIds = new Set(
    longTasks.tasks.flatMap((task) => {
      if (task.status !== "completed") return [];
      const completedAt = task.completedAt ?? task.updatedAt;
      const completionKey = `completed-task:${task.id}:${completedAt}`;
      return completedAt <= workReceipts.baselineAt || seenKeys.has(completionKey) ? [task.id] : [];
    }),
  );
  if (seenTaskIds.size === 0) return messages;

  let latestSeenClosure = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.kind !== "user") continue;
    const taskId = /^pet-closure:([^:]+):/u.exec(message.clientMessageId ?? "")?.[1];
    if (taskId && seenTaskIds.has(taskId)) latestSeenClosure = index;
  }
  if (latestSeenClosure < 0) return messages;

  for (let index = latestSeenClosure + 1; index < messages.length; index += 1) {
    if (messages[index]?.kind === "user") return messages.slice(index);
  }
  return [];
}

export function PetMiniMarkdown({ text }: { text: string }) {
  return (
    <div className="[&>div]:!max-w-none [&>div]:!text-xs [&>div]:!leading-5 [&_p]:!my-0.5 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0 [&_pre]:!my-1.5">
      <Markdown text={text} />
    </div>
  );
}

export function PetDesktopWindow() {
  const { t } = useT();
  const api = window.codeshell.pet;
  const {
    petSessionId,
    chatState,
    chatDispatch,
    chatBusy,
    setChatBusy,
    delegationReceipts,
    longTasks,
  } = usePetState();
  const state = usePetProjectionState(api);
  const [workReceipts, setWorkReceipts] = React.useState<PetWidgetReceiptState | null>(() => {
    try {
      return parsePetWidgetReceiptState(localStorage.getItem(PET_WIDGET_RECEIPTS_KEY));
    } catch {
      return null;
    }
  });
  const [panel, setPanel] = React.useState<PetMiniPanel>(null);
  const [activityListExpanded, setActivityListExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [chatError, setChatError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const conversationEndRef = React.useRef<HTMLDivElement>(null);
  const chatRows = React.useMemo(
    () =>
      selectMiniChatRows(
        chatState.messages,
        delegationReceipts,
        state.projection?.workMemorySegments ?? [],
        longTasks,
        workReceipts,
      ),
    [chatState.messages, delegationReceipts, longTasks, state.projection, workReceipts],
  );

  React.useEffect(() => {
    if (!state.projection || workReceipts) return;
    const initial = initialPetWidgetReceiptState(state.projection);
    setWorkReceipts(initial);
    try {
      localStorage.setItem(PET_WIDGET_RECEIPTS_KEY, JSON.stringify(initial));
    } catch {
      // The badge still works for this renderer lifetime when storage is unavailable.
    }
  }, [state.projection, workReceipts]);

  React.useEffect(() => {
    const syncReceipts = (event: StorageEvent): void => {
      if (event.key !== PET_WIDGET_RECEIPTS_KEY) return;
      const next = parsePetWidgetReceiptState(event.newValue);
      if (next) setWorkReceipts(next);
    };
    window.addEventListener("storage", syncReceipts);
    return () => window.removeEventListener("storage", syncReceipts);
  }, []);

  const sendChat = async (): Promise<void> => {
    const message = draft.trim();
    if (!message || chatBusy || !petSessionId) return;
    const clientMessageId = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setDraft("");
    setChatError(null);
    chatDispatch({
      type: "user_message",
      bucket: PET_CHAT_BUCKET,
      text: message,
      clientMessageId,
    });
    setChatBusy(true);
    try {
      const result = await api.dispatch({ type: "chat", message, clientMessageId });
      if (!result.ok) throw new Error(result.message ?? t("pet.chat.failed"));
      if (result.type === "chat" && result.delegationError) {
        throw new Error(result.delegationError);
      }
    } catch (error) {
      setChatError(error instanceof Error ? error.message : t("pet.chat.failed"));
    } finally {
      setChatBusy(false);
    }
  };

  const workActivity = React.useMemo(
    () => buildPetWidgetActivity(state.projection, workReceipts, longTasks),
    [longTasks, state.projection, workReceipts],
  );

  const toggleChatPanel = React.useCallback((): void => {
    setPanel((current) => (current === "chat" ? null : "chat"));
  }, []);

  const toggleActivityPanel = React.useCallback((): void => {
    setActivityListExpanded(false);
    setPanel((current) => (current === "activity" ? null : "activity"));
  }, []);

  const closePanel = React.useCallback((): void => setPanel(null), []);

  React.useEffect(() => {
    void api.setWidgetSurface(panel ? "expanded" : "collapsed");
  }, [api, panel]);

  React.useEffect(() => {
    if (panel === "activity" && workActivity.items.length === 0) setPanel(null);
  }, [panel, workActivity.items.length]);

  React.useEffect(() => {
    if (panel !== "activity") setActivityListExpanded(false);
  }, [panel]);

  React.useEffect(() => {
    if (panel === "chat") inputRef.current?.focus();
  }, [panel]);

  React.useEffect(() => {
    if (panel !== "chat") return;
    conversationEndRef.current?.scrollIntoView({ block: "end" });
  }, [chatBusy, chatRows.length, chatRows.at(-1)?.text, panel]);

  const markCompletionSeen = React.useCallback((item: PetWidgetActivityItem): void => {
    if (item.kind !== "completed") return;
    setWorkReceipts((current) => {
      if (!current) return current;
      const next = markPetWidgetCompletionSeen(current, item.key);
      try {
        localStorage.setItem(PET_WIDGET_RECEIPTS_KEY, JSON.stringify(next));
      } catch {
        // Keep the in-memory receipt even if persistence is unavailable.
      }
      return next;
    });
  }, []);

  const dismissActivity = React.useCallback(
    (item: PetWidgetActivityItem): void => {
      if (item.kind === "completed") {
        markCompletionSeen(item);
        return;
      }
      closePanel();
    },
    [closePanel, markCompletionSeen],
  );

  const openSession = (sessionId: string): void => {
    const projection = state.projection;
    if (!projection) return;
    const activityItem = workActivity.items.find((item) => item.agentSessionId === sessionId);
    if (activityItem) markCompletionSeen(activityItem);
    const external = activityItem ? petExternalSessionLocator(activityItem) : null;
    if (activityItem?.external && !external) return;
    void api.openWidgetOverview({
      agentSessionId: sessionId,
      snapshotVersion: projection.version,
      generation: projection.generation,
      ...(activityItem?.requestId ? { requestId: activityItem.requestId } : {}),
      ...(activityItem?.routeGeneration !== undefined
        ? { routeGeneration: activityItem.routeGeneration }
        : {}),
      ...(external ? { external } : {}),
    });
  };

  const openDelegation = (sessionId: string): void => {
    const projection = state.projection;
    if (!projection) {
      void api.openWidgetOverview();
      return;
    }
    openSession(sessionId);
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent">
      {panel === "chat" && (
        <section
          data-pet-mini-panel="open"
          data-pet-mini-panel-content="chat"
          className="absolute left-1 top-1 flex h-[268px] w-[360px] flex-col overflow-hidden rounded-2xl border border-border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur"
          aria-label={t("pet.widget.miniTitle")}
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <strong className="text-sm">{t("pet.widget.miniTitle")}</strong>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs hover:bg-muted"
                onClick={() => void api.openWidgetOverview()}
              >
                {t("pet.widget.openFull")}
              </button>
              <button
                type="button"
                className="h-6 w-6 rounded-md text-muted-foreground hover:bg-muted"
                onClick={closePanel}
                aria-label={t("pet.widget.collapseChat")}
              >
                ×
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2 text-xs">
            {chatRows.length === 0 && (
              <p className="rounded-lg bg-muted px-2.5 py-2 text-muted-foreground">
                {t("pet.chat.empty")}
              </p>
            )}
            {chatRows.slice(-6).map((row) =>
              row.role === "delegation" && row.delegation ? (
                <PetDelegationCard
                  key={row.id}
                  compact
                  delegation={row.delegation}
                  session={state.projection?.sessions.find(
                    (session) => session.agentSessionId === row.delegation?.sessionId,
                  )}
                  onOpen={() => openDelegation(row.delegation!.sessionId)}
                />
              ) : (
                <div
                  key={row.id}
                  className={
                    row.role === "user"
                      ? "ml-6 rounded-lg bg-primary px-2.5 py-1.5 text-primary-foreground"
                      : "mr-6 rounded-lg bg-muted px-2.5 py-1.5"
                  }
                >
                  {row.source && (
                    <div className="mb-0.5 text-[9px] font-medium opacity-70">{row.source}</div>
                  )}
                  {row.role === "assistant" ? (
                    <PetMiniMarkdown text={row.text} />
                  ) : (
                    <p>{row.text}</p>
                  )}
                </div>
              ),
            )}
            {chatBusy && <p className="text-muted-foreground">{t("pet.widget.replying")}</p>}
            {chatError && <p className="text-status-err">{chatError}</p>}
            <div ref={conversationEndRef} />
          </div>

          <form
            className="flex gap-1.5 border-t border-border p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void sendChat();
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
              placeholder={t("pet.widget.placeholder")}
              disabled={chatBusy || !petSessionId}
            />
            <button
              type="submit"
              className="rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              disabled={!draft.trim() || chatBusy || !petSessionId}
            >
              {t("pet.widget.send")}
            </button>
          </form>
        </section>
      )}

      {panel === "activity" && (
        <section
          data-pet-activity-bubbles="true"
          aria-label={t("pet.widget.activityBubbles")}
          className="absolute bottom-[112px] right-1 flex max-h-[268px] w-[392px] flex-col gap-2 overflow-y-auto px-2 pb-2 pt-2"
        >
          {workActivity.items.length > 1 && !activityListExpanded ? (
            <div
              data-pet-activity-stack="collapsed"
              data-pet-activity-stack-count={workActivity.items.length}
              className="relative px-1 pb-1 pt-4"
            >
              {workActivity.items.length > 2 && (
                <span
                  className="absolute left-7 right-7 top-1 h-20 rounded-[28px] border border-border/25 bg-popover/55 shadow-sm backdrop-blur"
                  aria-hidden="true"
                />
              )}
              <span
                className="absolute left-4 right-4 top-2.5 h-20 rounded-[28px] border border-border/40 bg-popover/75 shadow-sm backdrop-blur"
                aria-hidden="true"
              />
              <div className="relative z-10">
                <PetActivityPreview
                  item={workActivity.items[0]}
                  onOpen={() => setActivityListExpanded(true)}
                  onDismiss={() => dismissActivity(workActivity.items[0])}
                  actionLabel={`${t("pet.widget.expandSessions")}：${workActivity.items.length}`}
                />
                <span
                  className="pointer-events-none absolute -bottom-1 right-5 rounded-full border border-border/50 bg-popover px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground shadow-sm"
                  aria-hidden="true"
                >
                  {workActivity.items.length}
                </span>
              </div>
            </div>
          ) : (
            workActivity.items.map((item) => (
              <PetActivityPreview
                key={item.key}
                item={item}
                onOpen={() => openSession(item.agentSessionId)}
                onDismiss={() => dismissActivity(item)}
              />
            ))
          )}
        </section>
      )}

      <PetWidget
        runningCount={workActivity.runningCount}
        activityCount={workActivity.badgeCount}
        unreadCompletedCount={workActivity.unreadCompletedCount}
        chatExpanded={panel === "chat"}
        activityExpanded={panel === "activity"}
        onToggleChat={toggleChatPanel}
        onToggleActivity={toggleActivityPanel}
        onClose={() => void api.setWidgetVisible(false)}
      />
    </div>
  );
}
