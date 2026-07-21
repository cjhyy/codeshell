import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import type { ContextPackageCreatedOptions } from "./MessageStream";
import { Sidebar } from "./Sidebar";
import { PetPage } from "./pet/PetPage";
import { useOptionalPetState } from "./pet/PetStateProvider";
import { PetWorldPane } from "./pet/PetWorldPane";
import { openPetTarget } from "./pet/petNavigation";
import { PetChatHost } from "./pet/PetChatHost";
import { PetSettingsPage } from "./pet/PetSettingsPage";
import { PetPeekHost } from "./pet/PetPeekHost";
import {
  PET_WIDGET_RECEIPTS_KEY,
  initialPetWidgetReceiptState,
  markPetWidgetCompletionsSeen,
  parsePetWidgetReceiptState,
} from "./pet/petWidgetActivity";
import { TopBar } from "./TopBar";
import dogIcon from "./assets/codeshell-dog-icon.png";
import { summarizeLiveActivity } from "./topbar/liveActivity";
// InspectorPanel removed — tool details now live inline in the chat
// stream's expandable tool cards (no dedicated detail pane).
import { useToast } from "./ui/ToastProvider";
import { useT } from "./i18n/I18nProvider";
import {
  INITIAL_STATE,
  type ActiveGoal,
  type MessagesReducerState,
  type ApprovalState,
  type TaskListMessage,
} from "./types";
import { transcriptsReducer, type TranscriptsMap } from "./transcriptsReducer";
import {
  saveTranscript,
  migrateProjectSessionBucket,
  loadSessionIndex,
  createSession,
  archiveSession,
  loadDeletedArchivedIndices,
  bindEngineSession,
  setActiveSession,
  NO_REPO_KEY,
  bucketKey,
  projectBucketSegment as projectBucketSegmentFor,
  migrateBucketOverride,
  migrateProjectBucketOverrides,
  setSessionWorkspaceProfileLocal,
  type SessionIndex,
} from "./transcripts";
import { resolveAttachmentSessionId } from "./attachmentSession";
import { buildPathAttachment, sha256FromDataUrl, type ImageAttachment } from "./chat/attachments";
import { findAskUserOrigin } from "./streamRouting";
import { statusForBucket, type SessionStatus } from "./sessionStatus";
import { persistDefaultTextModel } from "./modelSelection";
import { writeSettings } from "./settingsBus";
import type { AgentPanelHostRequest, AgentPanelHostResponse } from "../shared/agent-panels";
import type {
  ApprovalRequestEnvelope,
  MobilePermissionMode,
  MobilePermissionModeSnapshotEntry,
  PetOpenSessionRequest,
  PetPeek,
  SummaryForkSessionResult,
} from "../preload/types";
import {
  loadProjects,
  saveProjects,
  loadActiveProjectId,
  saveActiveProjectId,
  makeProjectId,
  isProjectPathRemoved,
  unmarkProjectPathRemoved,
  reconcileProjectsFromDisk,
  reconcileProjectsFromDiskWithRemap,
  projectLabel,
  sortProjects,
  type TrackedProject,
} from "./projects";
import { foldTranscript } from "./automation/foldTranscript";
import { type SerialTaskQueue, type QueuedInputState } from "./queuedInput";
import { loadView, saveView, type ViewState } from "./view";
import { PAGE_REGISTRY } from "./pages/PageRegistry";
import { CommandPalette, buildCommands } from "./shell/CommandPalette";
import { SessionSearchModal } from "./shell/SessionSearchModal";
import { SearchBar } from "./shell/SearchBar";
import { TrustGate } from "./workspace-trust/TrustGate";
import { loadGitPrefs } from "./gitPrefs";
import { createEventCoalescer } from "./streamCoalescer";
import { fromSettingsPermissionMode, type PermissionMode } from "./chat/PermissionPill";
import { copyContextPackageOverrides } from "./contextSelection";
import type { ModelOption } from "./chat/ModelPill";
import { catalogModelOptions, type ModelInstance } from "./settings/textConnections";
import type { QuickChatSessionRef } from "./quickChatSession";
import { resolveAgentPanelHostRequest } from "./panels/AgentPanelHost";
import {
  browserPartitionForBucket,
  EMPTY_ATTACHMENTS,
  parsePanelBucket,
  resolveMainComposerBucket,
  toMobilePermissionMode,
  type ApprovalHistoryEntry,
  type ComposerDraftsMap,
} from "./app/appUtils";
import { useBucketOverrides } from "./app/useBucketOverrides";
import { useTranscriptBuckets } from "./app/useTranscriptBuckets";
import { useAutomationSessionImport } from "./app/useAutomationSessionImport";
import { useSessionNavigation } from "./app/useSessionNavigation";
import { useHostSubscriptions } from "./app/useHostSubscriptions";
import { useRunController } from "./app/useRunController";
import { usePanelBuckets } from "./app/usePanelBuckets";
import { AppMainView, AppShell } from "./app/AppShell";

