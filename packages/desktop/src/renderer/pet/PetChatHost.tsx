import React from "react";
import {
  Archive,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  FolderKanban,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  PetDelegationReceipt,
  PetDelegationReceiptGroup,
  PetOpenSessionRequest,
  PetSessionProjection,
} from "../../preload/types";
import dogIcon from "../assets/codeshell-dog-icon.png";
import type { Message } from "../types";
import { useT } from "../i18n";
import {
  IM_GATEWAY_CHANNEL_NAMES,
  imGatewayChannelFromClientMessageId,
} from "../imGatewayChannels";
import { visiblePetAssistantText } from "./petChatRouting";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";
import { ModelPill, type ModelOption } from "../chat/ModelPill";

export interface PetChatRow {
  id: string;
  role:
    | "user"
    | "assistant"
    | "delegation"
    | "segment-divider"
    | "work-memory"
    | "history-boundary";
  text: string;
  source?: string;
  before?: number;
  after?: number;
  delegation?: PetDelegationReceipt;
}

/**
 * A topic-segment boundary supplied by main: the id of the first chat message
 * of a new segment, plus the optional carryover brief distilled from the
 * closed segment's work memory. A boundary whose message id is absent from the
 * current transcript is silently skipped (no divider, no card).
 *
 * `boundaryBeforeMessageId` is matched against a message's cross-process
 * `clientMessageId` first (the only turn identity main can observe) and falls
 * back to the renderer-local `id`.
 */
export interface PetChatSegmentBoundary {
  boundaryBeforeMessageId: string;
  brief?: string;
}

export function selectPetChatRows(
  messages: readonly Message[],
  segments: readonly PetChatSegmentBoundary[] = [],
  delegationReceipts: readonly PetDelegationReceiptGroup[] = [],
): PetChatRow[] {
  const boundaries = new Map(segments.map((segment) => [segment.boundaryBeforeMessageId, segment]));
  const receiptsByMessageId = new Map(
    delegationReceipts.map((receipt) => [receipt.originClientMessageId, receipt]),
  );
  const emittedReceipts = new Set<string>();
  const rows: PetChatRow[] = [];
  let activeClientMessageId: string | undefined;
  const appendDelegationReceipts = (): void => {
    if (!activeClientMessageId || emittedReceipts.has(activeClientMessageId)) return;
    const receipt = receiptsByMessageId.get(activeClientMessageId);
    if (!receipt) return;
    emittedReceipts.add(activeClientMessageId);
    for (const delegation of receipt.delegations) {
      rows.push({
        id: `delegation:${activeClientMessageId}:${delegation.sessionId}`,
        role: "delegation",
        text: delegation.task,
        delegation,
      });
    }
  };

  for (const message of messages) {
    if (message.kind === "user" && message.text.trim()) {
      activeClientMessageId = message.clientMessageId;
      const channel = imGatewayChannelFromClientMessageId(message.clientMessageId);
      const userRow: PetChatRow = {
        id: message.id,
        role: "user" as const,
        text: message.text.trim(),
        ...(channel ? { source: IM_GATEWAY_CHANNEL_NAMES[channel] } : {}),
      };
      const boundary =
        (message.clientMessageId ? boundaries.get(message.clientMessageId) : undefined) ??
        boundaries.get(message.id);
      if (!boundary) {
        rows.push(userRow);
        continue;
      }
      rows.push({ id: `divider:${message.id}`, role: "segment-divider" as const, text: "" });
      if (boundary.brief) {
        rows.push({
          id: `memory:${message.id}`,
          role: "work-memory" as const,
          text: boundary.brief,
        });
      }
      rows.push(userRow);
      continue;
    }
    if (message.kind === "assistant") {
      const text = visiblePetAssistantText(message.text);
      if (text) rows.push({ id: message.id, role: "assistant" as const, text });
      if (message.done) appendDelegationReceipts();
      continue;
    }
    if (message.kind === "context_boundary") {
      rows.push({
        id: message.id,
        role: "history-boundary" as const,
        text: "",
        before: message.before,
        after: message.after,
      });
    }
  }
  return rows;
}

type PetDelegationDisplayState =
  | "dispatched"
  | "waiting"
  | "queued"
  | "running"
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

