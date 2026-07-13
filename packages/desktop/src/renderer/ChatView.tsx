import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CornerDownRight,
  Paperclip,
  Mic,
  Loader2,
  ArrowUp,
  Square,
  Monitor,
  Trash2,
  X,
} from "lucide-react";
import { MessageStream, type ContextPackageCreatedHandler } from "./MessageStream";
import type { Message } from "./types";
import { loadHistory, pushHistory } from "./promptHistory";
import { PermissionPill, type PermissionMode } from "./chat/PermissionPill";
import { GoalToggle } from "./chat/GoalToggle";
import { ModelPill, type ModelOption } from "./chat/ModelPill";
import { Lightbox, type LightboxItem } from "./chat/Lightbox";
import { ContextRing } from "./chat/ContextRing";
import { ProjectPicker } from "./chat/ProjectPicker";
import { BranchPicker } from "./chat/BranchPicker";
import { AskUserMessageView } from "./messages/AskUserMessageView";
import { ApprovalCard } from "./approvals/ApprovalCard";
import type { ApproveChoice, ApprovePathScope } from "./approvals/approvalDecision";
import type { AskUserMessage } from "./types";
import type { TrackedProject } from "./projects";
import type { ApprovalRequestEnvelope, FileSearchHit, InputAttachmentMeta } from "../preload/types";
import {
  buildAttachments,
  decodeWireForDisplay,
  encodeAttachmentsForWire,
  filesFromClipboard,
  imageFilesFromDrop,
  CODESHELL_PATH_DND_MIME,
  type ImageAttachment,
} from "./chat/attachments";
import { compressBatch, type ImageDetail } from "./chat/compress";
import { MentionPopover, type MentionItem } from "./chat/MentionPopover";
import { detectMention } from "./chat/mention";
import { classifyPath } from "./tool-cards/attachments";
import { formatBytes, cn } from "@/lib/utils";
import { useToast } from "./ui/ToastProvider";
import { encodeAnchorsForWire, type Anchor } from "./chat/anchors";
import { pageAttribution } from "./browser/markerEcho";
import { useT } from "./i18n/I18nProvider";

interface Props {
  /** Quick chats reuse the normal composer but omit durable-session controls. */
  variant?: "main" | "quickChat" | "pet";
  messages: Message[];
  /**
   * True while an EXISTING session picked from the sidebar is being hydrated
   * (no localStorage projection yet). `messages` is empty in this frame, but it
   * is NOT a fresh draft — show a loading placeholder instead of the "新建对话"
   * welcome hero so we don't flash "new chat" before history paints.
   */
  awaitingHydration?: boolean;
  turnEpoch?: number;
  /** Engine session id — lets the Files-Changed card do turn-level undo/redo. */
  engineSessionId?: string | null;
  liveTurnActive?: boolean;
  onContextPackageCreated?: ContextPackageCreatedHandler;
  sendBucket?: string;
  onSend: (
    text: string,
    opts?: {
      bucket?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      displayText?: string;
    },
  ) => void;
  onQueueInput?: (
    text: string,
    opts?: {
      bucket?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      displayText?: string;
    },
  ) => void;
  onForceSend?: (
    text: string,
    opts?: {
      bucket?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      displayText?: string;
    },
  ) => void;
  onCompactCommand?: () => void;
  onStop: () => void;
  busy: boolean;
  compacting?: boolean;
  queuedInputCount?: number;
  queuedInputItems?: string[];
  onClearQueuedInput?: () => void;
  onRemoveQueuedInput?: (index: number) => void;
  /** Interrupt the current turn and send the ENTIRE queue at once (merged).
   *  Replaces the old per-item promote — the user wants everything they queued
   *  to land in the next turn, not one message per turn. */
  onGuideQueuedInput?: () => void;
  /** Count of background sub-agents still running in this session. Shown as a
   *  separate "后台 N 个子代理运行中" hint even after busy clears (run_in_background
   *  resolves the main run immediately while children keep working). */
  runningAgents?: number;
  activeProjectId: string | null;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  /** Extend the running goal (TODO 3.1). opts target the nearest ceiling. */
  onExtendGoal?: (opts: {
    addTurns?: number;
    addStopBlocks?: number;
    addTokenBudget?: number;
    addTimeBudgetMs?: number;
  }) => void;
  /** Attach an image to the composer by absolute path (file-panel drag — TODO 2.1). */
  onAttachImagePath?: (absPath: string) => void;
  /** Ensure the current draft has a cwd/sessionId suitable for attachment staging. */
  onPrepareAttachmentSession?: () => {
    cwd: string;
    sessionId: string;
    /** Ephemeral side-chat generation; main validates it before/after disk IO. */
    quickChatClaimId?: string;
  } | null;
  /** Provider-agnostic image clarity; drives renderer-side downscale before send. */
  imageDetail?: ImageDetail;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;

  // Composer controls
  permissionMode: PermissionMode | null;
  onPermissionChange: (m: PermissionMode) => void;
  /** Goal 模式开关(与权限正交)。开启时这条消息当目标,跑到完成为止。 */
  goalEnabled: boolean;
  onGoalToggle: (next: boolean) => void;
  modelOptions: ModelOption[];
  activeModelKey: string | null;
  onModelChange: (opt: ModelOption) => void;
  contextTokens: number;
  contextMax?: number;
  singleTurnPromptTokens?: number;
  singleTurnCacheReadTokens?: number;
  singleTurnCacheCreationTokens?: number;
  cumulativePromptTokens?: number;
  cumulativeCacheReadTokens?: number;
  cumulativeCacheCreationTokens?: number;

  // Project picker (composer second row)
  projects: TrackedProject[];
  onSelectProject: (id: string | null) => void;
  onAddProject: () => void;
  activeProjectPath: string | null;
  /** cwd for resolving message content (relative path links / inline images).
   *  Equals activeProjectPath for a real project, the sandbox cwd for a no-project chat.
   *  Kept separate from activeProjectPath so git/STT/branch stay project-only. */
  messageCwd?: string | null;
  repoClean?: boolean | null;

  // Title shown above the composer in new-chat mode (empty stream)
  welcomeNode?: React.ReactNode;
  /**
   * Seed text to drop into the composer (without sending). Bump `composerSeedNonce`
   * to re-apply the same text. Used by the "新建自动化" entry to start a
   * conversational automation setup.
   */
  composerSeed?: string;
  composerSeedNonce?: number;
  /** Composer draft state is owned by App so full-page routes don't lose it. */
  draft: string;
  onDraftChange: React.Dispatch<React.SetStateAction<string>>;
  attachments: ImageAttachment[];
  onAttachmentsChange: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  /** Comment anchors pinned from the panels; shown as chips above the composer. */
  anchors?: Anchor[];
  onRemoveAnchor?: (id: string) => void;
  onClearAnchors?: () => void;
}