// Large, low-frequency pages stay off the chat startup path. Each route keeps
// its own visible loading state through the Suspense boundaries below.
const SettingsPage = React.lazy(() =>
  import("./settings/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);
const CredentialsPage = React.lazy(() =>
  import("./credentials/CredentialsPage").then((module) => ({ default: module.CredentialsPage })),
);
const DigitalHumansView = React.lazy(() =>
  import("./digital-humans/DigitalHumansView").then((module) => ({
    default: module.DigitalHumansView,
  })),
);
const ApprovalsView = React.lazy(() =>
  import("./approvals/ApprovalsView").then((module) => ({ default: module.ApprovalsView })),
);
const AutomationView = React.lazy(() =>
  import("./automation/AutomationView").then((module) => ({ default: module.AutomationView })),
);
const SessionPanelDock = React.lazy(() =>
  import("./app/SessionPanelDock").then((module) => ({ default: module.SessionPanelDock })),
);
// Bucket key for sessions without a project — re-exported from transcripts.
// We use NO_REPO_KEY everywhere instead of a local const so the renderer
// and the persistence layer can't drift apart. `bucketKey`/`projectBucketSegment` are
// imported from transcripts (the single source of truth) so App's map build
// can't drift from Sidebar's row lookup.
const GLOBAL_KEY = NO_REPO_KEY;

function PageLoading({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-40 flex-1 items-center justify-center text-sm text-muted-foreground"
      role="status"
    >
      <span className="mr-2 size-3 animate-pulse rounded-full bg-primary/60" aria-hidden />
      {label}
    </div>
  );
}

function App() {
  const toast = useToast();
  const { t, lang } = useT();
  const {
    state: petState,
    dispatch: petDispatch,
    surfaceablePendingCount,
    peeks: petPeeks,
    removePeek,
    longTasks: petLongTasks,
    chatModelKey: petChatModelKey,
    setChatModelKey: setPetChatModelKey,
  } = useOptionalPetState();
  // Pet visibility is process-scoped and mirrored by the desktop host.
  const [petWidgetVisible, setPetWidgetVisible] = useState(false);
  const [transcripts, dispatch] = useReducer(transcriptsReducer, {} as TranscriptsMap);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequestEnvelope[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalHistoryEntry[]>([]);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const [compactingBuckets, setCompactingBuckets] = useState<Set<string>>(() => new Set());
  const compactingBucketsRef = useRef<Set<string>>(new Set());
  const [queuedInputs, setQueuedInputs] = useState<QueuedInputState>({});
  // Buckets mid-引导打断: the turn was cancelled and a merged re-send is about
  // to fire on the next busy=false tick. State (not a ref) so `liveTurnActive`
  // re-renders to stay lit across the cancel→re-send gap — without it busy
  // briefly drops to false and the "正在思考…" indicator blinks off, leaving the
  // user unsure anything is still working (interrupt-relay UX, decision #3).
  const [relayingBuckets, setRelayingBuckets] = useState<Set<string>>(() => new Set());
  // Buckets that finished a turn while the user was viewing a different
  // session. Cleared when the user selects the bucket (handleSelectSession).
  // Not persisted — purely a live "did something finish off-screen" hint.
  const [unreadBuckets, setUnreadBuckets] = useState<Set<string>>(() => new Set());
  const [projects, setProjects] = useState<TrackedProject[]>(() => loadProjects());
  const [sessionWorkspaceProfiles, setSessionWorkspaceProfiles] = useState<
    Array<{ name: string; label: string }>
  >([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() =>
    loadActiveProjectId(),
  );
  const [view, setView] = useState<ViewState>(() => loadView((mode) => PAGE_REGISTRY.has(mode)));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [contextSelectionRequest, setContextSelectionRequest] = useState(0);
  const requestContextSelection = useCallback(
    () => setContextSelectionRequest((request) => request + 1),
    [],
  );
  /** Cmd+P / sidebar 搜索 — cross-project session picker (modal). */
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  // The GLOBAL default model — the choice that seeds *new* sessions. Lives in
  // settings.defaults.text (unified catalog). A per-session switch updates this
  // default too (so the next 新对话 inherits it), but it must NOT retroactively
  // drag existing sessions onto a different model — that's what `modelOverrides`
  // is for.
  const [defaultActiveModelKey, setDefaultActiveModelKey] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode | null>(null);
  // Provider-agnostic image clarity (low/standard/high) from merged settings;
  // drives renderer-side downscale before send. Undefined = follow default.
  const [imageDetail, setImageDetail] = useState<"low" | "standard" | "high" | undefined>(
    undefined,
  );
  const {
    permissionOverrides,
    setPermissionOverrides,
    modelOverrides,
    setModelOverrides,
    goalOverrides,
    setGoalOverrides,
  } = useBucketOverrides();
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  /** Transient: a run to pre-select when jumping into the runs view (e.g. from
   *  the 自动化 detail's 「查看最近运行」 button). Not persisted in view state. */
  const [runsInitialRunId, setRunsInitialRunId] = useState<string | null>(null);

  // Session indices per repo (keyed by projectBucketSegment).
  const [sessionIndices, setSessionIndices] = useState<Record<string, SessionIndex>>(() => {
    const out: Record<string, SessionIndex> = {};
    const liveProjects = loadProjects();
    for (const project of liveProjects) out[project.id] = loadSessionIndex(project.id);
    out[GLOBAL_KEY] = loadSessionIndex(null);
    // Re-surface deleted projects' all-archived indices so 设置→高级→已归档
    // still lists them (under their original name) after a restart — App only
    // seeds from live projects above, which a removed project is no longer in.
    Object.assign(
      out,
      loadDeletedArchivedIndices(new Set(liveProjects.map((project) => project.id))),
    );
    return out;
  });
  const archivedPetSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const index of Object.values(sessionIndices)) {
      for (const session of index.sessions) {
        if (session.archived) ids.add(session.engineSessionId ?? session.id);
      }
    }
    return ids;
  }, [sessionIndices]);

  /**
   * Create a fresh session on demand (lazy: only when the user actually
   * sends a message). A null `activeSessionId` means "draft state" —
   * chat surface shows the welcome, sidebar shows no row, no empty
   * stub clutters the session list. Caller-owned setState so the new
   * id can be threaded into a follow-up `touchSession` without two
   * back-to-back setSessionIndices calls clobbering each other.
   */
  const ensureActiveSession = (projectId: string | null): string => {
    const active = loadSessionIndex(projectId).activeSessionId;
    if (active) return active;
    const { sessionId } = createSession(projectId);
    return sessionId;
  };

  const activeProjectBucketSegment = projectBucketSegmentFor(activeProjectId);
  const activeSessionId = sessionIndices[activeProjectBucketSegment]?.activeSessionId ?? null;
  const activeBucket = bucketKey(activeProjectId, activeSessionId);
  const permissionMode = permissionOverrides[activeBucket] ?? defaultPermissionMode;
  // The model shown/used for the ACTIVE session: its own override if it has
  // one, else the global default. Drafts share the per-repo "_none_" bucket.
  const activeModelKey = modelOverrides[activeBucket] ?? defaultActiveModelKey;
  const goalEnabled = goalOverrides[activeBucket] ?? false;
  const busy = busyKeys.has(activeBucket);
  const compacting = compactingBuckets.has(activeBucket);
  const platform = typeof window !== "undefined" ? window.codeshell?.platform : undefined;
  const isMac =
    platform === "darwin" ||
    (!platform && typeof navigator !== "undefined" && /Mac/.test(navigator.platform));
  const [composerDrafts, setComposerDrafts] = useState<ComposerDraftsMap>({});
  const [quickChatSessions, setQuickChatSessions] = useState<Record<string, QuickChatSessionRef>>(
    {},
  );
  const [quickChatDrafts, setQuickChatDrafts] = useState<Record<string, string>>({});
  const [quickChatAttachments, setQuickChatAttachments] = useState<
    Record<string, ImageAttachment[]>
  >({});
  const quickChatSessionsRef = useRef<Record<string, QuickChatSessionRef>>({});
  const activeBucketRef = useRef(activeBucket);
  activeBucketRef.current = activeBucket;
  quickChatSessionsRef.current = quickChatSessions;
  useEffect(() => {
    if (!activeSessionId) return;
    window.codeshell.registerBrowserSessionBucket({
      sessionId: activeSessionId,
      bucket: activeBucket,
      partition: browserPartitionForBucket(activeBucket),
    });
  }, [activeBucket, activeSessionId]);
  const composerDraft = composerDrafts[activeBucket] ?? {
    text: "",
    attachments: EMPTY_ATTACHMENTS,
  };
  const setComposerDraftText: React.Dispatch<React.SetStateAction<string>> = (next) => {
    setComposerDrafts((prev) => {
      const targetBucket = activeBucketRef.current;
      const current = prev[targetBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const text = typeof next === "function" ? next(current.text) : next;
      if (text === current.text) return prev;
      return { ...prev, [targetBucket]: { ...current, text } };
    });
  };
  const setComposerDraftAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>> = (
    next,
  ) => {
    setComposerDrafts((prev) => {
      const targetBucket = activeBucketRef.current;
      const current = prev[targetBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const attachments = typeof next === "function" ? next(current.attachments) : next;
      if (attachments === current.attachments) return prev;
      return { ...prev, [targetBucket]: { ...current, attachments } };
    });
  };
  // Attach an on-disk image to the composer by absolute path (file-panel add —
  // TODO 2.1). The staged attachment keeps the real path as its name so the
  // chip shows it and the wire payload carries it. Reads bytes via IPC.
  const attachImageByPath = async (absPath: string): Promise<void> => {
    const dataUrl = await window.codeshell.readImageDataUrl(absPath, {
      cwd: activeProject?.path ?? undefined,
    });
    if (!dataUrl) {
      window.codeshell.log("attach.path.not_image", { path: absPath });
      return;
    }
    const context = prepareAttachmentSession();
    const sha256 = await sha256FromDataUrl(dataUrl).catch(() => undefined);
    const modelPath = context ? pathForModel(absPath, context.cwd) : absPath;
    setComposerDraftAttachments((cur) => {
      const { attachment } = buildPathAttachment(absPath, dataUrl, cur, {
        path: modelPath,
        relPath: modelPath === absPath ? undefined : modelPath,
        absPath,
        sha256,
        origin: "file-panel",
        sessionId: context?.sessionId,
      });
      return attachment ? [...cur, attachment] : cur;
    });
  };
  /**
   * Most-recently-started run's bucket. Soft fallback only — the
   * authoritative per-session routing is engineToBucketRef. We keep this
   * around for the brief window between sending agent/run and receiving
   * the first stream event back (envelopes during that window may carry
   * an empty sessionId for very legacy engines).
   */
  const runningBucketRef = useRef<string | null>(null);
  // Steer entry ids already handed to the engine (so the busy auto-steer effect
  // sends each queued draft exactly once even though it re-fires on every queue
  // change). The item stays VISIBLE in the panel until the engine's
  // steer_injected event confirms it — only then is it removed and shown as a
  // user bubble (insert-time and display-time are decoupled). Cleared per id on
  // confirmation / removal so the set can't grow unbounded.
  const steeredIdsRef = useRef<Set<string>>(new Set());
  // Queued ids already confirmed by steer_injected. React state updates can race
  // with the auto-steer effect's closed-over queuedInputs; keep a ref tombstone
  // so a confirmed draft is never sent again even if an old queue snapshot renders.
  const injectedSteerIdsRef = useRef<Set<string>>(new Set());
  // Monotonic fallback counter for queued-draft ids when crypto.randomUUID is
  // unavailable (older webview). crypto path is the norm.
  const queuedSeqRef = useRef<number>(0);
  // Compatibility path for old main/preload builds that announced a mobile
  // turn without a generated clientMessageId.
  const mobileAnnounceSeqRef = useRef<number>(0);
  const downgradeRunQueueRef = useRef<SerialTaskQueue>({ tail: Promise.resolve() });
  /**
   * Per-bucket timestamp of when the current turn went busy, so a manual Stop
   * can show "你在 Ns 后停止了" (TODO 2.8). Set when busy flips true, read+cleared
   * on stop / when busy flips false.
   */
  const busySinceRef = useRef<Map<string, number>>(new Map());
  /**
   * Engine sessionId → UI bucket. Populated when send() fires (we use the
   * UI sessionId directly as the engine sessionId — see notes in send())
   * and reinforced when session_started arrives. This is what makes
   * concurrent runs route to the correct tab.
   */
  const engineToBucketRef = useRef<Map<string, string>>(new Map());
  const approvalBucketsRef = useRef<Map<string, string>>(new Map());
  // Live mirror of transcripts so long-lived event listeners (onApprovalResolved,
  // which is registered once with a [toast]-only dep) can find an ask_user card
  // by requestId without capturing a stale transcripts snapshot.
  const transcriptsRef = useRef(transcripts);
  /** Latest local Goal mutation per session bucket. Prevents a slower failed
   *  edit from rolling back a newer pause/edit/delete without letting an
   *  operation in another tab suppress this bucket's reconciliation. */
  const goalMutationSeqRef = useRef<Map<string, number>>(new Map());
  /**
   * The no-repo sandbox cwd (~/.code-shell/no-repo), fetched once from main.
   * A no-repo "纯聊天" send must pass THIS explicitly as cwd — if we omit cwd,
   * the long-lived worker (reused across projects) defaults to whatever project
   * first spawned it, silently running the chat against an unrelated repo AND
   * defeating the no-repo skill/plugin whitelist (which keys on cwd===noRepoDir).
   */
  const noRepoCwdRef = useRef<string | null>(null);
  /**
   * Mirror of `sessionIndices` for the mount-time stream listener (which
   * closes over stale state). Lets resolveBucket reverse-look-up an engine
   * sessionId in the on-disk indices when the in-memory route table missed —
   * the recovery path after a renderer remount.
   */
  const sessionIndicesRef = useRef(sessionIndices);
  /** Per-bucket event coalescers — buffer rapid text_delta / tool_use_args_delta. */
  const coalescersRef = useRef<Map<string, ReturnType<typeof createEventCoalescer>>>(new Map());
  /** Max snapshot seq currently buffered inside each bucket's coalescer window. */
  const coalescerSeqRef = useRef<Map<string, number>>(new Map());
  const permissionModeRef = useRef<PermissionMode | null>(permissionMode);
  /**
   * Per-bucket permission resolver for the mount-time approval listener
   * (which closes over stale state). Mirrors the same precedence as
   * `permissionMode`: a bucket's explicit override, else the global
   * default. Used to honor 完全访问权限 (bypass) by auto-approving requests
   * that still reach the renderer.
   */
  const permissionForBucketRef = useRef<(bucket: string) => PermissionMode | null>(() => null);
  const defaultPermissionModeRef = useRef<PermissionMode | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!activeProject?.path) {
      setSessionWorkspaceProfiles([]);
      return;
    }
    const listProfiles = window.codeshell.listProfiles;
    if (typeof listProfiles !== "function") {
      setSessionWorkspaceProfiles([]);
      return;
    }
    void listProfiles(activeProject.path)
      .then((profiles) => {
        if (cancelled) return;
        setSessionWorkspaceProfiles(
          profiles.map((profile) => ({ name: profile.name, label: profile.label })),
        );
      })
      .catch(() => {
        if (!cancelled) setSessionWorkspaceProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path, view.viewMode]);

  // A persisted project-config route can outlive a removed project. Fail back
  // to chat instead of leaving a full-page overlay with no project to render.
  useEffect(() => {
    if (view.viewMode !== "project_config" || activeProject) return;
    setView((current) => ({ ...current, viewMode: "chat" }));
  }, [activeProject, view.viewMode]);

  useEffect(() => {
    let alive = true;
    const applyPanels = async (
      panels: Awaited<ReturnType<typeof window.codeshell.listPluginPanels>>,
    ) => {
      const { replacePluginPanels } = await import("./panels/PanelRegistry");
      if (alive) replacePluginPanels(panels);
    };
    const compatibilityApi = window.codeshell as typeof window.codeshell & {
      listPluginPanels?: typeof window.codeshell.listPluginPanels;
      onPluginPanelsChanged?: typeof window.codeshell.onPluginPanelsChanged;
    };
    const listPanels = compatibilityApi.listPluginPanels;
    const subscribePanels = compatibilityApi.onPluginPanelsChanged;
    if (!listPanels || !subscribePanels) {
      void applyPanels([]);
      return;
    }
    const refresh = () => {
      void listPanels(activeProject?.path ?? "", lang)
        .then((panels) => {
          void applyPanels(panels);
        })
        .catch(() => {
          void applyPanels([]);
        });
    };
    refresh();
    const unsubscribe = subscribePanels(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [activeProject?.path, lang]);

  function prepareAttachmentSession(): { cwd: string; sessionId: string } | null {
    const cwd = activeProject?.path ?? noRepoCwdRef.current;
    if (!cwd) return null;
    if (activeSessionId) {
      const sessionId = resolveAttachmentSessionId(
        activeSessionId,
        sessionIndices[activeProjectBucketSegment]?.sessions ?? [],
      );
      if (sessionId) return { cwd, sessionId };
    }

    const projectId = activeProjectId;
    const draftBucket = bucketKey(projectId, null);
    const { index, sessionId } = createSession(projectId);
    const nextBucket = bucketKey(projectId, sessionId);
    activeBucketRef.current = nextBucket;
    setSessionIndices((prev) => ({ ...prev, [projectBucketSegmentFor(projectId)]: index }));
    setComposerDrafts((prev) => {
      const current = prev[draftBucket];
      if (!current) return prev;
      const { [draftBucket]: _drop, ...rest } = prev;
      return { ...rest, [nextBucket]: current };
    });
    setPermissionOverrides((prev) => migrateBucketOverride(prev, draftBucket, nextBucket));
    setGoalOverrides((prev) => migrateBucketOverride(prev, draftBucket, nextBucket));
    setModelOverrides((prev) => migrateBucketOverride(prev, draftBucket, nextBucket));
    return { cwd, sessionId };
  }

  function pathForModel(absPath: string, cwd: string): string {
    const normalizedPath = absPath.replace(/\\/g, "/");
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedPath === normalizedCwd) return ".";
    if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
      return normalizedPath.slice(normalizedCwd.length + 1);
    }
    return absPath;
  }

  const [activeGitMeta, setActiveGitMeta] = useState<{
    branch: string | null;
    clean: boolean | null;
  }>({ branch: null, clean: null });

  /**
   * Per-session sidebar status, keyed by the SAME bucketKey() the Sidebar
   * derives per row (projectBucketSegment::uiSessionId). Priority asking > running > unread.
   *
   * - asking: a pending approval / ask_user envelope is queued for this bucket.
   *   The envelope carries an ENGINE sessionId, so we map it through the exact
   *   same resolveBucket() machinery stream events use (live route table → disk
   *   index reverse-lookup → runningBucket hint). Falls back to activeBucket so
   *   an unattributable approval at least lights up the bucket the user sees.
   * - running: bucket is in busyKeys.
   * - unread: bucket finished a turn off-screen.
   *
   * Iterates every known session across all repo indices so the keys here line
   * up 1:1 with the rows Sidebar renders. NOTE: bucketKey()/projectBucketSegmentFor() must
   * stay byte-identical to Sidebar's per-row key derivation (see Sidebar.tsx).
   */
  const sessionStatusMap = useMemo<Record<string, SessionStatus>>(() => {
    // Build the engineSessionId → bucket reverse index ONCE (O(total-sessions))
    // instead of letting resolveBucket re-scan every repo index per approval.
    // This mirrors resolveBucket's lookup precedence exactly — live route table
    // first, then this reverse index, then the runningBucket hint — but pays the
    // expensive scan a single time. (When the live table is cold after an
    // HMR/remount, every approval would otherwise hit the full reverse scan →
    // O(approvals × total-sessions).)
    const engineToBucketIndex = new Map<string, string>();
    const map: Record<string, SessionStatus> = {};
    for (const [projectBucketSegment, index] of Object.entries(sessionIndices)) {
      const projectId = projectBucketSegment === GLOBAL_KEY ? null : projectBucketSegment;
      for (const s of index.sessions) {
        if (s.engineSessionId && !engineToBucketIndex.has(s.engineSessionId)) {
          engineToBucketIndex.set(s.engineSessionId, bucketKey(projectId, s.id));
        }
      }
    }

    const asking = new Set<string>();
    for (const env of approvalQueue) {
      const routedBucket = approvalBucketsRef.current.get(env.requestId);
      if (routedBucket) {
        asking.add(routedBucket);
        continue;
      }
      const sid = env.sessionId ?? "";
      // Replicate resolveBucket order: live table → precomputed reverse index →
      // runningBucket → activeBucket fallback. Same bucket choice, O(1) per item.
      let bucket: string | null = null;
      if (sid) {
        bucket = engineToBucketRef.current.get(sid) ?? engineToBucketIndex.get(sid) ?? null;
      }
      bucket = bucket ?? runningBucketRef.current ?? activeBucketRef.current;
      if (bucket) asking.add(bucket);
    }

    for (const [projectBucketSegment, index] of Object.entries(sessionIndices)) {
      const projectId = projectBucketSegment === GLOBAL_KEY ? null : projectBucketSegment;
      for (const s of index.sessions) {
        const bucket = bucketKey(projectId, s.id);
        const status = statusForBucket(bucket, asking, busyKeys, unreadBuckets);
        if (status) map[bucket] = status;
      }
    }
    return map;
  }, [approvalQueue, sessionIndices, busyKeys, unreadBuckets]);

  useEffect(() => {
    saveProjects(projects);
  }, [projects]);
  useEffect(() => {
    let cancelled = false;
    void window.codeshell
      ?.isWindowFullscreen?.()
      .then((value) => {
        if (!cancelled) setIsFullscreen(Boolean(value));
      })
      .catch(() => undefined);
    const off = window.codeshell?.onWindowFullscreenChange?.((state) => {
      setIsFullscreen(Boolean(state.fullscreen));
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  // Disk recents are the source of truth for the project SET + pinned/soft-delete.
  // Hydrate from disk on mount and re-project on every change (another window, a
  // phone, or our own add/remove/pin), reconciling against the localStorage cache
  // so each known path keeps its stable projectId (session buckets stay intact).
  useEffect(() => {
    let alive = true;
    const apply = (
      projects: Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>,
    ): void => {
      if (!alive) return;
      setProjects((prev) => reconcileProjectsFromDisk(projects, prev));
    };
    void (async () => {
      // Back-fill: legacy projects live only in the localStorage cache and were
      // never written to disk. Push any cached path missing from disk so disk
      // becomes a complete source of truth (no project silently disappears on
      // the first run after this change). Soft-deleted ones stay deleted because
      // pushRecent un-deletes only on explicit re-add, and we skip removed paths.
      const disk = await window.codeshell.projects.list();
      const onDisk = new Set(disk.map((p) => p.path));
      const cached = loadProjects();
      const normalizedCached = await Promise.all(
        cached.map(async (r) => {
          try {
            const root = await window.codeshell.projects.resolveRoot(r.path);
            return { ...r, path: root.path, name: r.name || root.name };
          } catch {
            return r;
          }
        }),
      );
      const seenMissing = new Set<string>();
      const missing = normalizedCached.filter((r) => {
        if (onDisk.has(r.path) || isProjectPathRemoved(r.path) || seenMissing.has(r.path))
          return false;
        seenMissing.add(r.path);
        return true;
      });
      const latestDisk =
        missing.length > 0
          ? await (async () => {
              for (const r of missing) {
                await window.codeshell.projects.add({ path: r.path, name: r.name });
              }
              return window.codeshell.projects.list();
            })()
          : disk;
      const { projects: reconciled, projectIdRemap } = reconcileProjectsFromDiskWithRemap(
        latestDisk,
        normalizedCached,
      );
      const remapEntries = Object.entries(projectIdRemap);
      const migratedProjectIds = new Set<string>();
      for (const [fromProjectId, toProjectId] of remapEntries) {
        migrateProjectSessionBucket(fromProjectId, toProjectId);
        migratedProjectIds.add(toProjectId);
      }
      if (!alive) return;
      setProjects(reconciled);
      if (remapEntries.length > 0) {
        setActiveProjectId((prev) => (prev && projectIdRemap[prev] ? projectIdRemap[prev] : prev));
        setPermissionOverrides((prev) => migrateProjectBucketOverrides(prev, projectIdRemap));
        setModelOverrides((prev) => migrateProjectBucketOverrides(prev, projectIdRemap));
        setGoalOverrides((prev) => migrateProjectBucketOverrides(prev, projectIdRemap));
        setSessionIndices((prev) => {
          const next = { ...prev };
          for (const [fromProjectId] of remapEntries) delete next[fromProjectId];
          for (const id of migratedProjectIds) next[id] = loadSessionIndex(id);
          return next;
        });
      }
    })();
    const unsub = window.codeshell.projects.onChanged(apply);
    return () => {
      alive = false;
      unsub();
    };
    // Mount-only: the subscription handles all subsequent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void window.codeshell.mobileRemote.updateProjects(
      sortProjects(projects).map((project) => ({
        path: project.path,
        name: projectLabel(project),
        addedAt: project.addedAt,
        pinned: Boolean(project.pinned),
      })),
    );
  }, [projects]);
  useEffect(() => {
    const entries: MobilePermissionModeSnapshotEntry[] = [];
    const seen = new Set<string>();
    const add = (sessionId: string | undefined, mode: MobilePermissionMode): void => {
      if (!sessionId || seen.has(sessionId)) return;
      seen.add(sessionId);
      entries.push({ sessionId, mode });
    };
    for (const [projectBucketSegment, index] of Object.entries(sessionIndices)) {
      const projectId = projectBucketSegment === GLOBAL_KEY ? null : projectBucketSegment;
      for (const s of index.sessions) {
        const bucket = bucketKey(projectId, s.id);
        const mode = toMobilePermissionMode(permissionOverrides[bucket] ?? defaultPermissionMode);
        if (!mode) continue;
        add(s.engineSessionId ?? s.id, mode);
        add(s.id, mode);
      }
    }
    void window.codeshell.mobileRemote
      .updatePermissionModes(entries)
      .catch((err) =>
        window.codeshell.log("mobile.permissionModes.update.failed", { error: String(err) }),
      );
  }, [sessionIndices, permissionOverrides, defaultPermissionMode]);
  useEffect(() => {
    saveActiveProjectId(activeProjectId);
  }, [activeProjectId]);
  useEffect(() => {
    saveView(view);
  }, [view]);
  useEffect(() => {
    activeBucketRef.current = activeBucket;
  }, [activeBucket]);
  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);
  // Fetch the no-repo sandbox cwd once; a no-repo send passes it explicitly.
  useEffect(() => {
    window.codeshell
      .noRepoCwd()
      .then((p) => {
        noRepoCwdRef.current = p;
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    sessionIndicesRef.current = sessionIndices;
  }, [sessionIndices]);
  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);
  useEffect(() => {
    permissionForBucketRef.current = (bucket: string): PermissionMode | null =>
      permissionOverrides[bucket] ?? defaultPermissionMode;
    defaultPermissionModeRef.current = defaultPermissionMode;
  }, [permissionOverrides, defaultPermissionMode]);

  useEffect(() => {
    const refreshSettings = (): void => {
      setSettingsRevision((n) => n + 1);
      // The worker holds its own SettingsManager; without an explicit
      // reload it keeps the bootstrap-time snapshot and ignores any
      // edits the user makes via the settings page. Fire-and-forget;
      // a stale reload is harmless (configure() with no model just
      // refreshes the pool from disk).
      void window.codeshell.configure({ reloadModels: true });
      // Config hot-reload layer 2: also push the disk-default config fields
      // (preset / custom & append system prompt / personalization / mcpServers)
      // + settings hooks onto ALREADY-RUNNING sessions, applied at their next
      // turn boundary. Without this, editing personalization/preset/prompts
      // only affected sessions created AFTER the edit. Worker-global (no
      // sessionId) → every live session; in-flight turns are untouched.
      void window.codeshell.configure({ reloadSettings: true });
    };
    window.addEventListener("codeshell:settings-changed", refreshSettings);
    return () => window.removeEventListener("codeshell:settings-changed", refreshSettings);
  }, []);

  // Push Electron-local Git prefs to main on mount and whenever the
  // user edits them. Main needs branchPrefix as a default for worktree
  // creation and autoDelete settings for the periodic cleanup sweep.
  useEffect(() => {
    const push = (): void => {
      void window.codeshell.setGitPrefs?.(loadGitPrefs());
    };
    push();
    window.addEventListener("codeshell:git-prefs-changed", push);
    return () => window.removeEventListener("codeshell:git-prefs-changed", push);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!activeProject?.path) {
      setActiveGitMeta({ branch: null, clean: null });
      return () => {
        cancelled = true;
      };
    }
    void window.codeshell
      .getGitStatus(activeProject.path)
      .then((status) => {
        if (!cancelled) {
          setActiveGitMeta({
            branch: status.branch,
            clean: status.clean,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setActiveGitMeta({ branch: null, clean: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path, busy]);

  // No auto-create here: a null activeSessionId is the legitimate
  // "draft" state. A real session row only appears after the user
  // actually sends a message (see `send` below).

  const { state, awaitingHydration, appliedSeqRef, setBusyForKey } = useTranscriptBuckets({
    activeProjectId,
    activeSessionId,
    activeBucket,
    activeProjectBucketSegment,
    sessionIndices,
    transcripts,
    dispatch,
    runningBucketRef,
    busySinceRef,
    setBusyKeys,
  });

  // The "正在思考…" live line shows whenever a turn is busy. Normally
  // streamingAssistantId flips it on once stream_request_start arrives; but on
  // the "打断接力" path (stop → re-send queued input) the new turn is busy with
  // its user bubble appended BEFORE stream_request_start, and the killed turn's
  // streaming id was cleared by turn_end. So also light up while busy with the
  // last message being the just-sent user message — closing the gap that left
  // the relayed turn with no thinking indicator. (interrupt-relay fix)
  const lastMessage = state.messages[state.messages.length - 1];
  const liveTurnActive =
    (busy && (state.streamingAssistantId !== null || lastMessage?.kind === "user")) ||
    // 引导打断 gap: turn cancelled, merged re-send pending on the next tick.
    // Keep the indicator lit so the user sees work is still happening. (#3)
    relayingBuckets.has(activeBucket);

  const markViewedPetCompletions = useCallback(
    (sessionId?: string): void => {
      const projection = petState.projection;
      if (!projection) return;
      try {
        const current =
          parsePetWidgetReceiptState(localStorage.getItem(PET_WIDGET_RECEIPTS_KEY)) ??
          initialPetWidgetReceiptState(projection);
        const next = markPetWidgetCompletionsSeen(
          current,
          projection,
          petLongTasks,
          sessionId ? new Set([sessionId]) : undefined,
        );
        if (next !== current) {
          localStorage.setItem(PET_WIDGET_RECEIPTS_KEY, JSON.stringify(next));
        }
      } catch {
        // Receipt sync is best-effort; viewing the Session must still succeed.
      }
    },
    [petLongTasks, petState.projection],
  );

  const handleOpenPetTarget = async (request: PetOpenSessionRequest): Promise<void> => {
    await openPetTarget(window.codeshell.pet, request, {
      select: async (target) => {
        await handleOpenAutomationDiskSession({
          id: target.uiSessionId,
          engineSessionId: target.engineSessionId,
          cwd: target.projectPath ?? "",
          title: target.title,
          updatedAt: target.updatedAt,
          origin: target.origin,
        });
        markViewedPetCompletions(request.agentSessionId);
      },
      onStale: () => toast({ message: t("pet.navigation.stale"), variant: "default" }),
      onNotFound: () => toast({ message: t("pet.navigation.notFound"), variant: "error" }),
    });
  };

  const settlePetPeek = (peek: PetPeek, state: "seen" | "dismissed"): void => {
    removePeek(peek.id);
    void window.codeshell.pet?.markAttentionReceipt?.(peek.receiptKeys, state);
  };

  const handlePetPeekAction = (peek: PetPeek): void => {
    settlePetPeek(peek, "seen");
    if (peek.action.type === "open_session") {
      void handleOpenPetTarget(peek.action.target);
      return;
    }
    petDispatch({ type: "set-overview-focus", focus: "pending" });
    setView((current) => ({
      ...current,
      viewMode: "pet",
      sidebarCollapsed: false,
    }));
  };

  const openPetPage = useCallback((): void => {
    petDispatch({ type: "set-overview-focus", focus: null });
    setView((current) => ({
      ...current,
      viewMode: "pet",
      sidebarCollapsed: false,
    }));
  }, [petDispatch]);

  useEffect(() => {
    let disposed = false;
    const pet = window.codeshell.pet;
    if (!pet) return;
    void pet
      .getWidgetVisibility()
      .then((visible) => {
        if (!disposed) setPetWidgetVisible(visible);
      })
      .catch((error) =>
        window.codeshell.log("pet.widget.visibility.read.failed", { error: String(error) }),
      );
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const pet = window.codeshell.pet;
    if (!pet?.onWidgetOpenOverview) return;
    return pet.onWidgetOpenOverview((target) => {
      if (target) void handleOpenPetTarget(target);
      else openPetPage();
    });
  }, [openPetPage]);

  useEffect(() => {
    const pet = window.codeshell.pet;
    if (!pet?.onWidgetVisibilityChanged) return;
    return pet.onWidgetVisibilityChanged((visible) => {
      setPetWidgetVisible(visible);
    });
  }, []);

  const setPetWidgetVisibility = useCallback((next: boolean): void => {
    const pet = window.codeshell.pet;
    if (!pet) return;
    setPetWidgetVisible(next);
    void pet.setWidgetVisible(next).catch((error) => {
      setPetWidgetVisible((current) => (current === next ? !next : current));
      window.codeshell.log("pet.widget.visibility.failed", { error: String(error) });
    });
  }, []);

  const togglePetWidget = (): void => setPetWidgetVisibility(!petWidgetVisible);

  const { diskSessionCatalog, loadDiskSessionCatalogPage } = useAutomationSessionImport({
    sessionIndicesRef,
    setSessionIndices,
    setProjects,
  });

  useHostSubscriptions({
    services: { toast, t, dispatch },
    routing: {
      coalescersRef,
      coalescerSeqRef,
      appliedSeqRef,
      engineToBucketRef,
      sessionIndicesRef,
      runningBucketRef,
      injectedSteerIdsRef,
      steeredIdsRef,
      activeBucketRef,
      quickChatSessionsRef,
      transcriptsRef,
    },
    permissions: {
      approvalBucketsRef,
      permissionForBucketRef,
      defaultPermissionModeRef,
      setApprovalQueue,
      setApproval,
      setPermissionOverrides,
    },
    sessions: { setQueuedInputs, setUnreadBuckets, setSessionIndices, setProjects },
    activity: { mobileAnnounceSeqRef, setBusyForKey, setLifecycle, setBusyKeys },
  });

  const {
    send,
    sendQuickChat,
    queueInput,
    forceSend,
    clearActiveQueuedInput,
    removeActiveQueuedInputAt,
    guideActiveQueuedInput,
    stop,
    resolveEngineSessionIdForBucket,
    compactActiveSession,
    extendGoal,
    decideEnvelope,
    showWelcome,
    visibleApproval,
    approvalForBucket,
    setViewMode,
  } = useRunController({
    shell: { t, lang, toast, setView },
    session: {
      activeProjectId,
      activeSessionId,
      activeBucket,
      projects,
      sessionIndices,
      setSessionIndices,
      ensureActiveSession,
    },
    preferences: {
      permissionOverrides,
      setPermissionOverrides,
      defaultPermissionMode,
      goalOverrides,
      setGoalOverrides,
      modelOverrides,
      setModelOverrides,
      defaultActiveModelKey,
    },
    runtime: {
      setBusyForKey,
      runningBucketRef,
      engineToBucketRef,
      noRepoCwdRef,
      quickChatSessionsRef,
      queuedInputs,
      setQueuedInputs,
      busy,
      busyKeys,
      relayingBuckets,
      setRelayingBuckets,
      steeredIdsRef,
      injectedSteerIdsRef,
      downgradeRunQueueRef,
      queuedSeqRef,
      busySinceRef,
      compactingBucketsRef,
      setCompactingBuckets,
    },
    transcript: { dispatch, state },
    approvals: {
      approval,
      approvalQueue,
      setApprovalQueue,
      setApproval,
      setApprovalHistory,
      approvalBucketsRef,
    },
  });

  const {
    panelByBucket,
    setPanelByBucket,
    updatePanelBucket,
    onRevealConsumed,
    onOpenCliSessionConsumed,
    ensureQuickChatSession,
    cleanupQuickChatPanelSession,
    restartQuickChatSession,
    setQuickChatDraft,
    setQuickChatAttachmentState,
    setQuickChatPermission,
    setQuickChatModel,
    activePanelState,
    panelBuckets,
    togglePanel,
    openPanel,
    panelWidth,
    beginPanelResize,
    composerSeed,
    composerSeedNonce,
    onComposerSeedConsumed,
    startConversationalAutomation,
    anchors,
    anchorsByBucket,
    removeAnchor,
    updateAnchorComment,
    clearAnchors,
  } = usePanelBuckets({
    sessions: {
      activeBucket,
      activeProjectId,
      activeBucketRef,
      sessionIndices,
      sessionIndicesRef,
      setSessionIndices,
    },
    quickChat: {
      quickChatSessions,
      setQuickChatSessions,
      setQuickChatDrafts,
      setQuickChatAttachments,
      quickChatSessionsRef,
    },
    controls: {
      engineToBucketRef,
      setPermissionOverrides,
      setModelOverrides,
      defaultPermissionMode,
      resolveEngineSessionIdForBucket,
      dispatch,
      approvalBucketsRef,
      setApprovalQueue,
      setApproval,
      setBusyForKey,
    },
    stream: { runningBucketRef, coalescersRef, coalescerSeqRef, appliedSeqRef },
    shell: { toast, t, setViewMode },
  });

  useEffect(() => {
    const compatibilityApi = window.codeshell as typeof window.codeshell & {
      onAgentPanelRequest?: (cb: (request: AgentPanelHostRequest) => void) => () => void;
      respondAgentPanelRequest?: (response: AgentPanelHostResponse) => void;
    };
    if (!compatibilityApi.onAgentPanelRequest || !compatibilityApi.respondAgentPanelRequest) {
      return;
    }
    return compatibilityApi.onAgentPanelRequest((request) => {
      if (request.bucket !== activeBucket && !panelByBucket[request.bucket]) return;
      const { projectId } = parsePanelBucket(request.bucket);
      const cwd = projectId
        ? (projects.find((project) => project.id === projectId)?.path ?? null)
        : noRepoCwdRef.current;
      const response = resolveAgentPanelHostRequest(request, {
        availability: { cwd, engineSessionId: request.sessionId },
        translate: (key) => t(key as never),
        open: (panelId) => {
          updatePanelBucket(request.bucket, (state) => ({
            ...state,
            open: true,
            requestNonce: state.requestNonce + 1,
            requestKind: panelId,
          }));
        },
      });
      compatibilityApi.respondAgentPanelRequest?.(response);
    });
  }, [activeBucket, panelByBucket, projects, t, updatePanelBucket]);

  const {
    handleAddProject,
    handleRemoveProject,
    handleToggleProject,
    handlePinProject,
    handleRenameProject,
    handleArchiveAllSessions,
    handleNewConversationForProject,
    handleNewConversation,
    handleSelectSession,
    handleRenameSession,
    handlePinSession,
    handleArchiveSession,
    handleDeleteSession,
    handleOpenAutomationRunSession,
    handleOpenAutomationDiskSession,
  } = useSessionNavigation({
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
    sessionIndices,
    setSessionIndices,
    setCollapsedProjects,
    setUnreadBuckets,
    setPermissionOverrides,
    setModelOverrides,
    setGoalOverrides,
    panelByBucket,
    setPanelByBucket,
    activeBucketRef,
    setView,
    setRunsInitialRunId,
  });

  const toggleSidebar = (): void =>
    setView((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  // toggleInspector retained as a no-op for menu/palette wiring that
  // still references the action verb but the panel itself is gone.
  const toggleInspector = (): void => undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (view.viewMode === "settings_page" || view.viewMode === "project_config") return;

      const mod = e.metaKey || e.ctrlKey;
      // Is the user typing into an editable field? Panel-switch hotkeys
      // (esp. ⌃` and ⌘⇧E, which produce/consume printable chars) must not
      // fire while typing, or they'd swallow keystrokes. The app-global
      // ⌘K/⌘P/⌘F palette/search keys deliberately still work from inputs.
      const t = e.target as HTMLElement | null;
      const _typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          // xterm's helper textarea / the terminal viewport
          !!t.closest(".xterm"));
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSessionSearchOpen(true);
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key >= "1" && e.key <= "9") {
        // Cmd+N — jump to Nth session under active repo.
        const n = parseInt(e.key, 10) - 1;
        const idx = sessionIndices[projectBucketSegmentFor(activeProjectId)];
        const target = idx?.sessions[n];
        if (target) {
          e.preventDefault();
          handleSelectSession(activeProjectId, target.id);
        }
      } else if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        if (searchOpen) setSearchOpen(false);
        if (sessionSearchOpen) setSessionSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen, searchOpen, sessionSearchOpen, sessionIndices, activeProjectId, view.viewMode]);

  useEffect(() => {
    const off = window.codeshell.onMenuEvent((evt, payload) => {
      switch (evt) {
        case "add-project":
          void handleAddProject();
          break;
        case "open-recent": {
          const p = payload as { path: string; name: string } | undefined;
          if (!p) return;
          unmarkProjectPathRemoved(p.path);
          const existing = projects.find((project) => project.path === p.path);
          if (existing) setActiveProjectId(existing.id);
          else {
            const id = makeProjectId();
            setProjects((prev) => [
              ...prev,
              { id, name: p.name, path: p.path, addedAt: Date.now() },
            ]);
            setActiveProjectId(id);
            setSessionIndices((prev) => ({ ...prev, [id]: loadSessionIndex(id) }));
          }
          break;
        }
        case "find":
          setSearchOpen(true);
          break;
        case "palette":
          setPaletteOpen(true);
          break;
        case "toggle-sidebar":
          toggleSidebar();
          break;
        case "toggle-inspector":
          // no-op: inspector panel removed
          break;
        case "new-window":
          void window.codeshell.newWindow();
          break;
      }
    });
    return off;
  }, [projects]);

  // Refresh model list + active selection + permission from settings.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const cwd = activeProject?.path;
        const projectS = cwd ? ((await window.codeshell.getSettings("project", cwd)) ?? {}) : {};
        const userS = (await window.codeshell.getSettings("user")) ?? {};
        const merged: Record<string, unknown> = { ...userS, ...projectS };
        // Unified catalog (统一模型接入方案 §6): the composer picker lists text
        // `modelConnections` resolved through the catalog — the same store the
        // engine pool keys by instance id. The active selection is
        // `defaults.text` (engine priority #1), with legacy activeKey/model.name
        // as fallback for un-migrated configs.
        const catalog = await window.codeshell.getModelCatalog().catch(() => []);
        if (cancelled) return;
        setDefaultActiveModelKey(resolveActiveKey(merged));
        const permissions =
          merged.permissions && typeof merged.permissions === "object"
            ? (merged.permissions as Record<string, unknown>)
            : {};
        setDefaultPermissionMode(
          fromSettingsPermissionMode(merged.permissionMode ?? permissions.defaultMode),
        );
        // Image clarity: migrate legacy "original" → "high"; anything else
        // unrecognized → undefined (follow default, no downscale).
        const rawDetail = (merged.images as { detail?: string } | undefined)?.detail;
        const d = rawDetail === "original" ? "high" : rawDetail;
        setImageDetail(d === "low" || d === "standard" || d === "high" ? d : undefined);
        const conns = Array.isArray(merged.modelConnections)
          ? (merged.modelConnections as ModelInstance[])
          : [];
        const baseOpts = catalogModelOptions(conns, catalog);
        setModelOptions(baseOpts);

        // Backfill maxContextTokens/supportsVision for connections whose
        // catalog preset omitted them (e.g. OpenRouter dynamic models). Resolve
        // via the main-process model-meta-service (OpenRouter API → hardcoded
        // table → fallback), keyed by the connection's model id. Out-of-band so
        // the initial render doesn't wait on the network; the preset always wins.
        const needsMeta = baseOpts.some(
          (o) => o.maxContextTokens === undefined || o.supportsVision === undefined,
        );
        if (needsMeta) {
          const metaInput = conns
            .filter((c) => c.tag === "text")
            .map((c) => ({ key: c.id, model: c.model }));
          const meta = await window.codeshell.resolveModelMeta(metaInput, []);
          if (cancelled) return;
          const byKey = new Map(meta.map((m) => [m.key, m]));
          setModelOptions((prev) =>
            prev.map((o) => {
              const r = byKey.get(o.key);
              if (!r) return o;
              return {
                ...o,
                maxContextTokens: o.maxContextTokens ?? r.maxContextTokens,
                supportsVision: o.supportsVision ?? r.supportsVision,
              };
            }),
          );
        }
      } catch {
        // ignore
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [activeProject, view.viewMode, settingsRevision]);

  useEffect(() => {
    void window.codeshell.setBadgeCount(approvalQueue.length);
  }, [approvalQueue.length]);

  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (prevBusyRef.current && !busy && document.hidden) {
      void window.codeshell.notify({
        title: "code-shell",
        body: activeProject
          ? t("misc.app.notifyDone", { name: activeProject.name })
          : t("misc.app.notifyAgentDone"),
      });
    }
    prevBusyRef.current = busy;
  }, [busy, activeProject]);

  const handleAskUserAnswer = (requestId: string, answer: string): void => {
    // Route the answer to the session that ORIGINATED the prompt. The prompt
    // message carries engineSessionId (stamped at dispatch from env.sessionId),
    // so we no longer assume "AskUser is always in the active bucket" — that
    // misrouted answers when the prompt belonged to a background session (cold
    // route table after a remount). Find the message by requestId to recover it.
    const origin = findAskUserOrigin(transcripts, requestId);
    const originEngineSessionId = origin?.engineSessionId;
    const originBucket = origin?.bucket;
    // Fallback (legacy prompts with no stamped sessionId): derive from the
    // active bucket, preserving the previous behavior.
    let engineSessionId = originEngineSessionId;
    if (!engineSessionId) {
      const sep = activeBucket.indexOf("::");
      const uiSessionId = sep > 0 ? activeBucket.slice(sep + 2) : null;
      const projectBucketSegment = sep > 0 ? activeBucket.slice(0, sep) : null;
      const summary =
        uiSessionId && uiSessionId !== "_none_"
          ? sessionIndices[projectBucketSegment ?? GLOBAL_KEY]?.sessions.find(
              (s) => s.id === uiSessionId,
            )
          : undefined;
      engineSessionId = summary?.engineSessionId ?? uiSessionId ?? undefined;
    }
    if (engineSessionId) {
      void window.codeshell.approve(engineSessionId, requestId, "approve", undefined, answer);
    } else {
      void window.codeshell.approve(requestId, "approve", undefined, answer);
    }
    void window.codeshell.mobileRemote.notifyApprovalResolved({
      requestId,
      sessionId: engineSessionId,
      approved: true,
    });
    dispatch({
      type: "ask_user_answered",
      // Mark answered in the bucket that actually holds the prompt (found above),
      // not blindly the active bucket — they differ for a background-session ask.
      bucket: originBucket ?? activeBucket,
      requestId,
      answer,
    });
  };

  const clearTranscript = (): void => {
    dispatch({ type: "hydrate", bucket: activeBucket, state: INITIAL_STATE });
  };

  const onPermissionChange = (m: PermissionMode): void => {
    setPermissionOverrides((prev) => {
      if (m === defaultPermissionMode) {
        const { [activeBucket]: _removed, ...rest } = prev;
        return rest;
      }
      return {
        ...prev,
        [activeBucket]: m,
      };
    });
  };

  const onGoalToggle = (next: boolean): void => {
    setGoalOverrides((prev) => ({ ...prev, [activeBucket]: next }));
    // Convenience coupling (one-shot): enabling Goal defaults the permission
    // pill to 完全访问 so the agent isn't interrupted mid-goal. Only applied
    // when this bucket has no explicit override yet — the user can still
    // dial it back afterward, and we never override a deliberate choice.
    if (next && permissionOverrides[activeBucket] === undefined) {
      setPermissionOverrides((prev) => ({ ...prev, [activeBucket]: "bypass" }));
    }
  };

  const onModelChange = (opt: ModelOption): void => {
    // 1) Pin the choice to THIS session's bucket. The pill reads
    //    `modelOverrides[activeBucket] ?? defaultActiveModelKey`, so this is
    //    what makes the switch local — other sessions keep their own model.
    setModelOverrides((prev) => ({ ...prev, [activeBucket]: opt.key }));
    // Clear only the single-turn cache metric. Whole-session cumulative
    // counters are monotonic from session start and must not reset here.
    dispatch({
      type: "stream",
      bucket: activeBucket,
      event: {
        type: "usage_update",
        promptTokens: state.promptTokens,
        singleTurnPromptTokens: 0,
        singleTurnCacheReadTokens: 0,
        singleTurnCacheCreationTokens: 0,
      } as StreamEvent,
    });
    // 2) Also adopt it as the global default so the NEXT 新对话 inherits it
    //    (user-chosen semantics). This only seeds future sessions; it never
    //    rewrites another bucket's existing override above.
    setDefaultActiveModelKey(opt.key);
    void persistDefaultTextModel({
      key: opt.key,
      getSettings: window.codeshell.getSettings,
      writeSettings,
    });
    // 3) Hot-switch the running worker. Scope it to THIS session's engine so
    //    we don't swap the model under any OTHER live session. The backend
    //    (server.ts handleConfigure) routes a sessionId'd configure to
    //    ChatSession.requestModelSwitch (applies when idle, defers past a
    //    running turn). For a draft (no engine session bound yet) there's
    //    nothing live to notify — the model rides along via send()'s opts.
    const engineId = engineSessionIdForActive();
    if (engineId) {
      void window.codeshell.configure({ sessionId: engineId, model: opt.key });
    }
  };

  /**
   * Engine sessionId of the currently-active UI session, or null for a draft
   * (or a session that hasn't bound an engine id yet). Mirrors the lookup in
   * send()/resume — engineSessionId falls back to the UI session id, which is
   * the new normal (UI sessionId == engine sessionId).
   */
  const engineSessionIdForActive = (): string | null => {
    if (!activeSessionId) return null;
    const summary = sessionIndices[activeProjectBucketSegment]?.sessions.find(
      (s) => s.id === activeSessionId,
    );
    return summary?.engineSessionId ?? activeSessionId;
  };

  useEffect(() => {
    void window.codeshell.pet?.setActiveSession?.(engineSessionIdForActive());
  }, [activeSessionId, activeProjectBucketSegment, sessionIndices]);

  const matchCount = useMemo(() => {
    if (!searchQuery) return 0;
    const q = searchQuery.toLowerCase();
    return state.messages.reduce((n, m) => {
      const text =
        m.kind === "user" || m.kind === "assistant" || m.kind === "thinking" || m.kind === "system"
          ? m.text
          : "";
      if (!text) return n;
      let count = 0;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        count++;
        idx = lower.indexOf(q, idx + q.length);
      }
      return n + count;
    }, 0);
  }, [state.messages, searchQuery]);

  const activeSessionSummary = (() => {
    const idx = sessionIndices[activeProjectBucketSegment];
    return idx?.sessions.find((session) => session.id === activeSessionId) ?? null;
  })();
  const sessionTitleForTop = activeSessionSummary?.title ?? null;

  const handleSessionWorkspaceProfileChange = useCallback(
    async (profileName: string): Promise<void> => {
      if (!activeProjectId || !activeSessionSummary || busy) return;
      const previousProfile = activeSessionSummary.workspaceProfile;
      if (previousProfile === profileName) return;
      const next = setSessionWorkspaceProfileLocal(
        activeProjectId,
        activeSessionSummary.id,
        profileName,
      );
      setSessionIndices((current) => ({
        ...current,
        [activeProjectBucketSegment]: next,
      }));
      try {
        await window.codeshell.setSessionWorkspaceProfile(
          activeSessionSummary.engineSessionId ?? activeSessionSummary.id,
          profileName,
        );
        const label =
          sessionWorkspaceProfiles.find((profile) => profile.name === profileName)?.label ??
          profileName;
        toast({ message: t("digitalHumans.sessionBinding.switched", { name: label }) });
      } catch (error) {
        const rolledBack = setSessionWorkspaceProfileLocal(
          activeProjectId,
          activeSessionSummary.id,
          previousProfile,
        );
        setSessionIndices((current) => ({
          ...current,
          [activeProjectBucketSegment]: rolledBack,
        }));
        toast({
          message: t("digitalHumans.sessionBinding.failed", {
            message: error instanceof Error ? error.message : String(error),
          }),
          variant: "error",
        });
      }
    },
    [
      activeProjectBucketSegment,
      activeProjectId,
      activeSessionSummary,
      busy,
      sessionWorkspaceProfiles,
      t,
      toast,
    ],
  );

  // Live-activity summary for the TopBar status popover. Recomputed
  // whenever messages change — cheap (single pass from the most
  // recent user message), no allocations beyond the returned object.
  const liveActivity = useMemo(() => summarizeLiveActivity(state.messages), [state.messages]);

  // Count background sub-agents still running in THIS session. When the model
  // spawns with run_in_background, the main run resolves immediately (busy
  // clears, the composer re-enables — by design), but the children keep
  // working. We surface that with a separate "后台 N 个子代理运行中" indicator
  // so the UI doesn't look idle while agents are still in flight. Derived from
  // the reducer's AgentMessage entries (done=false set on agent_start, true on
  // agent_end), so no extra state to track. (perf/ux: bg-agent-busy-2026-06-02)
  const runningAgents = useMemo(
    () =>
      state.messages.reduce((n, m) => (m.kind === "agent" && !m.done && !m.error ? n + 1 : n), 0),
    [state.messages],
  );

  // Latest TaskList snapshot — the engine replaces it in place, so we
  // walk from the tail and take the first one we hit. Feeds the TopBar
  // status popover's task overview.
  const latestTasks = useMemo<TaskListMessage | null>(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i]!;
      if (m.kind === "task_list") return m;
    }
    return null;
  }, [state.messages]);

  /** After an RPC rejection/CAS miss, ask disk for the authoritative Goal.
   *  Roll back to the local snapshot only when that reconciliation also fails. */
  const reconcileGoalMutation = async (
    eid: string,
    bucket: string,
    before: ActiveGoal,
    expectedProjection: ActiveGoal | null,
    mutationSeq: number,
  ): Promise<"active" | "deleted" | "superseded"> => {
    if (goalMutationSeqRef.current.get(bucket) !== mutationSeq) return "superseded";
    try {
      const persisted = await window.codeshell.goalGet(eid);
      if (goalMutationSeqRef.current.get(bucket) !== mutationSeq) return "superseded";
      if (persisted.ok === false) throw new Error("goal reconciliation rejected");
      if (persisted.goal) {
        const persistedGoalId = persisted.goalId ?? before.goalId;
        const sameGoal = persistedGoalId === before.goalId;
        dispatch({
          type: "goal_reconcile",
          bucket,
          expected: expectedProjection
            ? {
                goalId: expectedProjection.goalId,
                revision: expectedProjection.revision,
              }
            : null,
          goal: {
            goalId: persistedGoalId,
            revision: persisted.revision ?? (sameGoal ? before.revision : undefined),
            objective: persisted.goal,
            paused: persisted.paused ?? false,
            round: sameGoal ? before.round : 0,
          },
        });
        return "active";
      } else {
        dispatch({
          type: "goal_reconcile",
          bucket,
          expected: expectedProjection
            ? {
                goalId: expectedProjection.goalId,
                revision: expectedProjection.revision,
              }
            : null,
          goal: null,
        });
        return "deleted";
      }
    } catch (error) {
      window.codeshell.log("goal.reconcile.failed", {
        sessionId: eid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (goalMutationSeqRef.current.get(bucket) !== mutationSeq) return "superseded";
    dispatch({
      type: "goal_reconcile",
      bucket,
      expected: expectedProjection
        ? { goalId: expectedProjection.goalId, revision: expectedProjection.revision }
        : null,
      goal: before,
    });
    return "active";
  };

  /** Optimistically project one Goal edit, then reconcile the canonical RPC
   *  result. A failed operation is logged and rolled back as long as no newer
   *  local Goal mutation superseded it. */
  const mutateActiveGoal = (next: ActiveGoal, operation: "edit" | "pause" | "resume"): void => {
    const eid = engineSessionIdForActive();
    const before = state.activeGoal;
    if (!eid || !before || !before.goalId || before.revision === undefined) return;
    const expectedGoalId = before.goalId;
    const expectedRevision = before.revision;
    const bucket = activeBucket;
    const optimistic: ActiveGoal = {
      ...next,
      revision: Math.max(1, before.revision) + 1,
    };
    const mutationSeq = (goalMutationSeqRef.current.get(bucket) ?? 0) + 1;
    goalMutationSeqRef.current.set(bucket, mutationSeq);
    dispatch({
      type: "stream",
      bucket,
      event: {
        type: "goal_updated",
        goalId: optimistic.goalId,
        revision: optimistic.revision,
        objective: optimistic.objective,
        paused: optimistic.paused,
      } as StreamEvent,
    });

    void (async () => {
      try {
        const result = await window.codeshell.goalUpdate(eid, {
          ...(next.objective !== before.objective ? { objective: next.objective } : {}),
          ...(next.paused !== before.paused ? { paused: next.paused } : {}),
          expectedGoalId,
          expectedRevision,
        });
        if (!result.ok || !result.updated) {
          throw new Error(result.ok ? "goal was not updated" : "goal update rejected");
        }
        if (goalMutationSeqRef.current.get(bucket) !== mutationSeq) return;
        dispatch({
          type: "stream",
          bucket,
          event: {
            type: "goal_updated",
            goalId: result.goalId ?? optimistic.goalId,
            revision: result.revision ?? optimistic.revision,
            objective: result.goal?.trim() || optimistic.objective,
            paused: result.paused ?? optimistic.paused,
          } as StreamEvent,
        });
      } catch (error) {
        window.codeshell.log("goal.update.failed", {
          operation,
          sessionId: eid,
          error: error instanceof Error ? error.message : String(error),
        });
        await reconcileGoalMutation(eid, bucket, before, optimistic, mutationSeq);
      }
    })();
  };

  const handleUpdateGoal = (objective: string): void => {
    const goal = state.activeGoal;
    const nextObjective = objective.trim();
    if (!goal || !nextObjective || nextObjective === goal.objective) return;
    mutateActiveGoal({ ...goal, objective: nextObjective }, "edit");
  };

  const handleGoalPausedChange = (paused: boolean): void => {
    const goal = state.activeGoal;
    if (!goal || paused === goal.paused) return;
    mutateActiveGoal({ ...goal, paused }, paused ? "pause" : "resume");
  };

  // Delete is optimistic for the same idle-session reason as the legacy clear
  // control: without a live worker no goal_cleared event is streamed back. Keep
  // goalClear as a runtime fallback for an older preload during hot reload.
  const handleDeleteGoal = (): void => {
    const eid = engineSessionIdForActive();
    const before = state.activeGoal;
    if (!eid || !before || !before.goalId || before.revision === undefined) return;
    const expectedGoalId = before.goalId;
    const expectedRevision = before.revision;
    const bucket = activeBucket;
    const previousGoalToggle = goalOverrides[bucket] ?? false;
    const mutationSeq = (goalMutationSeqRef.current.get(bucket) ?? 0) + 1;
    goalMutationSeqRef.current.set(bucket, mutationSeq);
    dispatch({
      type: "stream",
      bucket,
      event: {
        type: "goal_cleared",
        goalId: before.goalId,
        revision: before.revision,
      } as StreamEvent,
    });
    setGoalOverrides((prev) => ({ ...prev, [bucket]: false }));

    void (async () => {
      try {
        const result = window.codeshell.goalDelete
          ? await window.codeshell.goalDelete(eid, {
              expectedGoalId,
              expectedRevision,
            })
          : await window.codeshell
              .goalClear(eid)
              .then(({ ok, cleared }) => ({ ok, deleted: cleared }));
        if (!result.ok || !result.deleted) {
          throw new Error(result.ok ? "goal was not deleted" : "goal delete rejected");
        }
      } catch (error) {
        window.codeshell.log("goal.delete.failed", {
          sessionId: eid,
          error: error instanceof Error ? error.message : String(error),
        });
        const reconciled = await reconcileGoalMutation(eid, bucket, before, null, mutationSeq);
        if (reconciled === "active") {
          setGoalOverrides((prev) => ({ ...prev, [bucket]: previousGoalToggle }));
        }
      }
    })();
  };

  const handleContextPackageCreated = async (
    result: SummaryForkSessionResult,
    sourceBucket: string,
    options?: ContextPackageCreatedOptions,
  ): Promise<void> => {
    const projectId = activeProjectId;
    const title = result.titleSuggestion?.trim() || t("chat.contextPackage.cardTitle");
    const previouslyActiveSessionId = loadSessionIndex(projectId).activeSessionId;
    const created = createSession(projectId, title);
    // Registration must not select the target before async hydration finishes.
    // In particular, a stale package from another session remains reachable in
    // the sidebar without stealing focus from the session the user switched to.
    setActiveSession(projectId, previouslyActiveSessionId);
    bindEngineSession(projectId, created.sessionId, result.sessionId);
    const bucket = bucketKey(projectId, created.sessionId);
    const targetOverrides = copyContextPackageOverrides({
      sourceBucket,
      targetBucket: bucket,
      modelOverrides,
      permissionOverrides,
      goalOverrides,
      defaultModel: defaultActiveModelKey,
      defaultPermission: defaultPermissionMode,
    });
    const inheritedModel = targetOverrides.modelOverrides[bucket];
    const inheritedPermission = targetOverrides.permissionOverrides[bucket];
    let hydrated: MessagesReducerState;
    try {
      hydrated = foldTranscript(await window.codeshell.getSessionTranscript(result.sessionId));
    } catch {
      // Core already published the target atomically. Keep it reachable in the
      // sidebar even if this one hydration read fails; selecting it later will
      // retry the normal disk hydration path.
      hydrated = foldTranscript([]);
    }
    saveTranscript(projectId, created.sessionId, hydrated);
    engineToBucketRef.current.set(result.sessionId, bucket);
    dispatch({ type: "hydrate", bucket, state: hydrated });
    if (inheritedModel) {
      setModelOverrides((prev) => ({ ...prev, [bucket]: inheritedModel }));
    }
    if (inheritedPermission) {
      setPermissionOverrides((prev) => ({ ...prev, [bucket]: inheritedPermission }));
    }
    setGoalOverrides((prev) => ({ ...prev, [bucket]: false }));
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegmentFor(projectId)]: loadSessionIndex(projectId),
    }));
    if (options?.shouldActivate() ?? true) handleSelectSession(projectId, created.sessionId);
  };

  const platformClass = isMac ? "platform-darwin" : "";
  // Both settings routes replace the entire application chrome. Keep this
  // shared flag so the expensive session tree stays mounted but hidden.
  const isSettingsPage = view.viewMode === "settings_page" || view.viewMode === "project_config";
  const isPetView = view.viewMode === "pet";
  const isPetSettingsView = view.viewMode === "pet_settings";
  const isPetSurface = isPetView || isPetSettingsView;
  const isChatView = view.viewMode === "chat";
  useEffect(() => {
    if (!isPetView) return;
    const markIfVisible = (): void => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        markViewedPetCompletions();
      }
    };
    markIfVisible();
    window.addEventListener("focus", markIfVisible);
    document.addEventListener("visibilitychange", markIfVisible);
    return () => {
      window.removeEventListener("focus", markIfVisible);
      document.removeEventListener("visibilitychange", markIfVisible);
    };
  }, [isPetView, markViewedPetCompletions]);
  // Re-render when pages register/unregister; builtin-only today, but the
  // seam is what plugin pages will use.
  React.useSyncExternalStore(
    PAGE_REGISTRY.subscribe,
    PAGE_REGISTRY.snapshot,
    PAGE_REGISTRY.snapshot,
  );
  const registeredPageRender = !isPetView
    ? (PAGE_REGISTRY.get(view.viewMode)?.render ?? null)
    : null;
  const petPendingCount = surfaceablePendingCount;
  const petRunningCount =
    petState.projection?.sessions.filter((session) => session.runState === "running").length ?? 0;

  return (
    <AppShell platformClass={platformClass} sidebarCollapsed={view.sidebarCollapsed}>
      <div
        className={isSettingsPage ? "hidden" : "flex min-h-0 flex-1 flex-col"}
        aria-hidden={isSettingsPage}
      >
        <div className="shrink-0">
          <TopBar
            projectName={isPetSurface ? null : (activeProject?.name ?? null)}
            projectPath={isPetSurface ? null : (activeProject?.path ?? null)}
            sessionId={isPetSurface ? null : engineSessionIdForActive()}
            sessionTitle={isPetSurface ? null : sessionTitleForTop}
            workspaceProfile={isPetSurface ? null : activeSessionSummary?.workspaceProfile}
            workspaceProfiles={isPetSurface ? [] : sessionWorkspaceProfiles}
            workspaceProfileSwitchDisabled={busy || !isChatView}
            onWorkspaceProfileChange={(profileName) => {
              void handleSessionWorkspaceProfileChange(profileName);
            }}
            busy={isPetSurface ? false : busy}
            sidebarCollapsed={view.sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            panelOpen={activePanelState.open}
            onTogglePanel={togglePanel}
            isMac={isMac}
            isFullscreen={isFullscreen}
            // Draft state (no active session yet) has no conversation/context to
            // attach panels to — hide the dock toggle until a real session exists.
            // The dock lives alongside chat only; other full-screen views
            // (credentials / automation / …) reuse this render tree (incl. TopBar)
            // but have no panel area, so also gate on the chat viewMode — otherwise
            // the toggle wrongly shows on those pages whenever a session is active.
            panelAvailable={activeSessionId !== null && isChatView}
            statusAvailable={!isPetSurface}
            contextSelectionAvailable={
              activeSessionId !== null && isChatView && !busy && !awaitingHydration
            }
            onSelectContext={requestContextSelection}
            activity={isPetSurface ? undefined : liveActivity}
            tasks={isPetSurface ? null : latestTasks}
            activeGoal={isPetSurface ? null : state.activeGoal}
            onUpdateGoal={handleUpdateGoal}
            onGoalPausedChange={handleGoalPausedChange}
            onDeleteGoal={handleDeleteGoal}
          />
        </div>

        <div className="flex min-h-0 flex-1">
          {!view.sidebarCollapsed && (
            <div className="flex shrink-0 overflow-hidden">
              <Sidebar
                projects={projects}
                sessions={sessionIndices}
                activeProjectId={activeProjectId}
                activeSessionId={activeSessionId}
                collapsedProjects={collapsedProjects}
                sidebarCollapsed={view.sidebarCollapsed}
                petPendingCount={petPendingCount}
                petRunningCount={petRunningCount}
                petWidgetVisible={petWidgetVisible}
                sessionHistoryLoading={diskSessionCatalog.loading}
                hasMoreSessionHistory={
                  diskSessionCatalog.initialized && diskSessionCatalog.nextCursor !== null
                }
                sessionStatuses={sessionStatusMap}
                onSelectProject={setActiveProjectId}
                onSelectSession={handleSelectSession}
                onToggleProject={handleToggleProject}
                onAddProject={() => {
                  void handleAddProject();
                }}
                onRemoveProject={handleRemoveProject}
                onPinProject={handlePinProject}
                onRenameProject={handleRenameProject}
                onArchiveAllSessions={handleArchiveAllSessions}
                onNewConversationForProject={handleNewConversationForProject}
                onNewConversation={handleNewConversation}
                onOpenSearch={() => setSessionSearchOpen(true)}
                onNavigate={setViewMode}
                onOpenProjectConfig={(projectId) => {
                  setActiveProjectId(projectId);
                  setViewMode("project_config");
                }}
                onOpenSettingsPage={() => setViewMode("settings_page")}
                onOpenPetPage={openPetPage}
                onTogglePetWidget={togglePetWidget}
                onLoadMoreSessionHistory={() =>
                  void loadDiskSessionCatalogPage(diskSessionCatalog.nextCursor ?? undefined)
                }
                onRenameSession={handleRenameSession}
                onPinSession={handlePinSession}
                onArchiveSession={handleArchiveSession}
                onDeleteSession={handleDeleteSession}
                activeProjectPath={activeProject?.path ?? null}
                viewMode={view.viewMode}
              />
            </div>
          )}

          {/* Chat column + dock share a relative container so a maximized panel can
          overlay the chat/composer (TODO 2.4) without covering the sidebar. */}
          <div className="relative flex min-w-0 flex-1 overflow-hidden">
            <AppMainView
              lifecycle={isChatView ? lifecycle : null}
              searchLayer={
                !isPetSurface ? (
                  <SearchBar
                    open={searchOpen}
                    value={searchQuery}
                    onChange={setSearchQuery}
                    onClose={() => setSearchOpen(false)}
                    matchCount={matchCount}
                  />
                ) : null
              }
            >
              {isPetView ? (
                <PetPage>
                  <PetWorldPane
                    projection={petState.projection}
                    status={petState.status}
                    focusPending={petState.overviewFocus === "pending"}
                    excludedSessionIds={archivedPetSessionIds}
                    onNavigate={(request) => void handleOpenPetTarget(request)}
                  />
                  <PetChatHost
                    defaultProjectPath={activeProject?.path ?? null}
                    defaultModelKey={defaultActiveModelKey}
                    modelOptions={modelOptions}
                    onOpenSession={(request) => void handleOpenPetTarget(request)}
                    onOpenSettings={() => setViewMode("pet_settings")}
                  />
                </PetPage>
              ) : isPetSettingsView ? (
                <PetSettingsPage
                  activeModelKey={petChatModelKey ?? defaultActiveModelKey}
                  modelOptions={modelOptions}
                  hasModelOverride={petChatModelKey !== null}
                  widgetVisible={petWidgetVisible}
                  onSelectModel={(option) => setPetChatModelKey(option.key)}
                  onResetModel={() => setPetChatModelKey(null)}
                  onWidgetVisibleChange={setPetWidgetVisibility}
                  onOpenConnections={() => setViewMode("credentials")}
                  onBack={openPetPage}
                />
              ) : registeredPageRender ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  {registeredPageRender({ runsInitialRunId })}
                </React.Suspense>
              ) : view.viewMode === "approvals" ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  <ApprovalsView
                    queue={approvalQueue}
                    history={approvalHistory}
                    onDecide={decideEnvelope}
                  />
                </React.Suspense>
              ) : view.viewMode === "digital_humans" ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  <DigitalHumansView
                    activeProjectPath={activeProject?.path ?? null}
                    onUse={(selection, starterPrompt) => {
                      if (!activeProjectId || !activeProject) {
                        toast({ message: t("digitalHumans.pickProject"), variant: "error" });
                        return;
                      }
                      const members =
                        selection.kind === "single" ? [selection.id] : selection.members;
                      if (members.length === 0) return;
                      let activeCreatedId: string | null = null;
                      let latestIndex: SessionIndex | null = null;
                      members.forEach((profileName, index) => {
                        const title =
                          selection.kind === "single"
                            ? selection.label
                            : `${selection.label} · ${profileName}`;
                        const created = createSession(activeProjectId, title, {
                          activate: index === 0,
                          workspaceProfile: profileName,
                        });
                        if (index === 0) activeCreatedId = created.sessionId;
                        latestIndex = created.index;
                      });
                      if (!activeCreatedId || !latestIndex) return;
                      const bucket = bucketKey(activeProjectId, activeCreatedId);
                      activeBucketRef.current = bucket;
                      setSessionIndices((previous) => ({
                        ...previous,
                        [projectBucketSegmentFor(activeProjectId)]: latestIndex!,
                      }));
                      if (starterPrompt) {
                        setComposerDrafts((previous) => ({
                          ...previous,
                          [bucket]: { text: starterPrompt, attachments: EMPTY_ATTACHMENTS },
                        }));
                      }
                      setViewMode("chat");
                    }}
                  />
                </React.Suspense>
              ) : view.viewMode === "credentials" ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  <CredentialsPage
                    activeProjectPath={activeProject?.path ?? null}
                    activeBucket={activeSessionId !== null ? activeBucket : null}
                  />
                </React.Suspense>
              ) : view.viewMode === "automation" ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  <AutomationView
                    onCreateConversational={startConversationalAutomation}
                    onViewRun={(runId) => {
                      setRunsInitialRunId(runId);
                      setViewMode("runs");
                    }}
                    onOpenRunSession={(run) => {
                      void handleOpenAutomationRunSession(run);
                    }}
                    onOpenDiskSession={(session) => {
                      void handleOpenAutomationDiskSession(session);
                    }}
                    onOpenSession={handleSelectSession}
                    sessionIndices={sessionIndices}
                    projects={projects}
                  />
                </React.Suspense>
              ) : (
                <>
                  <ChatView
                    messages={state.messages}
                    awaitingHydration={awaitingHydration}
                    turnEpoch={state.turnEpoch}
                    engineSessionId={state.sessionId ?? engineSessionIdForActive()}
                    liveTurnActive={liveTurnActive}
                    onContextPackageCreated={(result, options) =>
                      handleContextPackageCreated(result, activeBucket, options)
                    }
                    contextSelectionRequest={contextSelectionRequest}
                    sendBucket={activeBucket}
                    onSend={(text, opts) =>
                      send(text, {
                        ...opts,
                        bucket: resolveMainComposerBucket(
                          opts?.bucket,
                          activeBucket,
                          activeBucketRef.current,
                        ),
                      })
                    }
                    onQueueInput={(text, opts) =>
                      queueInput(text, {
                        ...opts,
                        bucket: resolveMainComposerBucket(
                          opts?.bucket,
                          activeBucket,
                          activeBucketRef.current,
                        ),
                      })
                    }
                    onForceSend={(text, opts) =>
                      forceSend(text, {
                        ...opts,
                        bucket: resolveMainComposerBucket(
                          opts?.bucket,
                          activeBucket,
                          activeBucketRef.current,
                        ),
                      })
                    }
                    onCompactCommand={compactActiveSession}
                    onStop={() => stop()}
                    busy={busy}
                    compacting={compacting}
                    queuedInputCount={queuedInputs[activeBucket]?.length ?? 0}
                    queuedInputItems={(queuedInputs[activeBucket] ?? []).map(
                      (i) => i.displayText ?? i.text,
                    )}
                    onClearQueuedInput={clearActiveQueuedInput}
                    onRemoveQueuedInput={removeActiveQueuedInputAt}
                    onGuideQueuedInput={guideActiveQueuedInput}
                    runningAgents={runningAgents}
                    activeProjectId={activeProjectId}
                    composerSeed={composerSeed}
                    composerSeedNonce={composerSeedNonce}
                    onComposerSeedConsumed={onComposerSeedConsumed}
                    draft={composerDraft.text}
                    onDraftChange={setComposerDraftText}
                    attachments={composerDraft.attachments}
                    onAttachmentsChange={setComposerDraftAttachments}
                    anchors={anchors}
                    onRemoveAnchor={removeAnchor}
                    onClearAnchors={clearAnchors}
                    onAskUserAnswer={handleAskUserAnswer}
                    onExtendGoal={extendGoal}
                    onAttachImagePath={(p) => void attachImageByPath(p)}
                    onPrepareAttachmentSession={prepareAttachmentSession}
                    imageDetail={imageDetail}
                    pendingApproval={visibleApproval}
                    onApprovalDecide={
                      visibleApproval
                        ? (decision, reason, scope, pathScope) =>
                            decideEnvelope(visibleApproval, decision, reason, scope, pathScope)
                        : undefined
                    }
                    permissionMode={permissionMode}
                    onPermissionChange={onPermissionChange}
                    goalEnabled={goalEnabled}
                    onGoalToggle={onGoalToggle}
                    modelOptions={modelOptions}
                    activeModelKey={activeModelKey}
                    onModelChange={onModelChange}
                    contextTokens={state.promptTokens}
                    contextMax={
                      modelOptions.find((o) => o.key === activeModelKey)?.maxContextTokens
                    }
                    singleTurnPromptTokens={state.singleTurnPromptTokens}
                    singleTurnCacheReadTokens={state.singleTurnCacheReadTokens}
                    singleTurnCacheCreationTokens={state.singleTurnCacheCreationTokens}
                    cumulativePromptTokens={state.cumulativePromptTokens}
                    cumulativeCacheReadTokens={state.cumulativeCacheReadTokens}
                    cumulativeCacheCreationTokens={state.cumulativeCacheCreationTokens}
                    projects={projects}
                    // Picking a project (or 不使用项目) from the composer's
                    // ProjectPicker enters a fresh draft for that project rather than a
                    // bare setActiveProjectId — otherwise the chat snaps to whatever
                    // session that bucket last had active (the top of its list),
                    // which reads as an unexpected auto-jump. (The reload-time
                    // auto-jump was fixed separately in transcripts.ts; this is the
                    // interactive project-switch path, same symptom, different code.)
                    onSelectProject={handleNewConversationForProject}
                    onAddProject={() => {
                      void handleAddProject();
                    }}
                    activeProjectPath={activeProject?.path ?? null}
                    // cwd used to RESOLVE message content (relative path links, inline
                    // images) — distinct from activeProjectPath (git/STT/branch, which
                    // must stay null for a no-repo chat). A no-repo session actually
                    // runs under the sandbox cwd, so fall back to it; otherwise a
                    // relative `docs/x.md` link can't resolve and renders as dead text.
                    messageCwd={activeProject?.path ?? noRepoCwdRef.current}
                    repoClean={activeGitMeta.clean}
                    welcomeNode={
                      showWelcome ? (
                        <div className="flex flex-col items-center gap-4 text-center">
                          <img
                            src={dogIcon}
                            alt="CodeShell"
                            draggable={false}
                            className="h-32 w-32 select-none rounded-2xl object-contain"
                          />
                          <div className="text-3xl font-semibold tracking-tight text-foreground">
                            {activeProject
                              ? t("misc.app.welcomeTitleRepo", { name: activeProject.name })
                              : t("misc.app.welcomeTitleNoRepo")}
                          </div>
                          {!activeProject && (
                            <div className="text-sm text-muted-foreground">
                              {t("misc.app.welcomeHintNoRepo")}
                            </div>
                          )}
                        </div>
                      ) : null
                    }
                  />
                </>
              )}
            </AppMainView>

            {/* PanelArea stays MOUNTED across close→reopen (hidden via display:none
          when !open) so the browser <webview> and terminal pty survive a dock
          close — reopening lands on the same live page instead of reloading
          from scratch (matches Codex). Closing only hides; the webview process
          is reclaimed by BrowserPanel's own idle-eviction after a few minutes.
          We still gate on having tabs so an empty dock doesn't mount stray
          panel bodies before the user has opened anything. */}
            {panelBuckets.length > 0 && (
              <React.Suspense
                fallback={
                  <div
                    className="flex shrink-0 items-center justify-center border-l border-border text-xs text-muted-foreground"
                    style={{ width: panelWidth }}
                    role="status"
                  >
                    {t("panels.common.loading")}
                  </div>
                }
              >
                <SessionPanelDock
                  panelBuckets={panelBuckets}
                  panelByBucket={panelByBucket}
                  activeBucket={activeBucket}
                  isChatView={isChatView}
                  projects={projects}
                  updatePanelBucket={updatePanelBucket}
                  onRevealConsumed={onRevealConsumed}
                  onOpenCliSessionConsumed={onOpenCliSessionConsumed}
                  panelWidth={panelWidth}
                  beginPanelResize={beginPanelResize}
                  onAttachImage={(path) => void attachImageByPath(path)}
                  anchorsByBucket={anchorsByBucket}
                  removeAnchor={removeAnchor}
                  updateAnchorComment={updateAnchorComment}
                  resolveEngineSessionIdForBucket={resolveEngineSessionIdForBucket}
                  quickChatSessions={quickChatSessions}
                  transcripts={transcripts}
                  busyKeys={busyKeys}
                  approvalForBucket={approvalForBucket}
                  noRepoCwd={noRepoCwdRef.current}
                  permissionOverrides={permissionOverrides}
                  defaultPermissionMode={defaultPermissionMode}
                  modelOverrides={modelOverrides}
                  defaultActiveModelKey={defaultActiveModelKey}
                  quickChatDrafts={quickChatDrafts}
                  quickChatAttachments={quickChatAttachments}
                  modelOptions={modelOptions}
                  imageDetail={imageDetail}
                  setQuickChatPermission={setQuickChatPermission}
                  setQuickChatModel={setQuickChatModel}
                  ensureQuickChatSession={ensureQuickChatSession}
                  cleanupQuickChatPanelSession={cleanupQuickChatPanelSession}
                  restartQuickChatSession={restartQuickChatSession}
                  setQuickChatDraft={setQuickChatDraft}
                  setQuickChatAttachmentState={setQuickChatAttachmentState}
                  sendQuickChat={sendQuickChat}
                  stop={stop}
                  handleAskUserAnswer={handleAskUserAnswer}
                  decideEnvelope={decideEnvelope}
                />
              </React.Suspense>
            )}
          </div>
        </div>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={buildCommands({
            setViewMode,
            openPanel,
            toggleSidebar,
            toggleInspector,
            clearTranscript,
            openSearch: () => setSearchOpen(true),
          })}
        />

        <SessionSearchModal
          open={sessionSearchOpen}
          onClose={() => setSessionSearchOpen(false)}
          projects={projects}
          sessions={sessionIndices}
          activeProjectId={activeProjectId}
          onPick={(projectId, sid) => handleSelectSession(projectId, sid)}
        />

        <TrustGate
          projectPath={activeProject?.path ?? null}
          onDecide={() => {
            /* trust persisted in main */
          }}
        />

        {/* Inspector panel removed — tool detail lives inline in each
          tool card's expandable body. */}
      </div>

      <PetPeekHost
        peeks={petPeeks}
        onAction={handlePetPeekAction}
        onDismiss={(peek) => settlePetPeek(peek, "dismissed")}
      />

      {isSettingsPage && (
        <div className="absolute inset-0 z-50 overflow-hidden bg-background">
          <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
            {view.viewMode === "settings_page" ? (
              <SettingsPage
                key="settings-global"
                activeProjectPath={activeProject?.path ?? null}
                projects={projects}
                sessionIndices={sessionIndices}
                onRestoreArchivedSession={(projectId, sessionId) => {
                  const next = archiveSession(projectId, sessionId, false);
                  setSessionIndices((prev) => ({
                    ...prev,
                    [projectBucketSegmentFor(projectId)]: next,
                  }));
                }}
                onDeleteArchivedSession={handleDeleteSession}
                isMac={isMac}
                isFullscreen={isFullscreen}
                onBack={() => setViewMode("chat")}
                onOpenDigitalHumans={() => setViewMode("digital_humans")}
              />
            ) : activeProject ? (
              // project_config: the same settings center, preselected to the
              // project's scope (SettingsPage opens on its project overview).
              <SettingsPage
                // key forces a remount when hopping between the global route and
                // a project-config route — initialProjectPath is mount-time only.
                key={`settings-project-${activeProject.path}`}
                activeProjectPath={activeProject.path}
                initialProjectPath={activeProject.path}
                projects={projects}
                sessionIndices={sessionIndices}
                onRestoreArchivedSession={(projectId, sessionId) => {
                  const next = archiveSession(projectId, sessionId, false);
                  setSessionIndices((prev) => ({
                    ...prev,
                    [projectBucketSegmentFor(projectId)]: next,
                  }));
                }}
                onDeleteArchivedSession={handleDeleteSession}
                isMac={isMac}
                isFullscreen={isFullscreen}
                onBack={() => setViewMode("chat")}
                onOpenDigitalHumans={() => setViewMode("digital_humans")}
              />
            ) : null}
          </React.Suspense>
        </div>
      )}
    </AppShell>
  );
}

function resolveActiveKey(s: Record<string, unknown>): string | null {
  // Unified catalog: defaults.text holds the active text connection's instance
  // id — the engine's priority #1 (engine.ts) and the picker's option key.
  const defaults =
    s.defaults && typeof s.defaults === "object" ? (s.defaults as Record<string, unknown>) : {};
  if (typeof defaults.text === "string" && defaults.text) return defaults.text;
  return null;
}

export { App };
export default App;
