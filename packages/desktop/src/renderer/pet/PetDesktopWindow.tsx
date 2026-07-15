import type { PetPeek, PetProjectionEvent } from "../../preload/types";
import React from "react";
import { useT } from "../i18n";
import type { Message } from "../types";
import {
  IM_GATEWAY_CHANNEL_NAMES,
  imGatewayChannelFromClientMessageId,
} from "../imGatewayChannels";
import { initialPetState, petStateReducer } from "./petStateReducer";
import { visiblePetAssistantText } from "./petChatRouting";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";
import { PetWidget } from "./PetWidget";
import {
  PET_WIDGET_RECEIPTS_KEY,
  buildPetWidgetActivity,
  initialPetWidgetReceiptState,
  markPetWidgetCompletionSeen,
  parsePetWidgetReceiptState,
  type PetWidgetReceiptState,
} from "./petWidgetActivity";

interface MiniNotice {
  title: string;
  detail: string;
  peek?: PetPeek;
}

export interface MiniChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  source?: string;
}

export function selectMiniChatMessages(messages: readonly Message[]): MiniChatMessage[] {
  return messages.flatMap<MiniChatMessage>((message) => {
    if (message.kind === "user" && message.text.trim()) {
      const channel = imGatewayChannelFromClientMessageId(message.clientMessageId);
      return [
        {
          id: message.id,
          role: "user" as const,
          text: message.text.trim(),
          ...(channel ? { source: IM_GATEWAY_CHANNEL_NAMES[channel] } : {}),
        },
      ];
    }
    if (message.kind === "assistant") {
      const text = visiblePetAssistantText(message.text);
      return text ? [{ id: message.id, role: "assistant" as const, text }] : [];
    }
    return [];
  });
}