const MAX_TEXTAREA_PX = 200;
// One-line floor for the auto-size. A mid-layout measurement (dock reflow on
// session switch) can report scrollHeight ~0; flooring here stops the box from
// collapsing to a sliver. Matches the textarea's CSS min-h backstop.
const MIN_TEXTAREA_PX = 36;

type SlashCommandItem = {
  name: "/compact";
  title: string;
  description: string;
};

function detectSlashCommand(value: string, caret: number): { query: string } | null {
  if (!value.startsWith("/")) return null;
  const beforeCaret = value.slice(0, caret);
  if (!beforeCaret.startsWith("/") || /\s/.test(beforeCaret)) return null;
  const firstWhitespace = value.search(/\s/);
  if (firstWhitespace !== -1 && caret > firstWhitespace) return null;
  return { query: beforeCaret.slice(1).toLowerCase() };
}

function toRunAttachments(images: ImageAttachment[]): InputAttachmentMeta[] {
  return images
    .filter((img) => !!img.path && !!img.absPath)
    .map((img) => ({
      id: img.id,
      sessionId: img.sessionId ?? "",
      kind: "image" as const,
      origin: img.origin ?? "paste",
      path: img.path!,
      absPath: img.absPath!,
      relPath: img.relPath,
      mime: img.mime,
      size: img.size,
      sha256: img.sha256 ?? "",
      originalName: img.name,
      createdAt: img.createdAt ?? Date.now(),
      sourcePath: img.sourcePath,
      vision: { include: true },
    }));
}

function referenceFromFileHit(
  hit: FileSearchHit,
  cwd: string | null | undefined,
  sessionId: string | null | undefined,
): InputAttachmentMeta | null {
  if (!cwd) return null;
  const absPath = joinCwdPath(cwd, hit.path);
  return {
    id: `ref_${hit.kind}_${hashKey(hit.path)}_${Date.now().toString(36)}`,
    sessionId: sessionId || "mention",
    kind: hit.kind === "dir" ? "directory" : "file",
    origin: "mention",
    path: hit.path,
    absPath,
    relPath: hit.path,
    mime: hit.mime,
    size: hit.size ?? 0,
    sha256: "",
    originalName: hit.name,
    createdAt: Date.now(),
  };
}

function referenceFromAbsPath(
  absPath: string,
  cwd: string | null | undefined,
  sessionId: string | null | undefined,
): InputAttachmentMeta {
  const relPath = cwd ? relativeBrowserPath(cwd, absPath) : null;
  return {
    id: `ref_file_${hashKey(absPath)}_${Date.now().toString(36)}`,
    sessionId: sessionId || "file-panel",
    kind: "file",
    origin: "file-panel",
    path: relPath ?? absPath,
    absPath,
    relPath: relPath ?? undefined,
    size: 0,
    sha256: "",
    originalName: absPath.split(/[\\/]/).pop() || absPath,
    createdAt: Date.now(),
  };
}

function joinCwdPath(cwd: string, relPath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(relPath)) return relPath;
  return `${cwd.replace(/[\\/]+$/, "")}/${relPath.replace(/^\/+/, "")}`;
}

function relativeBrowserPath(cwd: string, absPath: string): string | null {
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = absPath.replace(/\\/g, "/");
  if (!target.startsWith(`${base}/`)) return null;
  return target.slice(base.length + 1);
}

function hashKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function appendReference(
  refs: InputAttachmentMeta[],
  ref: InputAttachmentMeta | null,
): InputAttachmentMeta[] {
  if (!ref) return refs;
  if (refs.some((item) => item.kind === ref.kind && item.path === ref.path)) return refs;
  return [...refs, ref];
}