const DELEGATION_STATE_TONE: Record<PetDelegationDisplayState, string> = {
  dispatched: "bg-status-info",
  waiting: "bg-status-warn",
  queued: "bg-status-info",
  running: "bg-status-running animate-pulse motion-reduce:animate-none",
  started: "bg-status-ok",
  completed: "bg-status-ok",
  failed: "bg-status-err",
  cancelled: "bg-muted-foreground",
};

export function petDelegationDisplayState(
  session?: PetSessionProjection,
): PetDelegationDisplayState {
  if (!session) return "dispatched";
  if (session.phase === "waiting-decision" || session.pendingDecisionCount > 0) return "waiting";
  if (session.terminal?.status) return session.terminal.status;
  if (session.runState === "queued" || session.runState === "running") return session.runState;
  if (session.runState === "terminal") return "completed";
  if (session.runState === "idle" || session.runState === "dormant") return "started";
  return "dispatched";
}

function workspaceLabel(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/[/\\]+$/u, "");
  return normalized.split(/[/\\]/u).at(-1) || normalized;
}

export function PetDelegationCard({
  delegation,
  session,
  onOpen,
  compact = false,
}: {
  delegation: PetDelegationReceipt;
  session?: PetSessionProjection;
  onOpen?: () => void;
  compact?: boolean;
}) {
  const { t } = useT();
  const state = petDelegationDisplayState(session);
  const workspace = session?.workspaceDisplayName ?? workspaceLabel(delegation.workspacePath);
  return (
    <div className={compact ? "w-full" : "ml-[38px] pr-6"}>
      <button
        type="button"
        data-pet-delegation-card={compact ? "compact" : "true"}
        className={`group/card block w-full border border-primary/25 bg-primary/[0.045] text-left shadow-sm transition hover:border-primary/40 hover:bg-primary/[0.075] hover:shadow-md disabled:cursor-default disabled:opacity-80 ${
          compact ? "rounded-xl p-2.5" : "rounded-2xl p-3"
        }`}
        onClick={onOpen}
        disabled={!onOpen}
        aria-label={t("pet.chat.delegation.openAria", { title: delegation.task })}
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-primary">
          <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t(
              delegation.reusedSession
                ? "pet.chat.delegation.resumed"
                : "pet.chat.delegation.dispatched",
            )}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-background/80 px-2 py-1 text-[10px] font-medium text-muted-foreground">
            <span
              className={`h-1.5 w-1.5 rounded-full ${DELEGATION_STATE_TONE[state]}`}
              aria-hidden="true"
            />
            {t(`pet.chat.delegation.state.${state}`)}
          </span>
        </span>
        <span
          className={`mt-2 block line-clamp-2 font-medium text-foreground ${
            compact ? "text-xs leading-4" : "text-sm leading-5"
          }`}
        >
          {delegation.task}
        </span>
        <span className="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          {workspace && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <FolderKanban size={12} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{workspace}</span>
            </span>
          )}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-primary">
            {t("pet.chat.delegation.open")}
            <ArrowUpRight
              size={12}
              className="transition-transform group-hover/card:-translate-y-0.5 group-hover/card:translate-x-0.5"
              aria-hidden="true"
            />
          </span>
        </span>
      </button>
    </div>
  );
}

