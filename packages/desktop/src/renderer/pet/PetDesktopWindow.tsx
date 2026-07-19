import type { PetAttentionEvent, PetDelegationReceiptGroup, PetPeek } from "../../preload/types";
import React from "react";
import { useT } from "../i18n";
import type { Message } from "../types";
import { PetDelegationCard, selectPetChatRows, type PetChatRow } from "./PetChatHost";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";
import { PetWidget } from "./PetWidget";
import { SessionStatusSection } from "./SessionStatusSection";
import { bufferPetAttentionEvent } from "./petReliability";
import { selectPetOverview } from "./petSelectors";
import { usePetProjectionState } from "./usePetProjectionState";
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
): PetChatRow[] {
  return selectPetChatRows(messages, [], delegationReceipts).filter(
    (row) => row.role === "user" || row.role === "assistant" || row.role === "delegation",
  );
}

export function PetDesktopWindow() {
  const { t } = useT();
  const api = window.codeshell.pet;
  const { petSessionId, chatState, chatDispatch, chatBusy, setChatBusy, delegationReceipts } =
    usePetState();
  const state = usePetProjectionState(api);
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
  const chatRows = React.useMemo(
    () => selectMiniChatRows(chatState.messages, delegationReceipts),
    [chatState.messages, delegationReceipts],
  );

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
  }, [chatBusy, chatRows.length, chatRows.at(-1)?.text, expanded]);

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
    let active = true;
    let hydrated = false;
    const buffered: PetAttentionEvent[] = [];
    const applyAttention = (event: PetAttentionEvent): void => {
      if (event.kind === "count") return;
      setNotice({ title: event.peek.title, detail: event.peek.detail, peek: event.peek });
      showPanel();
    };
    const unsubscribe = api.onAttentionEvent((event) => {
      if (!active) return;
      if (!hydrated) bufferPetAttentionEvent(buffered, event);
      else applyAttention(event);
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
    () => buildPetWidgetActivity(state.projection, workReceipts),
    [state.projection, workReceipts],
  );
  const globalOverview = React.useMemo(
    () => selectPetOverview(state.projection, state.status),
    [state.projection, state.status],
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
    globalOverview.sessions.some((session) => session.agentSessionId === noticeSessionId);

  const openSession = (sessionId: string): void => {
    const projection = state.projection;
    if (!projection) return;
    const activityItem = workActivity.items.find((item) => item.agentSessionId === sessionId);
    if (activityItem?.kind === "completed") {
      setWorkReceipts((current) => {
        if (!current) return current;
        const next = markPetWidgetCompletionSeen(current, activityItem.key);
        try {
          localStorage.setItem(PET_WIDGET_RECEIPTS_KEY, JSON.stringify(next));
        } catch {
          // Keep the in-memory receipt even if persistence is unavailable.
        }
        return next;
      });
    }
    void api.openWidgetOverview({
      agentSessionId: sessionId,
      snapshotVersion: projection.version,
      generation: projection.generation,
      ...(activityItem?.requestId ? { requestId: activityItem.requestId } : {}),
      ...(activityItem?.routeGeneration !== undefined
        ? { routeGeneration: activityItem.routeGeneration }
        : {}),
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
            <section
              data-pet-global-session-list="true"
              className="rounded-xl border border-border/70 bg-muted/30 p-1.5"
            >
              <div className="flex items-center justify-between px-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                <span>{t("pet.widget.workTitle")}</span>
                <span className="tabular-nums">{globalOverview.sessions.length}</span>
              </div>
              <p className="px-1.5 pb-1 text-[10px] leading-4 text-muted-foreground">
                {t("pet.widget.workScope")}
              </p>
              <SessionStatusSection
                sessions={globalOverview.sessions}
                emptyState={globalOverview.emptyState}
                showHeading={false}
                onOpen={(session) => openSession(session.agentSessionId)}
              />
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
                  <p>{row.text}</p>
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