export function ChatView({
  variant = "main",
  messages,
  awaitingHydration = false,
  turnEpoch,
  engineSessionId,
  liveTurnActive,
  onContextPackageCreated,
  sendBucket,
  onSend,
  onQueueInput,
  onForceSend,
  onCompactCommand,
  onStop,
  busy,
  compacting = false,
  queuedInputCount = 0,
  queuedInputItems = [],
  onClearQueuedInput,
  onRemoveQueuedInput,
  onGuideQueuedInput,
  runningAgents = 0,
  activeProjectId,
  onAskUserAnswer,
  onExtendGoal,
  onAttachImagePath,
  onPrepareAttachmentSession,
  imageDetail,
  pendingApproval,
  onApprovalDecide,
  permissionMode,
  onPermissionChange,
  goalEnabled,
  onGoalToggle,
  modelOptions,
  activeModelKey,
  onModelChange,
  contextTokens,
  contextMax,
  singleTurnPromptTokens,
  singleTurnCacheReadTokens,
  singleTurnCacheCreationTokens,
  cumulativePromptTokens,
  cumulativeCacheReadTokens,
  cumulativeCacheCreationTokens,
  projects,
  onSelectProject,
  onAddProject,
  activeProjectPath,
  messageCwd,
  repoClean,
  welcomeNode,
  composerSeed,
  composerSeedNonce,
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
  anchors = [],
  onRemoveAnchor,
  onClearAnchors,
}: Props) {
  const { t } = useT();
  const [history, setHistory] = useState<string[]>(() =>
    variant === "main" ? loadHistory(activeProjectId) : [],
  );
  const [historyCursor, setHistoryCursor] = useState(-1);
  const liveDraftStash = useRef<string>("");
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Lightbox for staged attachment thumbnails (click to zoom). Mirrors
  // MessageStream's gallery zoom.
  const [zoomed, setZoomed] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const setDraft = onDraftChange;
  const setAttachments = onAttachmentsChange;
  const [inputReferences, setInputReferences] = useState<InputAttachmentMeta[]>([]);
  const toast = useToast();

  // ─── Voice input (听写) ───────────────────────────────────────────────
  // Record the mic → transcribe via core (window.codeshell.transcribeAudio) →
  // append the text to the draft for the user to edit (NOT auto-send). idle →
  // recording → transcribing → idle.
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const mountedRef = useRef(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Whether a transcription provider is configured (or fallback-reachable). When
  // false the mic button is disabled with a "configure in settings" tooltip,
  // instead of letting the user record and only then hit "no-audio-provider".
  const [sttAvailable, setSttAvailable] = useState(false);
  // Auto-stop a runaway recording so a forgotten mic can't rack up cost / hit
  // the provider's upload size limit. The user can still stop earlier manually.
  const MAX_RECORDING_MS = 120_000; // 2 min
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (maxDurationTimerRef.current) {
        clearTimeout(maxDurationTimerRef.current);
        maxDurationTimerRef.current = null;
      }
      const recorder = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      if (recorder) {
        // Detach first: stop() normally fires onstop, which would otherwise
        // start transcription after the quick-chat surface has disappeared.
        recorder.onstop = null;
        recorder.ondataavailable = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // Best effort: tracks are stopped independently below.
        }
      }
      const stream = mediaStreamRef.current;
      mediaStreamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      audioChunksRef.current = [];
    };
  }, []);

  // Probe transcription availability on mount + when the project changes, so the
  // mic button reflects whether voice input is usable right now.
  useEffect(() => {
    let cancelled = false;
    void window.codeshell
      .sttAvailable(activeProjectPath ?? "")
      .then((r) => {
        if (!cancelled) setSttAvailable(r.available);
      })
      .catch(() => {
        if (!cancelled) setSttAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath]);

  const transcribeChunks = useCallback(
    async (blob: Blob, mimeType: string) => {
      if (!mountedRef.current) return;
      setVoiceState("transcribing");
      try {
        const buf = await blob.arrayBuffer();
        if (!mountedRef.current) return;
        const res = await window.codeshell.transcribeAudio({
          cwd: activeProjectPath ?? "",
          audio: buf,
          mimeType,
        });
        if (!mountedRef.current) return;
        if (res.ok) {
          const text = res.text.trim();
          if (text) {
            setDraft((current) =>
              current && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`,
            );
            textareaRef.current?.focus();
          }
        } else if (res.error === "no-audio-provider") {
          toast({ message: t("chat.composer.voiceNoProvider"), variant: "error" });
        } else {
          toast({ message: t("chat.composer.voiceFailed"), variant: "error" });
        }
      } catch {
        if (mountedRef.current) {
          toast({ message: t("chat.composer.voiceFailed"), variant: "error" });
        }
      } finally {
        if (mountedRef.current) setVoiceState("idle");
      }
    },
    [activeProjectPath, setDraft, toast, t],
  );

  const startRecording = useCallback(async () => {
    try {
      // macOS gates the mic at the OS level — request access first so the user
      // gets the system prompt (and we surface a clear message if denied).
      const access = await window.codeshell.ensureMicAccess();
      if (!mountedRef.current) return;
      if (!access.granted) {
        toast({ message: t("chat.composer.voicePermissionDenied"), variant: "error" });
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const mr = new MediaRecorder(stream, { mimeType: mime });
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop()); // release the mic
        if (mediaStreamRef.current === stream) mediaStreamRef.current = null;
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType });
        audioChunksRef.current = [];
        if (!mountedRef.current) return;
        if (blob.size > 0) void transcribeChunks(blob, mr.mimeType);
        else setVoiceState("idle");
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setVoiceState("recording");
      // Cap recording length; auto-stop (→ transcribe what we have).
      if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        mediaRecorderRef.current?.stop();
        mediaRecorderRef.current = null;
      }, MAX_RECORDING_MS);
    } catch (err) {
      const stream = mediaStreamRef.current;
      mediaStreamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (!mountedRef.current) return;
      const name = (err as Error)?.name;
      toast({
        message:
          name === "NotAllowedError" || name === "SecurityError"
            ? t("chat.composer.voicePermissionDenied")
            : t("chat.composer.voiceFailed"),
        variant: "error",
      });
      setVoiceState("idle");
    }
  }, [transcribeChunks, toast, t]);

  const stopRecording = useCallback(() => {
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  const onVoiceClick = useCallback(() => {
    if (voiceState === "recording") stopRecording();
    else if (voiceState === "idle") void startRecording();
    // transcribing: ignore clicks until it resolves.
  }, [voiceState, startRecording, stopRecording]);

  // @-mention state. `mention` is non-null while the caret sits inside
  // an @-token (no whitespace between the `@` and caret); `start` marks
  // the position of the `@` itself, `query` is everything typed after it.
  // `selected` is the index into the popover's flat item list and is
  // clamped by `mentionItems` (the popover bubbles its list back up).
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionSelected, setMentionSelected] = useState(0);
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashSelected, setSlashSelected] = useState(0);

  const activeModel = modelOptions.find((o) => o.key === activeModelKey) ?? null;
  const activeSupportsVision = activeModel?.supportsVision === true;
  const slashCommands = useMemo<SlashCommandItem[]>(
    () =>
      onCompactCommand
        ? [
            {
              name: "/compact",
              title: t("chat.slash.compactTitle"),
              description: t("chat.slash.compactDescription"),
            },
          ]
        : [],
    [onCompactCommand, t],
  );
  const slashItems = useMemo(() => {
    if (!slash) return [];
    const query = slash.query.trim().toLowerCase();
    if (!query) return slashCommands;
    return slashCommands.filter(
      (cmd) =>
        cmd.name.slice(1).toLowerCase().includes(query) || cmd.title.toLowerCase().includes(query),
    );
  }, [slash, slashCommands]);

  // Seed the composer from outside (e.g. the "新建自动化" entry) without
  // sending. Keyed on the nonce so re-clicking re-applies the same text.
  useEffect(() => {
    if (composerSeed && composerSeed.length > 0) {
      setDraft(composerSeed);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(composerSeed.length, composerSeed.length);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSeedNonce]);

  useEffect(() => {
    setHistory(variant === "main" ? loadHistory(activeProjectId) : []);
    setHistoryCursor(-1);
    liveDraftStash.current = "";
  }, [activeProjectId, variant]);

  // Auto-size the composer to its content by measuring scrollHeight. The catch:
  // scrollHeight is only right once the textarea is actually laid out at its
  // final width. When the right dock opens/closes or the user switches sessions,
  // the width reflows — and a measurement taken mid-reflow reads ~0 and collapses
  // the box. Earlier attempts (re-running on `draft` / `engineSessionId`) failed
  // because they re-measured at a moment the layout was STILL unstable.
  //
  // The fix is to re-measure when the layout actually settles, not when we guess
  // it might have. A ResizeObserver on the textarea fires whenever its box size
  // changes — dock toggle, session-switch reflow, window resize — so the height
  // is recomputed against the real, settled width every time. The clamp keeps it
  // between one line and the max; the CSS `min-h-*` is a static backstop for the
  // instant before the observer's first callback.
  // Auto-size the composer to its content. The earlier "collapse" wasn't here —
  // the textarea always measured fine (36px); the composer BLOCK was being
  // flex-shrunk by the message stream (see the `shrink-0` on its wrapper). This
  // just grows the textarea with content, capped at MAX.
  const measureComposer = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(ta.scrollHeight, MIN_TEXTAREA_PX), MAX_TEXTAREA_PX) + "px";
  }, []);

  // Re-measure on content change (typing/clearing doesn't always change the
  // box's outer size, so the observer alone wouldn't catch it).
  useLayoutEffect(() => {
    measureComposer();
  }, [draft, measureComposer]);

  // Re-measure on any layout change to the textarea's own box (dock open/close,
  // session-switch reflow, window resize). Mounts once; observes the element.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureComposer());
    ro.observe(ta);
    return () => ro.disconnect();
  }, [measureComposer]);

  // Busy no longer disables the textarea: Enter queues input for the next turn.
  // Manual compaction is the exception because it is an uncancellable RPC, not
  // an agent turn, so we block composer edits/actions until it settles.
  const controlsDisabled = busy || compacting;
  const inputDisabled = compacting;
  const placeholder = compacting
    ? t("chat.composer.placeholderCompacting")
    : busy
      ? t("chat.composer.placeholderBusy")
      : t("chat.composer.placeholderIdle");

  const closeMention = (): void => {
    setMention(null);
    setMentionSelected(0);
  };

  const closeSlash = (): void => {
    setSlash(null);
    setSlashSelected(0);
  };

  const updateInlinePickers = (value: string, caret: number): void => {
    const nextMention = detectMention(value, caret);
    if (nextMention) {
      if (!mention || mention.query !== nextMention.query) setMentionSelected(0);
      setMention(nextMention);
      if (slash) closeSlash();
      return;
    }

    if (mention) closeMention();

    const nextSlash = slashCommands.length > 0 ? detectSlashCommand(value, caret) : null;
    if (nextSlash) {
      if (!slash || slash.query !== nextSlash.query) setSlashSelected(0);
      setSlash(nextSlash);
    } else if (slash) {
      closeSlash();
    }
  };

  useEffect(() => {
    setSlashSelected((s) => (slashItems.length === 0 ? 0 : Math.min(s, slashItems.length - 1)));
  }, [slashItems]);

  // Insert an `@path` reference into the draft (file-panel drag of a non-image
  // file — TODO 2.1). Appends at the caret, or at the end with a leading space
  // if the draft doesn't already end with whitespace.
  const insertPathReference = (absPath: string): void => {
    const attachmentContext = onPrepareAttachmentSession?.();
    setInputReferences((cur) =>
      appendReference(
        cur,
        referenceFromAbsPath(
          absPath,
          attachmentContext?.cwd ?? messageCwd,
          attachmentContext?.sessionId ?? engineSessionId,
        ),
      ),
    );
    const ta = textareaRef.current;
    const ref = `@${absPath} `;
    if (ta && ta.selectionStart != null) {
      const caret = ta.selectionStart;
      const before = draft.slice(0, caret);
      const after = draft.slice(caret);
      const sep = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const next = before + sep + ref + after;
      setDraft(next);
      const nextCaret = before.length + sep.length + ref.length;
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
      return;
    }
    const sep = draft.length > 0 && !/\s$/.test(draft) ? " " : "";
    setDraft(draft + sep + ref);
  };

  const applyMentionPick = (item: MentionItem): void => {
    if (!mention) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    const insertion =
      item.kind === "skill"
        ? `@${item.skill.name} `
        : item.kind === "recent"
          ? `@${item.attachment.path} `
          : `@${item.file.path} `;
    if (item.kind === "file") {
      const attachmentContext = onPrepareAttachmentSession?.();
      setInputReferences((cur) =>
        appendReference(
          cur,
          referenceFromFileHit(
            item.file,
            attachmentContext?.cwd ?? messageCwd,
            attachmentContext?.sessionId ?? engineSessionId,
          ),
        ),
      );
    } else if (item.kind === "recent") {
      setInputReferences((cur) => appendReference(cur, item.attachment));
    }
    const next = before + insertion + after;
    setDraft(next);
    closeMention();
    // After React paints, restore caret to the end of the inserted token.
    const nextCaret = before.length + insertion.length;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };

  const completeSlashCommand = (item: SlashCommandItem): void => {
    setDraft(item.name);
    closeSlash();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(item.name.length, item.name.length);
    });
  };

  const executeSlashCommand = (item: SlashCommandItem): void => {
    if (compacting) return;
    if (item.name === "/compact") {
      if (!onCompactCommand) return;
      onCompactCommand();
      setDraft("");
      setInputReferences([]);
      setAttachmentError(null);
      setHistoryCursor(-1);
      liveDraftStash.current = "";
      closeSlash();
    }
  };

  const submit = (): void => {
    if (compacting) return;
    // Some embedded variants (quick chat) intentionally do not support the
    // main session's queued-input pipeline. Keep the draft intact while busy.
    if (busy && !onQueueInput) return;
    const text = draft.trim();
    const hasImages = attachments.length > 0;
    const hasAnchors = anchors.length > 0;
    if (!text && !hasImages && !hasAnchors) return;
    if (text === "/compact" && !hasImages && !hasAnchors && slashCommands[0]) {
      executeSlashCommand(slashCommands[0]);
      return;
    }
    // Block send when there are images but the active model can't accept
    // them. The UI shows an inline banner with options (switch model /
    // remove images) so this branch is just a safety net.
    if (hasImages && !activeSupportsVision) {
      setAttachmentError(t("chat.composer.visionUnsupportedSend"));
      return;
    }
    if (hasImages && attachments.some((img) => !img.path)) {
      setAttachmentError(t("chat.attachment.missingPath"));
      return;
    }
    // Anchors (diff/browser/file comments) are prepended as a structured block
    // so the model can pin each comment to its exact location.
    const withAnchors = encodeAnchorsForWire(text, anchors);
    const displayPayload = encodeAttachmentsForWire(withAnchors, attachments);
    const runAttachments = [...toRunAttachments(attachments), ...inputReferences];
    const routeOpts = sendBucket ? { bucket: sendBucket } : undefined;
    if (busy)
      onQueueInput?.(withAnchors, {
        ...routeOpts,
        attachments: runAttachments,
        displayText: displayPayload,
      });
    else
      onSend(withAnchors, {
        ...routeOpts,
        attachments: runAttachments,
        displayText: displayPayload,
      });
    // Snap the stream to the bottom + re-arm follow regardless of scroll pos.
    setSendEpoch((n) => n + 1);
    // Reusing the main composer must not make ephemeral side prompts durable.
    if (text && variant === "main") setHistory(pushHistory(activeProjectId, text));
    setDraft("");
    setAttachments([]);
    setInputReferences([]);
    setAttachmentError(null);
    setHistoryCursor(-1);
    liveDraftStash.current = "";
    onClearAnchors?.();
  };

  const acceptFiles = async (files: File[], origin: "paste" | "os-drop" | "picker") => {
    if (compacting) return;
    if (files.length === 0) return;
    setAttachmentError(null);
    const { accepted, errors } = await buildAttachments(files, attachments);
    if (!mountedRef.current) return;
    if (accepted.length > 0) {
      // Compress before staging so the chip thumbnail and the wire
      // payload share the same bytes — keeps the UI honest about what
      // will actually be sent. compressBatch never throws; it falls
      // back to the original if encoding fails (engine policy still
      // gates oversize bytes downstream).
      const compressed = await compressBatch(accepted, imageDetail);
      if (!mountedRef.current) return;
      const context = onPrepareAttachmentSession?.();
      if (!context) {
        errors.push({
          kind: "staging-failed",
          message: t("chat.attachment.stagingUnavailable"),
        });
      } else {
        try {
          const staged = await Promise.all(
            compressed.map(async (att) => {
              const meta = await window.codeshell.stageAttachmentImageDataUrl({
                cwd: context.cwd,
                sessionId: context.sessionId,
                name: att.name,
                mime: att.mime,
                dataUrl: att.dataUrl,
                origin,
                quickChatClaimId: context.quickChatClaimId,
              });
              return {
                ...att,
                id: meta.id,
                path: meta.path,
                relPath: meta.relPath,
                absPath: meta.absPath,
                sha256: meta.sha256,
                origin: meta.origin,
                sessionId: meta.sessionId,
                createdAt: meta.createdAt,
                size: meta.size,
                mime: meta.mime ?? att.mime,
              };
            }),
          );
          if (!mountedRef.current) return;
          setAttachments((cur) => [...cur, ...staged]);
        } catch (e) {
          if (!mountedRef.current) return;
          errors.push({
            kind: "staging-failed",
            message: t("chat.attachment.stagingFailed", {
              message: (e as Error).message,
            }),
          });
        }
      }
    }
    if (mountedRef.current && errors.length > 0) {
      setAttachmentError(errors.map((e) => e.message).join("；"));
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (compacting) return;
    const imageFiles = filesFromClipboard(e.clipboardData?.items ?? null);
    if (imageFiles.length === 0) return;
    e.preventDefault();
    await acceptFiles(imageFiles, "paste");
  };

  const removeAttachment = (id: string) => {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing || e.nativeEvent.isComposing) return;

    if (slash) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return;
      }
      if (slashItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelected((s) => (s + 1) % slashItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelected((s) => (s - 1 + slashItems.length) % slashItems.length);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const pick = slashItems[Math.min(slashSelected, slashItems.length - 1)];
          if (pick) completeSlashCommand(pick);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const pick = slashItems[Math.min(slashSelected, slashItems.length - 1)];
          if (!pick) return;
          if (draft.trim() === pick.name) executeSlashCommand(pick);
          else completeSlashCommand(pick);
          return;
        }
      }
    }

    // While the @-mention popover is open, intercept navigation keys.
    // Backspace falls through so the user can edit the query naturally;
    // detectMention runs in onChange and will close the popover if the
    // edit kills the @-token.
    if (mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
      if (mentionItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionSelected((s) => (s + 1) % mentionItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionSelected((s) => (s - 1 + mentionItems.length) % mentionItems.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const pick = mentionItems[Math.min(mentionSelected, mentionItems.length - 1)];
          if (pick) applyMentionPick(pick);
          return;
        }
      }
    }

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      submit();
      return;
    }

    const browsingHistory = historyCursor !== -1;
    const canEnterHistory =
      (e.key === "ArrowUp" || e.key === "ArrowDown") && (draft.length === 0 || browsingHistory);

    if (!canEnterHistory) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      if (!browsingHistory) liveDraftStash.current = draft;
      const next = Math.min(historyCursor + 1, history.length - 1);
      setHistoryCursor(next);
      setDraft(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!browsingHistory) return;
      const next = historyCursor - 1;
      if (next < 0) {
        setHistoryCursor(-1);
        setDraft(liveDraftStash.current);
      } else {
        setHistoryCursor(next);
        setDraft(history[next]);
      }
    }
  };

  // Pin any unanswered AskUser above the composer so it stays
  // visible as new chat messages roll in. The latest TaskList is
  // surfaced via the TopBar status popover instead of pinning here.
  let openAsk: AskUserMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "ask_user" && m.answer === undefined) {
      openAsk = m;
      break;
    }
  }

  // A truly new/draft chat has no messages AND isn't mid-hydration. An existing
  // session being hydrated also has messages.length === 0 for a frame, but must
  // NOT render as the welcome hero (see awaitingHydration) — it shows a loading
  // placeholder below instead.
  const isNewChat = messages.length === 0 && !awaitingHydration;

  // Codex-style inline approvals: when an approval is pending, drop
  // the full ApprovalCard at the tail of the chat stream so it scrolls
  // with the conversation. A compact sticky bar appears above the
  // composer only when the inline card scrolls out of the viewport.
  const inlineApprovalRef = useRef<HTMLDivElement>(null);
  const [inlineApprovalVisible, setInlineApprovalVisible] = useState(true);
  // Bumped on each user send so the MessageStream unconditionally snaps to the
  // bottom + re-arms follow — the user always sees their own message, even if
  // they had scrolled up to read history.
  const [sendEpoch, setSendEpoch] = useState(0);
  useEffect(() => {
    if (!pendingApproval) {
      setInlineApprovalVisible(true);
      return;
    }
    const el = inlineApprovalRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInlineApprovalVisible(entry.isIntersecting),
      { root: el.closest(".stream") ?? undefined, threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pendingApproval?.requestId]);

  const inlineApproval =
    pendingApproval && onApprovalDecide ? (
      <div
        ref={inlineApprovalRef}
        className="mx-4 my-2"
        data-request-id={pendingApproval.requestId}
      >
        <ApprovalCard envelope={pendingApproval} onDecide={onApprovalDecide} />
      </div>
    ) : null;

  const showStickyApproval = !!pendingApproval && !!onApprovalDecide && !inlineApprovalVisible;

  // Show ALL queued items, not a 2-item slice — the old slice(0, 2) is what
  // made 引导 look like it "只能打断 2 句": only the first two ever rendered a
  // button, the rest hid behind a "+N" footer. Guide now drains the whole
  // queue at once anyway, so the list is purely a preview of what will send.
  const queuedPreviewItems = queuedInputItems.map((item) => {
    const decoded = decodeWireForDisplay(item);
    const text =
      decoded.text ||
      (decoded.images.length > 0
        ? t("chat.composer.imagesPlaceholder", { count: decoded.images.length })
        : item);
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  });

  // Drop handlers live on the whole chat surface, not just the composer.
  // Users drag a screenshot into the window expecting it to "land" — having
  // to aim at a 50px-tall composer is annoying. The composer still gets a
  // visual highlight via the same `dragOver` state, but the actual catcher
  // is the chat root. We DON'T pull this up to App because then Sidebar
  // drops (e.g. dragging a project folder onto the sidebar) would silently
  // become image attachments.
  // A drag is acceptable if it's an OS file drop OR an internal file-panel
  // image drag (carries our custom path MIME — TODO 2.1).
  const dragHasAcceptable = (dt: DataTransfer | null): boolean => {
    if (compacting) return false;
    if (!dt) return false;
    if (Array.from(dt.items ?? []).some((it) => it.kind === "file")) return true;
    return Array.from(dt.types ?? []).includes(CODESHELL_PATH_DND_MIME);
  };
  const onChatDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (dragHasAcceptable(e.dataTransfer)) {
      e.preventDefault();
      setDragOver(true);
    }
  };
  const onChatDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (dragHasAcceptable(e.dataTransfer)) {
      e.preventDefault();
    }
  };
  const onChatDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only kill the highlight when the cursor exits the chat surface
    // entirely — sub-element transitions fire dragleave/dragenter pairs
    // that we don't want to interpret as "left, then re-entered".
    if (e.target === e.currentTarget) setDragOver(false);
  };
  const onChatDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (compacting) return;
    // Internal file-panel drag. Image → attach as an image; any other file →
    // insert an `@path` reference into the draft (same convention as @mention),
    // so the user/model can refer to it.
    const draggedPath = e.dataTransfer?.getData(CODESHELL_PATH_DND_MIME);
    if (draggedPath) {
      if (classifyPath(draggedPath) === "image") {
        onAttachImagePath?.(draggedPath);
      } else {
        insertPathReference(draggedPath);
      }
      return;
    }
    const imageFiles = imageFilesFromDrop(e.dataTransfer?.items ?? null);
    if (imageFiles.length === 0) return;
    void acceptFiles(imageFiles, "os-drop");
  };

  return (
    <div
      className={
        "flex h-full min-w-0 max-w-full flex-col overflow-hidden" +
        (dragOver ? " ring-2 ring-inset ring-primary/40" : "")
      }
      data-mode={isNewChat ? "new" : "active"}
      data-chat-variant={variant}
      onDragEnter={onChatDragEnter}
      onDragOver={onChatDragOver}
      onDragLeave={onChatDragLeave}
      onDrop={onChatDrop}
    >
      {/*
        In new-chat mode the stream is empty; skip it so its flex-1 doesn't
        eat the vertical space and push the welcome + composer to the bottom.
        The welcome block below owns the flex-1 and centers itself instead.
      */}
      {awaitingHydration ? (
        // Existing session picked from the sidebar, not hydrated yet: owns the
        // flex-1 stream space with a centered spinner so the pane isn't blank
        // and doesn't flash the new-chat hero before history paints.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm">{t("chat.loadingSession")}</span>
        </div>
      ) : (
        !isNewChat && (
          <MessageStream
            messages={messages}
            turnEpoch={turnEpoch}
            engineSessionId={engineSessionId}
            liveTurnActive={liveTurnActive}
            onAskUserAnswer={onAskUserAnswer}
            onExtendGoal={onExtendGoal}
            trailing={inlineApproval}
            trailingKey={pendingApproval?.requestId ?? null}
            cwd={messageCwd ?? activeProjectPath}
            sendEpoch={sendEpoch}
            onContextPackageCreated={onContextPackageCreated}
          />
        )
      )}

      {(openAsk || showStickyApproval) && (
        <div className="px-4">
          {openAsk && (
            <AskUserMessageView message={openAsk} onAnswer={onAskUserAnswer ?? (() => undefined)} />
          )}
          {showStickyApproval && pendingApproval && onApprovalDecide && (
            <ApprovalCard envelope={pendingApproval} onDecide={onApprovalDecide} />
          )}
        </div>
      )}

      {/*
        New-chat mode centers the whole hero group — welcome text, composer,
        and project picker — in the empty stream space instead of pinning the
        composer to the bottom. The flex-1 wrapper claims that space and
        justify-center pulls the group to the middle; the composer is width-
        capped so it reads as a centered hero. In active mode this wrapper is
        absent (the MessageStream owns flex-1) and the composer stays pinned
        at the bottom as a plain p-3 block.
      */}
      <div
        className={
          isNewChat
            ? "flex min-w-0 max-w-full flex-1 flex-col items-center justify-center px-4"
            : "contents"
        }
      >
        {isNewChat && welcomeNode && (
          <div className="mb-4 flex flex-col items-center">{welcomeNode}</div>
        )}

        {/* shrink-0: the composer is a flex sibling of the message stream; without
            this it has the default flex-shrink:1 and the stream squeezes it
            smaller on every re-layout (session switch with the dock open),
            collapsing the input row by row. Pinning shrink to 0 keeps it at its
            content height regardless of how tall the stream gets. */}
        <div
          className={isNewChat ? "w-full min-w-0 max-w-2xl p-3" : "min-w-0 max-w-full shrink-0 p-3"}
        >
          {queuedInputItems.length > 0 && (
            <div className="mb-2 rounded-2xl border border-border/80 bg-background/80 px-3 py-2 shadow-sm">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
                  <CornerDownRight size={14} />
                  <span>{t("chat.queue.heading")}</span>
                  <span className="text-xs font-normal tabular-nums">
                    {queuedInputItems.length}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {busy && onGuideQueuedInput && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={t("chat.queue.guideAllAria")}
                      title={t("chat.queue.guideAllTitle")}
                      onClick={onGuideQueuedInput}
                    >
                      <CornerDownRight size={12} />
                      <span>{t("chat.queue.guideAll")}</span>
                    </button>
                  )}
                  {onClearQueuedInput && (
                    <button
                      type="button"
                      className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={t("chat.queue.clearAria")}
                      title={t("chat.queue.clearTitle")}
                      onClick={onClearQueuedInput}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                {queuedPreviewItems.map((item, i) => (
                  <div
                    key={i}
                    className="flex min-w-0 items-start gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-sm text-foreground"
                  >
                    <div className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words">
                      {item}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {onRemoveQueuedInput && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                          aria-label={t("chat.queue.removeItemAria", { index: i + 1 })}
                          title={t("chat.queue.removeItemTitle")}
                          onClick={() => onRemoveQueuedInput(i)}
                        >
                          <Trash2 size={12} />
                          <span>{t("chat.queue.removeItem")}</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/*
            Drop is captured at the chat root so the user can drag a screenshot
            anywhere in the chat surface. The composer keeps the visual highlight
            to make the landing spot obvious, but no longer owns the handlers.
          */}
          <div
            className={
              // sm:min-w-[300px]: stop the composer collapsing into an unusable
              // sliver when a side panel squeezes the desktop chat; keep phones
              // at min-w-0 so wide message content cannot force horizontal page
              // overflow. Keep this card out of the container-query tree: putting
              // container-type on the textarea's ancestor has collapsed the
              // composer during session/dock reflow.
              "min-w-0 max-w-full rounded-xl border bg-card p-2 shadow-sm sm:min-w-[300px]" +
              (dragOver ? " ring-2 ring-primary/40" : "")
            }
          >
            {anchors.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {anchors.map((a) => (
                  <div
                    key={a.id}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs"
                    title={`${a.comment}\n${Object.entries(a.locator)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join("\n")}`}
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {a.kind === "diff"
                        ? t("chat.anchors.diff")
                        : a.kind === "browser"
                          ? t("chat.anchors.browser")
                          : t("chat.anchors.file")}
                    </span>
                    <span className="truncate font-medium text-foreground">{a.label}</span>
                    {/* Page attribution for browser anchors — which page this was
                      circled on (圈选统一: feedback「不知道是哪一个页面的」). */}
                    {a.browser && (
                      <span className="truncate text-muted-foreground">
                        @ {pageAttribution(a.browser)}
                      </span>
                    )}
                    {a.comment && (
                      <span className="truncate text-muted-foreground">· {a.comment}</span>
                    )}
                    <button
                      type="button"
                      className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background"
                      aria-label={t("chat.anchors.removeAria")}
                      onClick={() => onRemoveAnchor?.(a.id)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    className="group/att relative flex max-w-[220px] items-center gap-2 rounded-md border bg-muted/40 py-1 pl-1 pr-6"
                    key={a.id}
                    title={a.name}
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="h-9 w-9 shrink-0 cursor-pointer rounded object-cover"
                      title={t("chat.composer.imageClickToZoom", {
                        name: a.name || t("chat.composer.imageFallbackName"),
                      })}
                      onClick={() =>
                        setZoomed({
                          items: attachments.map((g) => ({
                            src: g.dataUrl,
                            alt: g.name || t("chat.composer.imageFallbackName"),
                            name: g.name || undefined,
                          })),
                          index: attachments.indexOf(a),
                        })
                      }
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-xs text-foreground" title={a.name}>
                        {a.name || t("chat.composer.imageFallbackName")}
                      </span>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {formatBytes(a.size)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label={t("chat.composer.removeImageAria", { name: a.name })}
                      onClick={() => removeAttachment(a.id)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {attachments.length > 0 && !activeSupportsVision && (
              <div className="mb-2 flex flex-col gap-1 rounded-md bg-status-warn/10 p-2 text-xs text-status-warn">
                <strong>{t("chat.composer.visionUnsupportedTitle")}</strong>
                <span>
                  {activeModel
                    ? t("chat.composer.visionUnsupportedWithModel", { label: activeModel.label })
                    : t("chat.composer.visionUnsupportedUnknown")}
                </span>
                <button
                  type="button"
                  className="self-start underline"
                  onClick={() => {
                    setAttachments([]);
                    setAttachmentError(null);
                  }}
                >
                  {t("chat.composer.removeAllImages")}
                </button>
              </div>
            )}
            {attachmentError && (
              <div className="mb-2 text-xs text-status-err">{attachmentError}</div>
            )}

            <div className="relative">
              {mention && (
                <MentionPopover
                  cwd={activeProjectPath}
                  query={mention.query}
                  selected={mentionSelected}
                  onPick={applyMentionPick}
                  onItemsChange={(items) => {
                    setMentionItems(items);
                    // Clamp selection if the list shrank under us.
                    setMentionSelected((s) =>
                      items.length === 0 ? 0 : Math.min(s, items.length - 1),
                    );
                  }}
                />
              )}
              {slash && (
                <div
                  className="cs-popup-surface absolute bottom-full left-0 z-50 mb-2 max-h-[min(18rem,calc(100vh-120px))] w-80 max-w-[min(20rem,calc(100vw-24px))] overflow-y-auto rounded-md p-1"
                  role="listbox"
                  aria-label={t("chat.slash.ariaLabel")}
                >
                  <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("chat.slash.commands")}
                  </div>
                  {slashItems.length > 0 ? (
                    <ul className="space-y-0.5">
                      {slashItems.map((item, idx) => {
                        const active = idx === slashSelected;
                        return (
                          <li
                            key={item.name}
                            className={cn(
                              "grid cursor-pointer grid-cols-[auto_1fr] gap-x-2 rounded-md px-2 py-1.5 text-sm",
                              active && "bg-accent text-accent-foreground",
                            )}
                            role="option"
                            aria-selected={active}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              executeSlashCommand(item);
                            }}
                          >
                            <Archive size={14} className="mt-0.5 text-muted-foreground" />
                            <span className="min-w-0 truncate font-medium">{item.name}</span>
                            <span className="col-start-2 min-w-0 truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      {t("chat.slash.noMatch")}
                    </div>
                  )}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  const value = e.target.value;
                  setDraft(value);
                  if (historyCursor !== -1) setHistoryCursor(-1);
                  const caret = e.target.selectionStart ?? value.length;
                  updateInlinePickers(value, caret);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={(e) => {
                  // Arrow / click moves can shift the caret without changing
                  // text; re-detect so the popover follows the caret.
                  if (
                    e.key === "ArrowLeft" ||
                    e.key === "ArrowRight" ||
                    e.key === "Home" ||
                    e.key === "End"
                  ) {
                    const ta = e.currentTarget;
                    const caret = ta.selectionStart ?? ta.value.length;
                    updateInlinePickers(ta.value, caret);
                  }
                }}
                onClick={(e) => {
                  const ta = e.currentTarget;
                  const caret = ta.selectionStart ?? ta.value.length;
                  updateInlinePickers(ta.value, caret);
                }}
                onBlur={() => {
                  // Delay so a mousedown pick on the popover still resolves.
                  setTimeout(() => {
                    closeMention();
                    closeSlash();
                  }, 120);
                }}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                onPaste={(e) => void handlePaste(e)}
                placeholder={placeholder}
                disabled={inputDisabled}
                rows={1}
                className="max-h-[200px] min-h-[36px] w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"
              />
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (e.target) e.target.value = "";
                void acceptFiles(files, "picker");
              }}
            />

            {runningAgents > 0 && (
              // Codex-style low-contrast status line: muted grey text, the small
              // pulsing dot keeps the running color so it still reads as "active"
              // without the whole line looking like a blue link (TODO 2.7).
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-running" />
                <span>{t("chat.composer.runningAgents", { count: runningAgents })}</span>
              </div>
            )}
            {compacting && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                <span>{t("chat.composer.compacting")}</span>
              </div>
            )}

            <div className="@container/composer-controls mt-1 min-h-8 w-full min-w-0">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {variant !== "pet" && (
                    <button
                      type="button"
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      aria-label={t("chat.composer.addImage")}
                      title={
                        activeSupportsVision
                          ? t("chat.composer.addImageTitle")
                          : t("chat.composer.addImageDisabledTitle")
                      }
                      onClick={() => fileInputRef.current?.click()}
                      disabled={controlsDisabled}
                    >
                      <Paperclip size={14} />
                    </button>
                  )}
                  {variant !== "pet" && (
                    <PermissionPill
                      value={permissionMode}
                      onChange={onPermissionChange}
                      disabled={controlsDisabled}
                    />
                  )}
                  {variant === "main" && (
                    <GoalToggle
                      enabled={goalEnabled}
                      onToggle={onGoalToggle}
                      disabled={controlsDisabled}
                    />
                  )}
                </div>

                <div className="flex min-w-0 items-center justify-end gap-1.5">
                  {variant === "main" && (
                    <div data-composer-control="context-usage">
                      <ContextRing
                        used={contextTokens}
                        max={contextMax}
                        busy={busy}
                        singleTurnPromptTokens={singleTurnPromptTokens}
                        singleTurnCacheReadTokens={singleTurnCacheReadTokens}
                        singleTurnCacheCreationTokens={singleTurnCacheCreationTokens}
                        cumulativePromptTokens={cumulativePromptTokens}
                        cumulativeCacheReadTokens={cumulativeCacheReadTokens}
                        cumulativeCacheCreationTokens={cumulativeCacheCreationTokens}
                      />
                    </div>
                  )}
                  <ModelPill
                    activeKey={activeModelKey}
                    options={modelOptions}
                    onSelect={onModelChange}
                    disabled={controlsDisabled}
                  />
                  {/* 语音输入(听写):点击录音 → 再点停止 → 转写填进输入框(不自动发)。
                    idle=Mic / recording=红色 Square 脉冲 / transcribing=spinner。 */}
                  <button
                    type="button"
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-md p-1.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                      voiceState === "recording"
                        ? "border border-status-err/60 text-status-err"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-label={t("chat.composer.voiceInput")}
                    title={
                      !sttAvailable && voiceState === "idle"
                        ? t("chat.composer.voiceNoProviderTitle")
                        : voiceState === "recording"
                          ? t("chat.composer.voiceRecording")
                          : voiceState === "transcribing"
                            ? t("chat.composer.voiceTranscribing")
                            : t("chat.composer.voiceInputTitle")
                    }
                    // Don't steal focus from the composer: a plain button click
                    // blurs the textarea, so during record→transcribe the keyboard
                    // can't reach it (the "录音时打不了字" bug). preventDefault on
                    // mousedown keeps focus in the textarea so the user can keep
                    // typing while dictating.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onVoiceClick}
                    // Disabled while transcribing, OR when no provider is configured
                    // (and not mid-recording — never block stopping an active take).
                    disabled={
                      compacting ||
                      voiceState === "transcribing" ||
                      (!sttAvailable && voiceState === "idle")
                    }
                  >
                    {voiceState === "recording" ? (
                      <Square size={14} className="animate-pulse fill-current" />
                    ) : voiceState === "transcribing" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Mic size={14} />
                    )}
                  </button>
                  {busy && draft.trim() && onForceSend && (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        if (attachments.some((img) => !img.path)) {
                          setAttachmentError(t("chat.attachment.missingPath"));
                          return;
                        }
                        const withAnchors = encodeAnchorsForWire(draft.trim(), anchors);
                        const displayPayload = encodeAttachmentsForWire(withAnchors, attachments);
                        const runAttachments = [
                          ...toRunAttachments(attachments),
                          ...inputReferences,
                        ];
                        onForceSend(withAnchors, {
                          ...(sendBucket ? { bucket: sendBucket } : {}),
                          attachments: runAttachments,
                          displayText: displayPayload,
                        });
                        if (draft.trim() && variant === "main") {
                          setHistory(pushHistory(activeProjectId, draft.trim()));
                        }
                        setDraft("");
                        setAttachments([]);
                        setInputReferences([]);
                        setAttachmentError(null);
                        onClearAnchors?.();
                      }}
                      aria-label={t("chat.composer.guideAria")}
                      title={t("chat.composer.guideTitle")}
                    >
                      <CornerDownRight size={13} />
                      {t("chat.composer.guide")}
                    </button>
                  )}
                  {busy && (
                    <button
                      type="button"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-status-err/30 bg-status-err/10 text-status-err transition-all duration-150 hover:border-status-err hover:bg-status-err hover:text-white active:scale-95"
                      onClick={onStop}
                      aria-label={t("chat.composer.stop")}
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  )}
                  {!busy && !compacting && (
                    <button
                      type="button"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary transition-all duration-150 hover:border-primary hover:bg-primary hover:text-primary-foreground active:scale-95 disabled:scale-100 disabled:border-border disabled:bg-muted disabled:text-muted-foreground/50 disabled:opacity-50"
                      onClick={submit}
                      disabled={
                        (!draft.trim() && attachments.length === 0) ||
                        (attachments.length > 0 && !activeSupportsVision)
                      }
                      aria-label={t("chat.composer.send")}
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {queuedInputCount > 0 && queuedInputItems.length === 0 && (
              <div className="mt-1 text-xs text-muted-foreground">
                {t("chat.composer.cachedHint", { count: queuedInputCount })}
              </div>
            )}
          </div>

          {/* Project picker only appears for fresh conversations — once
            the session has any messages, switching project mid-chat
            would be confusing (cwd / context / engine sessionId are
            already tied to the existing project). Use the sidebar to
            jump projects after a session has started. */}
          {isNewChat && variant === "main" && (
            <div className="mt-2 flex items-center gap-2">
              <ProjectPicker
                projects={projects}
                activeProjectId={activeProjectId}
                onSelect={onSelectProject}
                onAddProject={onAddProject}
                disabled={controlsDisabled}
              />
              <span
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
                title={t("chat.localModeTitle")}
              >
                <Monitor size={12} />
                <span>{t("chat.localMode")}</span>
              </span>
              <BranchPicker cwd={activeProjectPath} clean={repoClean} disabled={controlsDisabled} />
            </div>
          )}
        </div>
      </div>
      {zoomed && (
        <Lightbox
          items={zoomed.items}
          index={zoomed.index}
          src={zoomed.items[zoomed.index]?.src ?? ""}
          alt={zoomed.items[zoomed.index]?.alt ?? t("chat.composer.imageFallbackName")}
          name={zoomed.items[zoomed.index]?.name}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
}
