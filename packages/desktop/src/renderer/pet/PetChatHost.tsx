import React from "react";
import {
  Archive,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  FileText,
  FolderKanban,
  ImageIcon,
  LoaderCircle,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  PetDelegationReceipt,
  PetDelegationReceiptGroup,
  PetOpenSessionRequest,
  PetSessionProjection,
} from "../../preload/types";
import { usePetSprite } from "../petSprite";
import { Markdown } from "../Markdown";
import type { Message } from "../types";
import { useT } from "../i18n";
import {
  IM_GATEWAY_CHANNEL_NAMES,
  imGatewayChannelFromClientMessageId,
} from "../imGatewayChannels";
import { visiblePetAssistantText } from "./petChatRouting";
import { parsePetHostActionReplacementDisplay } from "../../shared/pet-host-action-receipt";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";
import { ModelPill, type ModelOption } from "../chat/ModelPill";
import { Lightbox } from "../chat/Lightbox";
import { CODESHELL_PATH_DND_MIME } from "../chat/attachments";
import {
  buildMessageWithLocalFilePaths,
  localFileBasename,
  MAX_LOCAL_FILE_PATHS,
  normalizeLocalFilePaths,
  pathForRendererFile,
} from "../chat/localFilePaths";
import { describePetChatActivity } from "./petChatActivity";

export const MAX_PET_PATH_ATTACHMENTS = MAX_LOCAL_FILE_PATHS;

/**
 * Mimi never reads dropped files herself. Keep only explicit absolute paths so
 * she can hand them unchanged to a Work Session that owns file inspection.
 */
export function normalizePetPathAttachments(paths: readonly string[]): string[] {
  return normalizeLocalFilePaths(paths);
}

export function buildPetMessageWithPathAttachments(
  message: string,
  paths: readonly string[],
  label: string,
): string {
  return buildMessageWithLocalFilePaths(message, paths, label);
}

function petPathBasename(path: string): string {
  return localFileBasename(path);
}

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
  deliveryLabel?: string;
  images?: PetChatImage[];
}

export interface PetChatImage {
  path: string;
  name: string;
  mime?: string;
  cwd: string | null;
  sessionId?: string;
}

const ATTACHED_FILE_BLOCK = /<attached-file\b[^>]*>[\s\S]*?<\/attached-file>/giu;

function isAbsoluteLocalPath(path: string): boolean {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(path);
}

function attachmentPathContext(path: string): { cwd: string | null; sessionId?: string } {
  const match = /^(.*)[\\/]\.code-shell[\\/]attachments[\\/]([^\\/]+)[\\/]/u.exec(path);
  if (!match) return { cwd: null };
  return {
    cwd: match[1] || (path.startsWith("/") ? "/" : null),
    ...(match[2] ? { sessionId: match[2] } : {}),
  };
}

function attachmentBasename(path: string): string {
  return path.split(/[\\/]/u).at(-1) || path;
}

function attachmentMetadataValue(block: string, field: string): string | undefined {
  const match = new RegExp(`^${field}:\\s*([^\\r\\n]+)$`, "imu").exec(block);
  return match?.[1]?.trim();
}

function imageFromTranscriptAttachmentBlock(block: string): PetChatImage | null {
  const path = attachmentMetadataValue(block, "absolutePath");
  const mime = attachmentMetadataValue(block, "mime");
  if (!path || !isAbsoluteLocalPath(path) || !mime?.toLowerCase().startsWith("image/")) {
    return null;
  }
  const context = attachmentPathContext(path);
  return {
    path,
    name: attachmentMetadataValue(block, "originalName") ?? attachmentBasename(path),
    mime,
    cwd: context.cwd,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  };
}

/**
 * Build the visible user bubble from both live structured attachments and the
 * durable `<attached-file>` metadata persisted in older/current transcripts.
 * Image metadata is hidden from the bubble once it becomes a thumbnail.
 */