function PetChatRowView({
  row,
  session,
  onOpenDelegation,
}: {
  row: PetChatRow;
  session?: PetSessionProjection;
  onOpenDelegation?: () => void;
}) {
  const { t } = useT();
  if (row.role === "history-boundary") return null;
  if (row.role === "delegation" && row.delegation) {
    return (
      <PetDelegationCard delegation={row.delegation} session={session} onOpen={onOpenDelegation} />
    );
  }
  if (row.role === "segment-divider") {
    return (
      <div className="flex items-center gap-3 py-1" aria-hidden="false">
        <span className="h-px flex-1 bg-border/60" />
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("pet.chat.segmentDivider")}
        </span>
        <span className="h-px flex-1 bg-border/60" />
      </div>
    );
  }
  if (row.role === "work-memory") {
    return (
      <Card className="bg-muted/40" role="note" aria-label={t("pet.chat.workMemoryTitle")}>
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles size={12} className="shrink-0 text-primary" aria-hidden="true" />
            {t("pet.chat.workMemoryTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
            {row.text}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (row.role === "user") {
    return (
      <div className="flex justify-end pl-10">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
          {row.source && (
            <div className="mb-1 text-[10px] font-medium text-primary-foreground/70">
              {row.source}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{row.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5 pr-6">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10">
        <img
          src={dogIcon}
          alt=""
          draggable={false}
          className="h-6 w-6 select-none object-contain"
        />
      </span>
      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-border/60 bg-background px-3.5 py-2.5 text-sm leading-6 shadow-sm">
        <div className="whitespace-pre-wrap break-words">{row.text}</div>
      </div>
    </div>
  );
}

function latestHistoryBoundaryIndex(rows: readonly PetChatRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === "history-boundary") return index;
  }
  return -1;
}

export function PetChatHost({
  defaultProjectPath,
  defaultModelKey,
  modelOptions,
  onOpenSession,
}: {
  defaultProjectPath: string | null;
  defaultModelKey: string | null;
  modelOptions: ModelOption[];
  onOpenSession?: (request: PetOpenSessionRequest) => void;
}) {
  const { t } = useT();
  const {
    state,
    dispatch,
    petSessionId,
    chatState,
    chatDispatch,
    chatBusy,
    setChatBusy,
    chatModelKey,
    setChatModelKey,
    delegationReceipts,
  } = usePetState();
  const [error, setError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const effectiveModelKey = chatModelKey ?? defaultModelKey;
  const segments = state.projection?.workMemorySegments;
  const rows = React.useMemo(
    () => selectPetChatRows(chatState.messages, segments, delegationReceipts),
    [chatState.messages, delegationReceipts, segments],
  );
  const latestHistoryBoundary = latestHistoryBoundaryIndex(rows);
  const historyBoundary = latestHistoryBoundary >= 0 ? rows[latestHistoryBoundary] : undefined;
  const historyRows = latestHistoryBoundary > 0 ? rows.slice(0, latestHistoryBoundary) : [];
  const currentRows = latestHistoryBoundary >= 0 ? rows.slice(latestHistoryBoundary + 1) : rows;
  const rowSession = (row: PetChatRow): PetSessionProjection | undefined =>
    row.delegation
      ? state.projection?.sessions.find(
          (session) => session.agentSessionId === row.delegation?.sessionId,
        )
      : undefined;
  const openRowDelegation = (row: PetChatRow): (() => void) | undefined => {
    if (!row.delegation || !state.projection || !onOpenSession) return undefined;
    return () =>
      onOpenSession({
        agentSessionId: row.delegation!.sessionId,
        snapshotVersion: state.projection!.version,
        generation: state.projection!.generation,
      });
  };

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chatBusy, rows.length, rows.at(-1)?.text]);

  const setDraft = (draft: string): void => dispatch({ type: "set-chat-draft", draft });

  const submitToPet = async (): Promise<void> => {
    const message = state.chatDraft.trim();
    if (!message || !petSessionId || chatBusy) return;
    const clientMessageId = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setDraft("");
    setError(null);
    chatDispatch({
      type: "user_message",
      bucket: PET_CHAT_BUCKET,
      text: message,
      clientMessageId,
    });
    setChatBusy(true);
    try {
      const result = await window.codeshell.pet.dispatch({
        type: "chat",
        message,
        clientMessageId,
        ...(effectiveModelKey ? { model: effectiveModelKey } : {}),
        ...(defaultProjectPath ? { preferredProjectPath: defaultProjectPath } : {}),
      });
      if (!result.ok) setError(result.message ?? t("pet.chat.failed"));
      else if (result.type === "chat" && result.delegationError) {
        setError(result.delegationError);
      }
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : t("pet.chat.failed"));
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <section
      className="mimi-surface flex min-h-[520px] w-full flex-col overflow-hidden rounded-3xl @min-[1100px]/pet-page:col-start-1 @min-[1100px]/pet-page:row-start-1 @min-[1100px]/pet-page:min-h-0 @min-[1100px]/pet-page:max-w-[960px] @min-[1100px]/pet-page:justify-self-center"
      aria-label={t("pet.chat.title")}
      data-pet-manager-chat="true"
      data-pet-auto-routing="true"
    >
      <div className="@container/composer-controls flex items-center gap-3 border-b border-border/55 px-5 py-4 @min-[1440px]/pet-page:px-6 @min-[1440px]/pet-page:py-5">
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
          <img
            src={dogIcon}
            alt=""
            draggable={false}
            className="h-9 w-9 select-none object-contain"
          />
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-status-ok"
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{t("pet.chat.managerTitle")}</div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{t("pet.chat.subtitle")}</p>
        </div>
        <ModelPill
          activeKey={effectiveModelKey}
          options={modelOptions}
          onSelect={(option) => setChatModelKey(option.key)}
          disabled={chatBusy || modelOptions.length === 0}
          portal
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/15 px-4 py-5 @min-[1440px]/pet-page:px-5">
        {rows.length === 0 ? (
          <div className="flex h-full min-h-56 items-center justify-center px-5 text-center">
            <div className="max-w-xs">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border border-primary/10 bg-primary/8 shadow-sm">
                <img
                  src={dogIcon}
                  alt=""
                  draggable={false}
                  className="h-14 w-14 select-none object-contain"
                />
              </div>
              <h3 className="text-base font-semibold tracking-tight">{t("pet.chat.emptyTitle")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {petSessionId ? t("pet.chat.empty") : t("pet.chat.loading")}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3.5">
            {historyBoundary && (
              <details
                data-pet-chat-history="compacted"
                className="group/history rounded-2xl border border-border/55 bg-muted/25"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-3 py-2.5 text-xs text-muted-foreground transition hover:bg-muted/45">
                  <Archive size={13} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    {historyBoundary.before && historyBoundary.after
                      ? t("pet.chat.historyCompactedWithTokens", {
                          before: historyBoundary.before,
                          after: historyBoundary.after,
                        })
                      : t("pet.chat.historyCompacted")}
                  </span>
                  {historyRows.length > 0 && (
                    <ChevronDown
                      size={13}
                      className="shrink-0 transition-transform group-open/history:rotate-180"
                      aria-hidden="true"
                    />
                  )}
                </summary>
                {historyRows.length > 0 && (
                  <div className="space-y-3.5 border-t border-border/45 px-3 py-3 opacity-75">
                    {historyRows.map((row) => (
                      <PetChatRowView
                        key={row.id}
                        row={row}
                        session={rowSession(row)}
                        onOpenDelegation={openRowDelegation(row)}
                      />
                    ))}
                  </div>
                )}
              </details>
            )}
            {currentRows.map((row) => (
              <PetChatRowView
                key={row.id}
                row={row}
                session={rowSession(row)}
                onOpenDelegation={openRowDelegation(row)}
              />
            ))}
            {chatBusy && (
              <div className="flex items-start gap-2.5 pr-6">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                  <img
                    src={dogIcon}
                    alt=""
                    draggable={false}
                    className="h-6 w-6 select-none object-contain"
                  />
                </span>
                <div className="rounded-2xl rounded-tl-md border border-border/60 bg-background px-3.5 py-2.5 text-xs text-muted-foreground shadow-sm">
                  {t("pet.chat.organizing")}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {error && (
        <p
          className="mx-4 rounded-xl bg-status-err/10 px-3 py-2 text-xs text-status-err"
          role="status"
        >
          {error}
        </p>
      )}

      <div className="shrink-0 p-4 pt-2 @min-[1440px]/pet-page:p-5 @min-[1440px]/pet-page:pt-3">
        <div className="rounded-2xl border border-input/90 bg-background p-2 shadow-[0_8px_24px_hsl(var(--cs-foreground)/0.06)] transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
          <textarea
            value={state.chatDraft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              void submitToPet();
            }}
            rows={2}
            className="w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/75"
            placeholder={t("pet.chat.placeholder")}
            aria-label={t("pet.chat.placeholder")}
            disabled={!petSessionId || chatBusy}
          />
          <div className="flex items-end justify-between gap-3 px-1 pb-0.5">
            <p className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
              <Sparkles size={11} className="shrink-0 text-primary" aria-hidden="true" />
              <span className="line-clamp-2">{t("pet.chat.autoRoute")}</span>
            </p>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-40"
              disabled={!state.chatDraft.trim() || !petSessionId || chatBusy}
              onClick={() => void submitToPet()}
            >
              <ArrowUp size={13} aria-hidden="true" />
              {t("pet.chat.send")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