export function PetDesktopWindow() {
  const { t } = useT();
  const api = window.codeshell.pet;
  const { petSessionId, chatState, chatDispatch, chatBusy, setChatBusy } = usePetState();
  const [state, dispatch] = React.useReducer(petStateReducer, initialPetState);
  const [workReceipts, setWorkReceipts] = React.useState<PetWidgetReceiptState | null>(() => {
    try {
      return parsePetWidgetReceiptState(localStorage.getItem(PET_WIDGET_RECEIPTS_KEY));
    } catch {
      return null;
    }
  });
  const [expanded, setExpanded] = React.useState(false);
  const [notice, setNotice] = React.useState<MiniNotice | null>(null);
  const [draft, setDraft] = React.useState("");
  const [chatError, setChatError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const conversationEndRef = React.useRef<HTMLDivElement>(null);
  const autoExpandedWorkRef = React.useRef(false);
  const messages = React.useMemo(() => selectMiniChatMessages(chatState.messages), [chatState]);

  const showPanel = React.useCallback((): void => {
    setExpanded(true);
    void api.setWidgetExpanded(true);
  }, [api]);

  const hidePanel = React.useCallback((): void => {
    setExpanded(false);
    void api.setWidgetExpanded(false);
  }, [api]);

  React.useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  React.useEffect(() => {
    if (!expanded) return;
    conversationEndRef.current?.scrollIntoView({ block: "end" });
  }, [chatBusy, expanded, messages.length, messages.at(-1)?.text]);

  React.useEffect(() => {
    let active = true;
    let hydrated = false;
    const buffered: PetProjectionEvent[] = [];
    const applyEvent = (event: PetProjectionEvent): void => {
      dispatch({ type: "projection-event", event });
    };
    const unsubscribe = api.onProjectionEvent((event) => {
      if (!active) return;
      if (!hydrated) {
        buffered.push(event);
        return;
      }
      applyEvent(event);
    });
    void api
      .getSnapshot()
      .then((snapshot) => {
        if (!active) return;
        dispatch({ type: "snapshot-received", snapshot });
        hydrated = true;
        for (const event of buffered) applyEvent(event);
      })
      .catch((error) => {
        if (!active) return;
        hydrated = true;
        dispatch({
          type: "snapshot-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
      buffered.length = 0;
      unsubscribe();
    };
  }, [api, t]);

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
    if (!state.needsSnapshot) return;
    let active = true;
    void api
      .getSnapshot()
      .then((snapshot) => {
        if (active) dispatch({ type: "snapshot-received", snapshot });
      })
      .catch((error) => {
        if (!active) return;
        dispatch({
          type: "snapshot-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
    };
  }, [api, state.needsSnapshot]);

  React.useEffect(() => {
    let active = true;
    let hydrated = false;
    const buffered: Array<{ kind: "count"; count: number } | { kind: "peek"; peek: PetPeek }> = [];
    const applyAttention = (
      event: { kind: "count"; count: number } | { kind: "peek"; peek: PetPeek },
    ): void => {
      if (event.kind === "count") return;
      setNotice({ title: event.peek.title, detail: event.peek.detail, peek: event.peek });
      showPanel();
    };
    const unsubscribe = api.onAttentionEvent((event) => {
      if (!active) return;
      const normalized =
        event.kind === "count"
          ? ({ kind: "count", count: event.surfaceablePendingCount } as const)
          : ({ kind: "peek", peek: event.peek } as const);
      if (!hydrated) buffered.push(normalized);
      else applyAttention(normalized);
    });
    void api
      .getAttentionSnapshot()
      .then(() => {
        if (!active) return;
        hydrated = true;
        for (const event of buffered) applyAttention(event);
      })
      .catch(() => {
        if (!active) return;
        hydrated = true;
        for (const event of buffered) applyAttention(event);
      });
    return () => {
      active = false;
      buffered.length = 0;
      unsubscribe();
    };
  }, [api, showPanel]);

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
    } catch (error) {
      setChatError(error instanceof Error ? error.message : t("pet.chat.failed"));
    } finally {
      setChatBusy(false);
    }
  };

  const workActivity = React.useMemo(
    () => buildPetWidgetActivity(state.projection, workReceipts),
    [state.projection, workReceipts],
  );

  React.useEffect(() => {
    if (autoExpandedWorkRef.current || workActivity.items.length === 0) return;
    autoExpandedWorkRef.current = true;
    showPanel();
  }, [showPanel, workActivity.items.length]);

  const noticeSessionId =
    notice?.peek?.action.type === "open_session" ? notice.peek.action.target.agentSessionId : null;
  const noticeAlreadyListed =
    noticeSessionId !== null &&
    workActivity.items.some((item) => item.agentSessionId === noticeSessionId);

  const openWorkItem = (item: (typeof workActivity.items)[number]): void => {
    const projection = state.projection;
    if (!projection) return;
    if (item.kind === "completed") {
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
    }
    void api.openWidgetOverview({
      agentSessionId: item.agentSessionId,
      snapshotVersion: projection.version,
      generation: projection.generation,
      ...(item.requestId ? { requestId: item.requestId } : {}),
      ...(item.routeGeneration !== undefined ? { routeGeneration: item.routeGeneration } : {}),
    });
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent">
      {expanded && (
        <section
          data-pet-mini-panel="open"
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
                onClick={hidePanel}
                aria-label={t("pet.widget.collapse")}
              >
                ×
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2 text-xs">
            <section className="rounded-xl border border-border/70 bg-muted/30 p-1.5">
              <div className="flex items-center justify-between px-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                <span>{t("pet.widget.workTitle")}</span>
                <span className="tabular-nums">{workActivity.badgeCount}</span>
              </div>
              {workActivity.items.length > 0 ? (
                <div className="space-y-0.5">
                  {workActivity.items.slice(0, 4).map((item) => (
                    <button
                      type="button"
                      key={item.key}
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-background"
                      onClick={() => openWorkItem(item)}
                    >
                      <span
                        className={
                          "mt-1.5 h-2 w-2 shrink-0 rounded-full " +
                          (item.kind === "completed"
                            ? "bg-status-ok"
                            : item.kind === "needs-action"
                              ? "bg-status-warn"
                              : "animate-pulse bg-status-running motion-reduce:animate-none")
                        }
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t(`pet.widget.workState.${item.kind}`)}
                          </span>
                        </span>
                        {item.detail && (
                          <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                            {item.detail}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-[11px] text-muted-foreground">
                  {t("pet.widget.workEmpty")}
                </p>
              )}
              {workActivity.items.length > 4 && (
                <button
                  type="button"
                  className="w-full px-2 py-1 text-left text-[11px] text-primary hover:underline"
                  onClick={() => void api.openWidgetOverview()}
                >
                  {t("pet.widget.workMore", { count: workActivity.items.length - 4 })}
                </button>
              )}
            </section>
            {notice && !noticeAlreadyListed && (
              <button
                type="button"
                className="block w-full rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-2 text-left hover:bg-primary/10"
                onClick={() => {
                  if (notice.peek) {
                    void api.markAttentionReceipt(notice.peek.receiptKeys, "seen");
                  }
                  void api.openWidgetOverview(
                    notice.peek?.action.type === "open_session"
                      ? notice.peek.action.target
                      : undefined,
                  );
                }}
              >
                <span className="block font-medium">{notice.title}</span>
                <span className="mt-0.5 block line-clamp-3 text-muted-foreground">
                  {notice.detail}
                </span>
              </button>
            )}
            {messages.slice(-6).map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user"
                    ? "ml-6 rounded-lg bg-primary px-2.5 py-1.5 text-primary-foreground"
                    : "mr-6 rounded-lg bg-muted px-2.5 py-1.5"
                }
              >
                {message.source && (
                  <div className="mb-0.5 text-[9px] font-medium opacity-70">{message.source}</div>
                )}
                <p>{message.text}</p>
              </div>
            ))}
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

      <PetWidget
        runningCount={workActivity.runningCount}
        activityCount={workActivity.badgeCount}
        unreadCompletedCount={workActivity.unreadCompletedCount}
        expanded={expanded}
        onToggle={expanded ? hidePanel : showPanel}
        onClose={() => void api.setWidgetVisible(false)}
      />
    </div>
  );
}