export function parsePetUserContent(message: Extract<Message, { kind: "user" }>): {
  text: string;
  images: PetChatImage[];
} {
  const images: PetChatImage[] = [];
  const seen = new Set<string>();
  const addImage = (image: PetChatImage): void => {
    if (seen.has(image.path)) return;
    seen.add(image.path);
    images.push(image);
  };

  for (const attachment of message.attachments ?? []) {
    if (attachment.kind !== "image" || !isAbsoluteLocalPath(attachment.absPath)) continue;
    const context = attachmentPathContext(attachment.absPath);
    addImage({
      path: attachment.absPath,
      name: attachment.originalName ?? attachmentBasename(attachment.absPath),
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      cwd: context.cwd,
      sessionId: attachment.sessionId || context.sessionId,
    });
  }

  const text = message.text
    .replace(ATTACHED_FILE_BLOCK, (block) => {
      const image = imageFromTranscriptAttachmentBlock(block);
      if (!image) return block;
      addImage(image);
      return "";
    })
    .replace(/\n[\t ]*\n(?:[\t ]*\n)+/gu, "\n\n")
    .trim();
  return { text, images };
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

export interface PetHostActionReceiptRow {
  clientMessageId: string;
  message: string;
  createdAt: number;
  replaceAssistant?: boolean;
  deliveryChannel?: string;
}

const PET_AUTHORITATIVE_REPLY_TOOLS = new Set(["DelegateWork", "GatewayReply", "SendMessage"]);

export function selectPetChatRows(
  messages: readonly Message[],
  segments: readonly PetChatSegmentBoundary[] = [],
  delegationReceipts: readonly PetDelegationReceiptGroup[] = [],
  hostActionReceipts: readonly PetHostActionReceiptRow[] = [],
): PetChatRow[] {
  const boundaries = new Map(segments.map((segment) => [segment.boundaryBeforeMessageId, segment]));
  const receiptsByMessageId = new Map(
    delegationReceipts.map((receipt) => [receipt.originClientMessageId, receipt]),
  );
  const hostReceiptsByMessageId = new Map<string, PetHostActionReceiptRow>();
  const persistedReplacementMessageIds = new Set<string>();
  let persistedTurnClientMessageId: string | undefined;
  for (const message of messages) {
    if (message.kind === "user") {
      persistedTurnClientMessageId = message.clientMessageId;
      continue;
    }
    if (message.kind !== "assistant" || !persistedTurnClientMessageId) continue;
    const parsed = parsePetHostActionReplacementDisplay(message.text);
    if (!parsed.replacesAssistant || !parsed.text.trim()) continue;
    persistedReplacementMessageIds.add(message.id);
    const sourceClientMessageId = parsed.sourceClientMessageId ?? persistedTurnClientMessageId;
    hostReceiptsByMessageId.set(sourceClientMessageId, {
      clientMessageId: sourceClientMessageId,
      message: parsed.text,
      createdAt: message.createdAt ?? 0,
      replaceAssistant: true,
      ...(parsed.deliveryChannel ? { deliveryChannel: parsed.deliveryChannel } : {}),
    });
  }
  for (const receipt of hostActionReceipts) {
    hostReceiptsByMessageId.set(receipt.clientMessageId, receipt);
  }
  const emittedDelegationReceipts = new Set<string>();
  const emittedHostReceipts = new Set<string>();
  const turnsWithSuppressedAssistant = new Set<string>();
  const rows: PetChatRow[] = [];
  let activeClientMessageId: string | undefined;
  let activeTurnRowStart = 0;
  let activeTurnAwaitsAuthoritativeReply = false;
  const turnRowStarts = new Map<string, number>();
  const appendDelegationReceipts = (): void => {
    if (!activeClientMessageId || emittedDelegationReceipts.has(activeClientMessageId)) return;
    const delegationReceipt = receiptsByMessageId.get(activeClientMessageId);
    if (!delegationReceipt) return;
    emittedDelegationReceipts.add(activeClientMessageId);
    for (const delegation of delegationReceipt.delegations) {
      rows.push({
        id: `delegation:${activeClientMessageId}:${delegation.sessionId}`,
        role: "delegation",
        text: delegation.task,
        delegation,
      });
    }
  };
  const appendHostReceipt = (clientMessageId = activeClientMessageId): void => {
    if (!clientMessageId || emittedHostReceipts.has(clientMessageId)) return;
    const hostReceipt = hostReceiptsByMessageId.get(clientMessageId);
    if (!hostReceipt?.message.trim()) return;
    emittedHostReceipts.add(clientMessageId);
    const turnStart = turnRowStarts.get(clientMessageId) ?? activeTurnRowStart;
    let turnEnd = rows.length;
    for (let index = turnStart + 1; index < rows.length; index += 1) {
      if (rows[index]?.role !== "user") continue;
      turnEnd = index;
      break;
    }
    if (hostReceipt.replaceAssistant && !turnsWithSuppressedAssistant.has(clientMessageId)) {
      for (let index = turnEnd - 1; index >= turnStart; index -= 1) {
        if (rows[index]?.role !== "assistant") continue;
        rows.splice(index, 1);
        turnEnd -= 1;
        break;
      }
    }
    if (hostReceipt?.message.trim()) {
      const deliveryChannel =
        hostReceipt.deliveryChannel ?? imGatewayChannelFromClientMessageId(clientMessageId);
      const deliveryLabel =
        deliveryChannel && deliveryChannel in IM_GATEWAY_CHANNEL_NAMES
          ? IM_GATEWAY_CHANNEL_NAMES[deliveryChannel as keyof typeof IM_GATEWAY_CHANNEL_NAMES]
          : undefined;
      rows.splice(turnEnd, 0, {
        id: `host-action:${clientMessageId}:${hostReceipt.createdAt}`,
        role: "assistant",
        text: hostReceipt.message.trim(),
        ...(deliveryLabel ? { deliveryLabel } : {}),
      });
    }
  };

  for (const message of messages) {
    if (message.kind === "user") {
      const content = parsePetUserContent(message);
      if (!content.text && content.images.length === 0) continue;
      appendHostReceipt();
      activeClientMessageId = message.clientMessageId;
      activeTurnRowStart = rows.length;
      activeTurnAwaitsAuthoritativeReply = false;
      if (activeClientMessageId) turnRowStarts.set(activeClientMessageId, activeTurnRowStart);
      const channel = imGatewayChannelFromClientMessageId(message.clientMessageId);
      const userRow: PetChatRow = {
        id: message.id,
        role: "user" as const,
        text: content.text,
        ...(content.images.length > 0 ? { images: content.images } : {}),
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
    if (
      message.kind === "tool" &&
      message.status === "succeeded" &&
      PET_AUTHORITATIVE_REPLY_TOOLS.has(message.toolName)
    ) {
      activeTurnAwaitsAuthoritativeReply = true;
      continue;
    }
    if (message.kind === "assistant") {
      if (persistedReplacementMessageIds.has(message.id)) {
        const replacement = parsePetHostActionReplacementDisplay(message.text);
        const sourceClientMessageId = replacement.sourceClientMessageId ?? activeClientMessageId;
        appendHostReceipt(sourceClientMessageId);
        continue;
      }
      const text = visiblePetAssistantText(message.text);
      // DelegateWork/GatewayReply/SendMessage complete at a trusted host boundary
      // after the model turn. Suppress the model's post-tool acknowledgement so
      // stale claims such as "sent" or "no active task" never flash before the
      // authoritative receipt arrives. Pre-tool reasoning remains visible.
      if (text && !activeTurnAwaitsAuthoritativeReply) {
        rows.push({ id: message.id, role: "assistant" as const, text });
      } else if (text && activeClientMessageId) {
        turnsWithSuppressedAssistant.add(activeClientMessageId);
      }
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
  appendHostReceipt();
  return rows;
}

function PetChatImagePreview({ image }: { image: PetChatImage }) {
  const [src, setSrc] = React.useState<string | null>(null);
  const [zoomed, setZoomed] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setSrc(null);
    if (!image.cwd)
      return () => {
        active = false;
      };
    void window.codeshell
      .readImageDataUrl(image.path, {
        cwd: image.cwd,
        ...(image.sessionId ? { sessionId: image.sessionId } : {}),
      })
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      });
    return () => {
      active = false;
    };
  }, [image.cwd, image.path, image.sessionId]);

  if (!src) {
    return (
      <div
        className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-primary-foreground/20 bg-black/10 px-3 py-4 text-xs text-primary-foreground/75"
        title={image.path}
      >
        <ImageIcon size={16} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{image.name}</span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="block w-full overflow-hidden rounded-xl border border-primary-foreground/20 bg-black/10 transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/70"
        onClick={() => setZoomed(true)}
        aria-label={image.name}
        title={image.name}
      >
        <img
          src={src}
          alt={image.name}
          draggable={false}
          className="max-h-72 w-full object-contain"
        />
      </button>
      {zoomed && (
        <Lightbox
          src={src}
          alt={image.name}
          path={image.path}
          cwd={image.cwd}
          name={image.name}
          onClose={() => setZoomed(false)}
        />
      )}
    </>
  );
}

function PetChatImageGrid({ images }: { images: readonly PetChatImage[] }) {
  return (
    <div
      className={`grid gap-2 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
      data-pet-chat-images="true"
    >
      {images.map((image) => (
        <PetChatImagePreview key={image.path} image={image} />
      ))}
    </div>
  );
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
  dispatched: "bg-status-running",
  waiting: "bg-status-warn",
  queued: "bg-status-running",
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

export function PetChatMarkdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? "min-w-0 max-w-full break-words [&>div]:!max-w-none [&>div]:!text-xs [&>div]:!leading-5 [&>div]:!text-muted-foreground [&_p]:!my-1 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0"
          : "min-w-0 max-w-full break-words [&>div]:!max-w-none [&>div]:!text-sm [&>div]:!leading-6 [&_p]:!my-1 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0"
      }
    >
      <Markdown text={text} />
    </div>
  );
}

export function PetDeliveryStatusTip({ label }: { label: string }) {
  const { t } = useT();
  return (
    <div
      className="mt-2 flex items-center gap-1.5 border-t border-border/50 pt-2 text-[11px] font-medium leading-4 text-status-ok"
      role="status"
    >
      <CheckCircle2 size={12} className="shrink-0" aria-hidden="true" />
      <span>{t("pet.chat.deliverySent", { channel: label })}</span>
    </div>
  );
}

function PetChatRowView({
  row,
  session,
  onOpenDelegation,
  dogIcon,
}: {
  row: PetChatRow;
  session?: PetSessionProjection;
  onOpenDelegation?: () => void;
  /** Passed from the parent so a long message list doesn't open one theme
   * subscription per row (usePetSprite subscribes to 3 events each call). */
  dogIcon: string;
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
          <PetChatMarkdown text={row.text} compact />
        </CardContent>
      </Card>
    );
  }
  if (row.role === "user") {
    return (
      <div className="flex justify-end pl-10">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
          {row.source && (
            <div className="mb-1.5 text-[10px] font-medium text-primary-foreground/70">
              {row.source}
            </div>
          )}
          {row.images && row.images.length > 0 && <PetChatImageGrid images={row.images} />}
          {row.text && (
            <div className={`whitespace-pre-wrap break-words ${row.images?.length ? "mt-2" : ""}`}>
              {row.text}
            </div>
          )}
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
        <PetChatMarkdown text={row.text} />
        {row.deliveryLabel && <PetDeliveryStatusTip label={row.deliveryLabel} />}
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
  onOpenSettings,
}: {
  defaultProjectPath: string | null;
  defaultModelKey: string | null;
  modelOptions: ModelOption[];
  onOpenSession?: (request: PetOpenSessionRequest) => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useT();
  const dogIcon = usePetSprite();
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
    hostActionReceipts,
    chatHistoryLoadedBytes,
    chatHistoryHasMore,
    chatHistoryLoading,
    loadOlderChatHistory,
  } = usePetState();
  const [error, setError] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [pathAttachments, setPathAttachments] = React.useState<string[]>([]);
  const endRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const historyRequestPendingRef = React.useRef(false);
  const pendingHistoryAnchorRef = React.useRef<{
    loadedBytes: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const skipAutoScrollRef = React.useRef(false);
  const effectiveModelKey = chatModelKey ?? defaultModelKey;
  const segments = state.projection?.workMemorySegments;
  const rows = React.useMemo(
    () => selectPetChatRows(chatState.messages, segments, delegationReceipts, hostActionReceipts),
    [chatState.messages, delegationReceipts, hostActionReceipts, segments],
  );
  const chatActivity = React.useMemo(
    () => describePetChatActivity(chatState.messages, t),
    [chatState.messages, t],
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

  const requestOlderHistory = React.useCallback((): void => {
    const scroller = scrollRef.current;
    if (
      !scroller ||
      !chatHistoryHasMore ||
      chatBusy ||
      chatHistoryLoading ||
      historyRequestPendingRef.current
    ) {
      return;
    }
    historyRequestPendingRef.current = true;
    pendingHistoryAnchorRef.current = {
      loadedBytes: chatHistoryLoadedBytes,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
    };
    void loadOlderChatHistory().then((loaded) => {
      historyRequestPendingRef.current = false;
      if (!loaded) pendingHistoryAnchorRef.current = null;
    });
  }, [
    chatBusy,
    chatHistoryHasMore,
    chatHistoryLoadedBytes,
    chatHistoryLoading,
    loadOlderChatHistory,
  ]);

  React.useLayoutEffect(() => {
    const pending = pendingHistoryAnchorRef.current;
    const scroller = scrollRef.current;
    if (!pending || !scroller || chatHistoryLoadedBytes <= pending.loadedBytes) return;
    scroller.scrollTop =
      pending.scrollTop + Math.max(0, scroller.scrollHeight - pending.scrollHeight);
    pendingHistoryAnchorRef.current = null;
    skipAutoScrollRef.current = true;
  }, [chatHistoryLoadedBytes, rows.length]);

  React.useEffect(() => {
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chatBusy, rows.length, rows.at(-1)?.text]);

  const setDraft = (draft: string): void => dispatch({ type: "set-chat-draft", draft });

  const dragHasFiles = (dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    return (
      dataTransfer.files.length > 0 ||
      Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file") ||
      Array.from(dataTransfer.types ?? []).includes(CODESHELL_PATH_DND_MIME)
    );
  };

  const onDragEnter = (event: React.DragEvent<HTMLElement>): void => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDragOver(true);
  };

  const onDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: React.DragEvent<HTMLElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setDragOver(false);
  };

  const onDrop = (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setDragOver(false);
    const candidates: string[] = [];
    const internalPath = event.dataTransfer.getData(CODESHELL_PATH_DND_MIME);
    if (internalPath) candidates.push(internalPath);
    for (const file of Array.from(event.dataTransfer.files ?? [])) {
      const resolved = pathForRendererFile(file);
      if (resolved) candidates.push(resolved);
    }
    const accepted = normalizePetPathAttachments(candidates);
    if (accepted.length === 0) {
      setError(t("pet.chat.filePathUnavailable"));
      return;
    }
    setPathAttachments((current) => normalizePetPathAttachments([...current, ...accepted]));
    setError(null);
  };

  const submitToPet = async (): Promise<void> => {
    const message = buildPetMessageWithPathAttachments(
      state.chatDraft,
      pathAttachments,
      t("pet.chat.localFilePaths"),
    );
    if (!message || !petSessionId || chatBusy) return;
    const clientMessageId = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setDraft("");
    setPathAttachments([]);
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
      className={`mimi-surface relative flex min-h-[360px] w-full flex-col overflow-hidden rounded-3xl @min-[1100px]/pet-page:col-start-1 @min-[1100px]/pet-page:row-start-1 @min-[1100px]/pet-page:min-h-0 @min-[1100px]/pet-page:max-w-[960px] @min-[1100px]/pet-page:justify-self-center ${
        dragOver ? "ring-2 ring-inset ring-primary/50" : ""
      }`}
      aria-label={t("pet.chat.title")}
      data-pet-manager-chat="true"
      data-pet-auto-routing="true"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-2xl border border-primary/30 bg-background px-4 py-3 text-sm font-medium text-primary shadow-lg">
            <FileText size={17} aria-hidden="true" />
            {t("pet.chat.dropFiles")}
          </div>
        </div>
      )}
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
        <div className="flex shrink-0 items-center gap-2">
          <ModelPill
            activeKey={effectiveModelKey}
            options={modelOptions}
            onSelect={(option) => setChatModelKey(option.key)}
            disabled={chatBusy || modelOptions.length === 0}
            portal
          />
          {onOpenSettings && (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
              aria-label={t("pet.settings.open")}
              title={t("pet.settings.open")}
              onClick={onOpenSettings}
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto bg-muted/15 px-4 py-5 @min-[1440px]/pet-page:px-5"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop <= 72) requestOlderHistory();
        }}
      >
        {(chatHistoryHasMore || chatHistoryLoading) && (
          <div className="mb-3.5 flex justify-center" data-pet-chat-history-page="true">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm transition hover:bg-muted disabled:cursor-wait disabled:opacity-70"
              disabled={chatBusy || chatHistoryLoading}
              onClick={requestOlderHistory}
            >
              {chatHistoryLoading && (
                <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
              )}
              {chatHistoryLoading
                ? t("pet.chat.loadingOlderHistory")
                : t("pet.chat.loadOlderHistory")}
            </button>
          </div>
        )}
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
                        dogIcon={dogIcon}
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
                dogIcon={dogIcon}
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
                <div
                  className="flex items-center gap-2 rounded-2xl rounded-tl-md border border-border/60 bg-background px-3.5 py-2.5 text-xs text-muted-foreground shadow-sm"
                  role="status"
                  aria-live="polite"
                  data-pet-chat-activity={chatActivity.phase}
                  {...(chatActivity.toolName
                    ? { "data-pet-chat-tool": chatActivity.toolName }
                    : {})}
                >
                  <LoaderCircle
                    size={13}
                    className="shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  <span>{chatActivity.text}</span>
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
          {pathAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pb-2" data-pet-path-attachments="true">
              {pathAttachments.map((path) => (
                <span
                  key={path}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-muted/55 px-2 py-1 text-xs text-foreground"
                  title={path}
                >
                  <FileText size={12} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 max-w-80">
                    <span className="block truncate font-medium">{petPathBasename(path)}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{path}</span>
                  </span>
                  <button
                    type="button"
                    className="rounded-sm text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                    aria-label={t("pet.chat.removeFile", { name: petPathBasename(path) })}
                    onClick={() =>
                      setPathAttachments((current) => current.filter((item) => item !== path))
                    }
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
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
              disabled={
                (!state.chatDraft.trim() && pathAttachments.length === 0) ||
                !petSessionId ||
                chatBusy
              }
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
