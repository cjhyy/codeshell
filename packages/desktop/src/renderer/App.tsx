import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import dogIcon from "./assets/codeshell-dog-icon.png";
import { timePhase } from "./perf";
import { summarizeLiveActivity } from "./topbar/liveActivity";
// InspectorPanel removed — tool details now live inline in the chat
// stream's expandable tool cards (no dedicated detail pane).
import { useToast } from "./ui/ToastProvider";
import { useT } from "./i18n/I18nProvider";
import {
  applyStreamEvent,
  bgCompletionText,
  INITIAL_STATE,
  type MessagesReducerState,
  type ApprovalState,
  type ToolMessage,
  type AskUserOption,
  type TaskListMessage,
} from "./types";
import { transcriptsReducer, type TranscriptsMap } from "./transcriptsReducer";
import {
  loadTranscript,
  saveTranscript,
  migrateRepoSessionBucket,
  loadSessionIndex,
  createSession,
  deleteSessionLocal,
  renameSessionLocal,
  archiveSession,
  archiveAllSessions,
  loadDeletedArchivedIndices,
  bindEngineSession,
  upsertImportedSession,
  updateSessionRunStatus,
  touchSession,
  setActiveSession,
  NO_REPO_KEY,
  bucketKey,
  repoKeyOf,
  migrateBucketOverride,
  migrateRepoBucketOverrides,
  clearBucketOverride,
  loadPanelState,
  clearPanelState,
  savePanelState,
  loadOverrideMap,
  saveOverrideMap,
  type SessionIndex,
  type SessionSummary,
} from "./transcripts";
import { planSessionDeletion } from "./sessionDeletionPlan";
import { titleFromWire, buildPathAttachment, type ImageAttachment } from "./chat/attachments";
import { resolveBucket, findAskUserOrigin } from "./streamRouting";
import { resolveStopBucket } from "./stopRouting";
import { statusForBucket, type SessionStatus } from "./sessionStatus";
import { selectReplayEvents } from "./snapshotReplay";
import { runAfterModelSwitch } from "./modelSwitchRun";
import { persistDefaultTextModel } from "./modelSelection";
import { writeSettings } from "./settingsBus";
import type {
  AgentLifecycleEvent,
  ApprovalRequestEnvelope,
  ApprovalResolvedEnvelope,
  MobilePermissionMode,
  MobilePermissionModeEnvelope,
  MobilePermissionModeSnapshotEntry,
  RunSummary,
  StreamEventEnvelope,
} from "../preload/types";
import {
  loadRepos,
  saveRepos,
  loadActiveRepoId,
  saveActiveRepoId,
  makeRepoId,
  isRepoPathRemoved,
  markRepoPathRemoved,
  unmarkRepoPathRemoved,
  makeCreateRepoForCwd,
  reconcileReposFromDisk,
  reconcileReposFromDiskWithRemap,
  repoLabel,
  sortRepos,
  type Repo,
} from "./repos";
import { importAutomationRuns, type ImportableRun } from "./automation/importRuns";
import { foldTranscript } from "./automation/foldTranscript";
import { chooseHydrateBase } from "./automation/hydrateOrder";
import { isCaseInsensitivePlatform } from "./automation/pathMatch";
import { placeLiveAutomationSession } from "./automation/liveSession";
import { planDiskRebuild, type DiskSessionMeta } from "./automation/rebuildFromDisk";
import {
  enqueueQueuedInput,
  dequeueQueuedInput,
  drainQueuedInput,
  clearQueuedInput,
  removeQueuedInputById,
  enqueueSerialTask,
  type SerialTaskQueue,
  type QueuedInputState,
} from "./queuedInput";
import { loadView, saveView, type ViewState, type ViewMode } from "./view";
import { ApprovalsView } from "./approvals/ApprovalsView";
import type { ApproveChoice, ApprovePathScope } from "./approvals/approvalDecision";
import { LogsView } from "./logs/LogsView";
// Full-page Settings — driven by viewMode === 'settings_page'.
import { SettingsPage } from "./settings/SettingsPage";
import { RunsView } from "./runs/RunsView";
import { AutomationView } from "./automation/AutomationView";
import { CustomizeView } from "./customize/CustomizeView";
import { CredentialsPage } from "./credentials/CredentialsPage";
import { PanelArea } from "./panels/PanelArea";
import type { PanelTab } from "./view";
import { nextAnchorId, type Anchor } from "./chat/anchors";
import {
  addAnchorTo,
  anchorsIn,
  browserAnchorsOf,
  clearAnchorBuckets,
  removeAnchorFrom,
  updateAnchorCommentIn,
  type AnchorsByBucket,
} from "./chat/anchorBuckets";
import { CommandPalette, buildCommands } from "./shell/CommandPalette";
import { SessionSearchModal } from "./shell/SessionSearchModal";
import { SearchBar } from "./shell/SearchBar";
import { TrustGate } from "./workspace-trust/TrustGate";
import { loadGitPrefs } from "./gitPrefs";
import { createEventCoalescer } from "./streamCoalescer";
import {
  fromSettingsPermissionMode,
  toCorePermissionMode,
  type PermissionMode,
} from "./chat/PermissionPill";
import type { ModelOption } from "./chat/ModelPill";
import { catalogModelOptions, type ModelInstance } from "./settings/textConnections";

// Bucket key for sessions without a project — re-exported from transcripts.
// We use NO_REPO_KEY everywhere instead of a local const so the renderer
// and the persistence layer can't drift apart. `bucketKey`/`repoKeyOf` are
// imported from transcripts (the single source of truth) so App's map build
// can't drift from Sidebar's row lookup.
const GLOBAL_KEY = NO_REPO_KEY;

function toMobilePermissionMode(mode: PermissionMode | null | undefined): MobilePermissionMode | null {
  switch (mode) {
    case "accept_edits":
      return "acceptEdits";
    case "bypass":
      return "bypassPermissions";
    case "default":
    case "plan":
      return "default";
    default:
      return null;
  }
}

function fromMobilePermissionMode(mode: MobilePermissionMode): PermissionMode {
  switch (mode) {
    case "acceptEdits":
      return "accept_edits";
    case "bypassPermissions":
      return "bypass";
    case "default":
    default:
      return "default";
  }
}

interface ComposerDraftState {
  text: string;
  attachments: ImageAttachment[];
}

type ComposerDraftsMap = Record<string, ComposerDraftState>;

const EMPTY_ATTACHMENTS: ImageAttachment[] = [];

interface ApprovalHistoryEntry {
  decision: "approve" | "deny";
  envelope: ApprovalRequestEnvelope;
  reason?: string;
  at: number;
}

interface PanelBucketState {
  open: boolean;
  tabs: { id: string; kind: PanelTab }[];
  activeId: string | null;
  requestNonce: number;
  requestKind: PanelTab | null;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  openUrl?: { url: string; nonce: number };
}

function emptyPanelBucketState(): PanelBucketState {
  return { open: false, tabs: [], activeId: null, requestNonce: 0, requestKind: null };
}

function hydratePanelBucketState(bucket: string): PanelBucketState {
  const snap = loadPanelState<PanelTab>(bucket);
  return { ...snap, requestNonce: 0, requestKind: null };
}

function parsePanelBucket(bucket: string): { repoKey: string; repoId: string | null; sessionId: string | null } {
  const sep = bucket.indexOf("::");
  const repoKey = sep >= 0 ? bucket.slice(0, sep) : bucket;
  const rawSessionId = sep >= 0 ? bucket.slice(sep + 2) : null;
  return {
    repoKey: repoKey || NO_REPO_KEY,
    repoId: repoKey && repoKey !== NO_REPO_KEY ? repoKey : null,
    sessionId: rawSessionId && rawSessionId !== "_none_" ? rawSessionId : null,
  };
}

function App() {
  const toast = useToast();
  const { t } = useT();
  const [transcripts, dispatch] = useReducer(transcriptsReducer, {} as TranscriptsMap);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequestEnvelope[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalHistoryEntry[]>([]);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
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
  const [repos, setRepos] = useState<Repo[]>(() => loadRepos());
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => loadActiveRepoId());
  const [view, setView] = useState<ViewState>(() => loadView());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
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
  const [imageDetail, setImageDetail] = useState<"low" | "standard" | "high" | undefined>(undefined);
  // Seed from localStorage so a refresh (F5) keeps each session's permission
  // choice — without this the map reset to {} on remount and every session
  // fell back to the default mode (a 完全访问 session silently reverted to 默认).
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, PermissionMode>>(
    () => loadOverrideMap<PermissionMode>("permission"),
  );
  /**
   * Per-bucket model override, keyed by the SAME bucketKey() as
   * permission/goal overrides. A session that has switched models (or whose
   * model was pinned at first send) lives here; everything else falls back to
   * `defaultActiveModelKey`. This is the fix for "切换模型不应改掉旧 session
   * 的模型": each session remembers its own model, and changing the global
   * default never overwrites an existing bucket's entry.
   */
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>(
    () => loadOverrideMap<string>("model"),
  );
  /** Per-bucket Goal-mode toggle (orthogonal to permission). */
  const [goalOverrides, setGoalOverrides] = useState<Record<string, boolean>>(
    () => loadOverrideMap<boolean>("goal"),
  );
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  /** Transient: a run to pre-select when jumping into the runs view (e.g. from
   *  the 自动化 detail's 「查看最近运行」 button). Not persisted in view state. */
  const [runsInitialRunId, setRunsInitialRunId] = useState<string | null>(null);

  // Session indices per repo (keyed by repoKey).
  const [sessionIndices, setSessionIndices] = useState<Record<string, SessionIndex>>(() => {
    const out: Record<string, SessionIndex> = {};
    const liveRepos = loadRepos();
    for (const r of liveRepos) out[r.id] = loadSessionIndex(r.id);
    out[GLOBAL_KEY] = loadSessionIndex(null);
    // Re-surface deleted projects' all-archived indices so 设置→高级→已归档
    // still lists them (under their original name) after a restart — App only
    // seeds from live repos above, which a removed project is no longer in.
    Object.assign(
      out,
      loadDeletedArchivedIndices(new Set(liveRepos.map((r) => r.id))),
    );
    return out;
  });

  /**
   * Create a fresh session on demand (lazy: only when the user actually
   * sends a message). A null `activeSessionId` means "draft state" —
   * chat surface shows the welcome, sidebar shows no row, no empty
   * stub clutters the session list. Caller-owned setState so the new
   * id can be threaded into a follow-up `touchSession` without two
   * back-to-back setSessionIndices calls clobbering each other.
   */
  const ensureActiveSession = (repoId: string | null): string => {
    const { sessionId } = createSession(repoId);
    return sessionId;
  };

  const activeRepoKey = repoKeyOf(activeRepoId);
  const activeSessionId =
    sessionIndices[activeRepoKey]?.activeSessionId ?? null;
  const activeBucket = bucketKey(activeRepoId, activeSessionId);
  const permissionMode = permissionOverrides[activeBucket] ?? defaultPermissionMode;
  // The model shown/used for the ACTIVE session: its own override if it has
  // one, else the global default. Drafts share the per-repo "_none_" bucket.
  const activeModelKey = modelOverrides[activeBucket] ?? defaultActiveModelKey;
  const goalEnabled = goalOverrides[activeBucket] ?? false;
  const busy = busyKeys.has(activeBucket);
  const platform = typeof window !== "undefined" ? window.codeshell?.platform : undefined;
  const isMac =
    platform === "darwin" ||
    (!platform && typeof navigator !== "undefined" && /Mac/.test(navigator.platform));
  const [composerDrafts, setComposerDrafts] = useState<ComposerDraftsMap>({});
  const composerDraft = composerDrafts[activeBucket] ?? {
    text: "",
    attachments: EMPTY_ATTACHMENTS,
  };
  const setComposerDraftText: React.Dispatch<React.SetStateAction<string>> = (next) => {
    setComposerDrafts((prev) => {
      const current = prev[activeBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const text = typeof next === "function" ? next(current.text) : next;
      if (text === current.text) return prev;
      return { ...prev, [activeBucket]: { ...current, text } };
    });
  };
  const setComposerDraftAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>> = (next) => {
    setComposerDrafts((prev) => {
      const current = prev[activeBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const attachments = typeof next === "function" ? next(current.attachments) : next;
      if (attachments === current.attachments) return prev;
      return { ...prev, [activeBucket]: { ...current, attachments } };
    });
  };
  // Attach an on-disk image to the composer by absolute path (file-panel add —
  // TODO 2.1). The staged attachment keeps the real path as its name so the
  // chip shows it and the wire payload carries it. Reads bytes via IPC.
  const attachImageByPath = async (absPath: string): Promise<void> => {
    const dataUrl = await window.codeshell.readImageDataUrl(absPath);
    if (!dataUrl) {
      window.codeshell.log("attach.path.not_image", { path: absPath });
      return;
    }
    setComposerDraftAttachments((cur) => {
      const { attachment } = buildPathAttachment(absPath, dataUrl, cur);
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
  const activeBucketRef = useRef(activeBucket);
  const approvalBucketsRef = useRef<Map<string, string>>(new Map());
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
  const coalescersRef = useRef<Map<string, ReturnType<typeof createEventCoalescer>>>(
    new Map(),
  );
  const permissionModeRef = useRef<PermissionMode | null>(permissionMode);
  /**
   * Repo keys already probed for a disk rebuild this session. Guards against an
   * infinite re-scan: the rebuild effect depends on `sessionIndices` and calls
   * `setSessionIndices`, so when a disk page maps only into OTHER repos the
   * active repo's index stays empty → the effect would re-run and re-scan disk
   * on every render. Probing each active repo at most once breaks that loop.
   */
  const diskProbedRef = useRef<Set<string>>(new Set());
  /**
   * Per-bucket permission resolver for the mount-time approval listener
   * (which closes over stale state). Mirrors the same precedence as
   * `permissionMode`: a bucket's explicit override, else the global
   * default. Used to honor 完全访问权限 (bypass) by auto-approving requests
   * that still reach the renderer.
   */
  const permissionForBucketRef = useRef<(bucket: string) => PermissionMode | null>(
    () => null,
  );
  const defaultPermissionModeRef = useRef<PermissionMode | null>(null);
  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null;
  const [activeGitMeta, setActiveGitMeta] = useState<{
    branch: string | null;
    clean: boolean | null;
  }>({ branch: null, clean: null });

  /**
   * Per-session sidebar status, keyed by the SAME bucketKey() the Sidebar
   * derives per row (repoKey::uiSessionId). Priority asking > running > unread.
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
   * up 1:1 with the rows Sidebar renders. NOTE: bucketKey()/repoKeyOf() must
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
    for (const [repoKey, index] of Object.entries(sessionIndices)) {
      const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
      for (const s of index.sessions) {
        if (s.engineSessionId && !engineToBucketIndex.has(s.engineSessionId)) {
          engineToBucketIndex.set(s.engineSessionId, bucketKey(repoId, s.id));
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

    for (const [repoKey, index] of Object.entries(sessionIndices)) {
      const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
      for (const s of index.sessions) {
        const bucket = bucketKey(repoId, s.id);
        const status = statusForBucket(bucket, asking, busyKeys, unreadBuckets);
        if (status) map[bucket] = status;
      }
    }
    return map;
  }, [approvalQueue, sessionIndices, busyKeys, unreadBuckets]);

  useEffect(() => { saveRepos(repos); }, [repos]);
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
  // so each known path keeps its stable repoId (session buckets stay intact).
  useEffect(() => {
    let alive = true;
    const apply = (
      projects: Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>,
    ): void => {
      if (!alive) return;
      setRepos((prev) => reconcileReposFromDisk(projects, prev));
    };
    void (async () => {
      // Back-fill: legacy repos live only in the localStorage cache and were
      // never written to disk. Push any cached path missing from disk so disk
      // becomes a complete source of truth (no project silently disappears on
      // the first run after this change). Soft-deleted ones stay deleted because
      // pushRecent un-deletes only on explicit re-add, and we skip removed paths.
      const disk = await window.codeshell.projects.list();
      const onDisk = new Set(disk.map((p) => p.path));
      const cached = loadRepos();
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
        if (onDisk.has(r.path) || isRepoPathRemoved(r.path) || seenMissing.has(r.path)) return false;
        seenMissing.add(r.path);
        return true;
      });
      const latestDisk = missing.length > 0
        ? await (async () => {
            for (const r of missing) {
              await window.codeshell.projects.add({ path: r.path, name: r.name });
            }
            return window.codeshell.projects.list();
          })()
        : disk;
      const { repos: reconciled, repoIdRemap } = reconcileReposFromDiskWithRemap(
        latestDisk,
        normalizedCached,
      );
      const remapEntries = Object.entries(repoIdRemap);
      const migratedRepoIds = new Set<string>();
      for (const [fromRepoId, toRepoId] of remapEntries) {
        migrateRepoSessionBucket(fromRepoId, toRepoId);
        migratedRepoIds.add(toRepoId);
      }
      if (!alive) return;
      setRepos(reconciled);
      if (remapEntries.length > 0) {
        setActiveRepoId((prev) => (prev && repoIdRemap[prev] ? repoIdRemap[prev] : prev));
        setPermissionOverrides((prev) => migrateRepoBucketOverrides(prev, repoIdRemap));
        setModelOverrides((prev) => migrateRepoBucketOverrides(prev, repoIdRemap));
        setGoalOverrides((prev) => migrateRepoBucketOverrides(prev, repoIdRemap));
        setSessionIndices((prev) => {
          const next = { ...prev };
          for (const [fromRepoId] of remapEntries) delete next[fromRepoId];
          for (const id of migratedRepoIds) next[id] = loadSessionIndex(id);
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
      sortRepos(repos).map((r) => ({
        path: r.path,
        name: repoLabel(r),
        addedAt: r.addedAt,
        pinned: Boolean(r.pinned),
      })),
    );
  }, [repos]);
  useEffect(() => {
    const entries: MobilePermissionModeSnapshotEntry[] = [];
    const seen = new Set<string>();
    const add = (sessionId: string | undefined, mode: MobilePermissionMode): void => {
      if (!sessionId || seen.has(sessionId)) return;
      seen.add(sessionId);
      entries.push({ sessionId, mode });
    };
    for (const [repoKey, index] of Object.entries(sessionIndices)) {
      const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
      for (const s of index.sessions) {
        const bucket = bucketKey(repoId, s.id);
        const mode = toMobilePermissionMode(permissionOverrides[bucket] ?? defaultPermissionMode);
        if (!mode) continue;
        add(s.engineSessionId ?? s.id, mode);
        add(s.id, mode);
      }
    }
    void window.codeshell.mobileRemote.updatePermissionModes(entries).catch((err) =>
      window.codeshell.log("mobile.permissionModes.update.failed", { error: String(err) }),
    );
  }, [sessionIndices, permissionOverrides, defaultPermissionMode]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);
  useEffect(() => { saveView(view); }, [view]);
  // Persist per-bucket overrides so they survive a refresh (see the seeded
  // useState initializers above). Each write mirrors loadOverrideMap's namespace.
  useEffect(() => { saveOverrideMap("permission", permissionOverrides); }, [permissionOverrides]);
  useEffect(() => { saveOverrideMap("model", modelOverrides); }, [modelOverrides]);
  useEffect(() => { saveOverrideMap("goal", goalOverrides); }, [goalOverrides]);
  useEffect(() => { activeBucketRef.current = activeBucket; }, [activeBucket]);
  // Fetch the no-repo sandbox cwd once; a no-repo send passes it explicitly.
  useEffect(() => {
    window.codeshell.noRepoCwd().then((p) => { noRepoCwdRef.current = p; }).catch(() => {});
  }, []);
  useEffect(() => { sessionIndicesRef.current = sessionIndices; }, [sessionIndices]);
  useEffect(() => { permissionModeRef.current = permissionMode; }, [permissionMode]);
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
    if (!activeRepo?.path) {
      setActiveGitMeta({ branch: null, clean: null });
      return () => { cancelled = true; };
    }
    void window.codeshell.getGitStatus(activeRepo.path)
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
    return () => { cancelled = true; };
  }, [activeRepo?.path, busy]);

  // No auto-create here: a null activeSessionId is the legitimate
  // "draft" state. A real session row only appears after the user
  // actually sends a message (see `send` below).

  /** Highest main-snapshot seq replayed into each bucket (dedup across re-views). */
  const appliedSeqRef = useRef<Map<string, number>>(new Map());

  // Lazy-hydrate transcript on first view of a bucket.
  //
  // Manual sessions hydrate straight from localStorage. Automation (cron)
  // sessions ran headless in the engine, so their turns live in the on-disk
  // transcript.jsonl, not in localStorage — and once the user manually replies,
  // the backfill importer's dedup gate stops re-importing them, permanently
  // shadowing the headless history. So for automation sessions we fold the disk
  // transcript and merge the localStorage tail on top (see mergeTranscripts).
  useEffect(() => {
    if (!activeSessionId) return;
    if (transcripts[activeBucket]) return;
    const local = loadTranscript(activeRepoId, activeSessionId);
    const summary = sessionIndices[activeRepoKey]?.sessions.find(
      (s) => s.id === activeSessionId,
    );
    const engineId = summary?.engineSessionId;
    const bucket = activeBucket;
    let cancelled = false;
    void (async () => {
      // Base projection: disk-authoritative for ANY session with an engine id.
      // Fold the on-disk transcript and let chooseHydrateBase merge the genuine
      // localStorage tail (disk order wins, so no orphan trailing group);
      // sessions not yet on disk fall back to the localStorage projection.
      let base = local;
      if (engineId) {
        try {
          const disk = foldTranscript(await window.codeshell.getSessionTranscript(engineId));
          base = chooseHydrateBase(disk, local);
        } catch {
          // disk read failed — fall back to the localStorage projection.
        }
      }
      // Reconnect to the main-held snapshot. The main process doesn't remount
      // with the renderer, so it still has events the worker streamed while the
      // renderer was gone (or after the last debounced persist). When the
      // localStorage projection is empty — the remount / fresh-view case where
      // the missing tail is exactly the bug — replay the snapshot to rebuild it.
      // (A non-empty projection already reflects persisted history; we don't
      // overlay there to avoid double-applying the worker-life overlap.)
      let state = base;
      if (engineId && base.messages.length === 0) {
        try {
          const snapshot = await window.codeshell.subscribeSession(engineId, 0);
          const { events, cursor } = selectReplayEvents(snapshot, 0);
          if (events.length > 0) {
            appliedSeqRef.current.set(bucket, cursor);
            let acc = base;
            for (const ev of events) acc = applyStreamEvent(acc, ev as StreamEvent);
            state = acc;
          }
        } catch {
          // Snapshot unavailable (no bridge / unknown session) — use base.
        }
        // Long-disconnect fallback: snapshot empty (evicted / worker long gone)
        // but the on-disk transcript may still hold the full history. Fold it
        // from disk as the last resort so the tab isn't blank for a session
        // whose events aged out of the in-memory snapshot window.
        if (state.messages.length === 0) {
          try {
            const disk = foldTranscript(await window.codeshell.getSessionTranscript(engineId));
            if (disk.messages.length > 0) state = disk;
          } catch {
            // disk read failed — keep base.
          }
        }
      }
      if (!cancelled) dispatch({ type: "hydrate", bucket, state });
      // Re-surface a persistent goal on load. A goal lives only in the engine's
      // state.json (state.activeGoal) and is NEVER replayed from the transcript,
      // so a session rebuilt from disk (localStorage wiped, or an aborted goal
      // run reloaded) hydrates with activeGoal === null — the goal block + its
      // Cancel button vanish even though the goal is still active on disk (the
      // "goal 还在但页面不显示、取消不了" bug). Ask the engine for the persisted
      // goal and, only when the hydrated state didn't already carry one (so we
      // never clobber a localStorage-preserved goal or its round), inject a
      // synthetic goal_set through the same reducer path the live event uses.
      if (engineId && !cancelled && state.activeGoal === null) {
        try {
          const { goal } = await window.codeshell.goalGet(engineId);
          if (goal && !cancelled) {
            dispatch({
              type: "stream",
              bucket,
              event: { type: "goal_set", objective: goal, replaced: false } as StreamEvent,
            });
          }
        } catch {
          // goalGet unavailable (no bridge / unknown session) — leave as-is.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBucket, activeRepoId, activeSessionId, activeRepoKey, sessionIndices, transcripts]);

  // Persist active transcript (debounced).
  useEffect(() => {
    if (!activeSessionId) return;
    const handle = setTimeout(() => {
      const s = transcripts[activeBucket];
      if (!s) return;
      saveTranscript(activeRepoId, activeSessionId, s);
    }, 600);
    return () => clearTimeout(handle);
  }, [transcripts, activeBucket, activeRepoId, activeSessionId]);

  // Display state for the active bucket. Prefer the hydrated reducer state; if
  // this bucket hasn't been hydrated yet (just switched to it), fall back to the
  // SYNCHRONOUS localStorage projection so the existing conversation paints on
  // the very first render — without this, the bucket reads INITIAL_STATE (empty)
  // for the frame(s) before the async hydrate effect dispatches, flashing the
  // "welcome / new chat" UI on every session switch. The async effect still
  // upgrades the bucket in place (disk-authoritative merge + main-snapshot tail)
  // exactly as before; this only covers the pre-hydration gap. Memoized on the
  // bucket so we don't re-read localStorage on unrelated renders.
  const fallbackState = useMemo<MessagesReducerState>(() => {
    if (!activeSessionId) return INITIAL_STATE;
    const local = loadTranscript(activeRepoId, activeSessionId);
    return local.messages.length > 0 ? local : INITIAL_STATE;
    // activeBucket captures (repoId, sessionId); recomputing per-bucket is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBucket]);
  const state = transcripts[activeBucket] ?? fallbackState;

  // Existing session picked from the sidebar that this renderer hasn't hydrated
  // yet AND has no localStorage projection (ran headless / on another renderer):
  // `state` is INITIAL_STATE for the frame(s) before the async hydrate effect
  // dispatches, which ChatView would otherwise render as the "新建对话" welcome
  // hero — flashing "new chat" before the real conversation paints. Flag that
  // gap so ChatView shows a loading placeholder instead. A genuine fresh draft
  // has activeSessionId === null (never solidified) and is excluded; a just-sent
  // session already has its user bubble in `transcripts`, so messages.length > 0
  // there and this stays false. (rc.2 "先闪新建页再渲染内容" fix)
  const awaitingHydration =
    activeSessionId !== null &&
    transcripts[activeBucket] === undefined &&
    state.messages.length === 0;

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

  const setBusyForKey = (key: string, val: boolean): void => {
    // Track turn-start time for the manual-stop elapsed line (TODO 2.8).
    if (val) {
      if (!busySinceRef.current.has(key)) busySinceRef.current.set(key, Date.now());
    } else {
      busySinceRef.current.delete(key);
    }
    setBusyKeys((prev) => {
      const had = prev.has(key);
      if (val === had) return prev;
      const next = new Set(prev);
      if (val) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleAddRepo = async (): Promise<void> => {
    window.codeshell.log("sidebar.add_clicked", {});
    const picked = await window.codeshell.pickDir();
    if (!picked) return;
    const dup = repos.find((r) => r.path === picked.path);
    if (dup) {
      unmarkRepoPathRemoved(picked.path);
      setActiveRepoId(dup.id);
      return;
    }
    const next: Repo = {
      id: makeRepoId(),
      name: picked.name,
      path: picked.path,
      addedAt: Date.now(),
    };
    unmarkRepoPathRemoved(next.path);
    setRepos((prev) => [...prev, next]);
    setActiveRepoId(next.id);
    setSessionIndices((prev) => ({
      ...prev,
      [next.id]: loadSessionIndex(next.id),
    }));
    // Persist to disk (source of truth). The projects:changed echo re-projects
    // and, because the path now matches our cache, keeps this same repoId.
    void window.codeshell.projects.add({ path: next.path, name: next.name });
    window.codeshell.log("repo.added", { id: next.id, path: next.path });
  };

  const handleRemoveRepo = (id: string): void => {
    const repo = repos.find((r) => r.id === id);
    if (repo) {
      markRepoPathRemoved(repo.path);
      // Soft-delete on disk so the removal persists + reaches phones live.
      void window.codeshell.projects.remove(repo.path);
    }
    // Archive (don't orphan) the project's sessions: persist every session as
    // archived + stamp the project label so they remain visible/restorable in
    // 设置→高级→已归档 under their original project name. The project row still
    // leaves the sidebar (the sidebar iterates `repos`), but the conversations
    // survive instead of silently vanishing from localStorage.
    const archived = repo
      ? archiveAllSessions(id, repoLabel(repo))
      : undefined;
    setRepos((prev) => prev.filter((r) => r.id !== id));
    if (activeRepoId === id) setActiveRepoId(null);
    setSessionIndices((prev) => {
      // Keep the index in state (now all-archived) so the archived view can
      // list them; drop it only if there was nothing to archive.
      if (!archived) {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: archived };
    });
    window.codeshell.log("repo.removed", { id });
  };

  const handleToggleRepo = (id: string): void => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePinRepo = (id: string, pinned: boolean): void => {
    const repo = repos.find((r) => r.id === id);
    setRepos((prev) => prev.map((r) => (r.id === id ? { ...r, pinned } : r)));
    if (repo) void window.codeshell.projects.setPinned(repo.path, pinned);
  };

  const handleRenameRepo = (id: string, name: string): void => {
    setRepos((prev) => prev.map((r) => (r.id === id ? { ...r, displayName: name } : r)));
  };

  const handleArchiveAllSessions = (id: string): void => {
    setSessionIndices((prev) => {
      const idx = prev[id];
      if (!idx) return prev;
      // Mutate every session via archiveSession() so the localStorage
      // index stays consistent with state.
      let working = idx;
      for (const s of idx.sessions) {
        if (!s.archived) working = archiveSession(id, s.id, true);
      }
      return { ...prev, [id]: working };
    });
  };

  /**
   * "新对话" anchored to a specific repo (used by the row's pen icon).
   * Switches active repo if needed, then enters draft state.
   */
  const handleNewConversationForRepo = (repoId: string | null): void => {
    if (activeRepoId !== repoId) setActiveRepoId(repoId);
    setSessionIndices((prev) => ({
      ...prev,
      [repoKeyOf(repoId)]: setActiveSession(repoId, null),
    }));
    // A fresh draft must start from the default permission/goal — clear the
    // shared per-repo "_none_" draft slot so a previous draft's choice doesn't
    // carry over (it's a single slot shared by all drafts in this repo). (#11)
    const draftBucket = bucketKey(repoId, null);
    setPermissionOverrides((prev) => clearBucketOverride(prev, draftBucket));
    setGoalOverrides((prev) => clearBucketOverride(prev, draftBucket));
    // Same for model: a new draft starts on the global default, not the
    // previous draft's per-bucket pick.
    setModelOverrides((prev) => clearBucketOverride(prev, draftBucket));
    // Panels too: the draft "_none_" slot is shared by every draft in this
    // repo, so a previous draft's open panels would otherwise carry into the
    // fresh conversation. Wipe the persisted slot AND reset the in-memory
    // panel state — the restore effect only re-runs when `activeBucket`
    // changes, which it won't if we're already in the draft bucket.
    clearPanelState(draftBucket);
    setPanelByBucket((prev) => ({ ...prev, [draftBucket]: emptyPanelBucketState() }));
    setView((v) => ({ ...v, viewMode: "chat" }));
  };

  const handleSelectSession = (repoId: string | null, sessionId: string): void => {
    const key = repoKeyOf(repoId);
    // Selecting a session clears its unread mark — the user is now looking at it.
    const selectedBucket = bucketKey(repoId, sessionId);
    setUnreadBuckets((prev) => {
      if (!prev.has(selectedBucket)) return prev;
      const next = new Set(prev);
      next.delete(selectedBucket);
      return next;
    });
    setActiveRepoId(repoId);
    setSessionIndices((prev) => ({
      ...prev,
      [key]: setActiveSession(repoId, sessionId),
    }));
    // Make sure we're looking at chat, not settings, when the user
    // explicitly picks a session.
    setView((v) => ({ ...v, viewMode: "chat" }));
  };

  const findSessionByEngineId = (engineSessionId: string): { repoId: string | null; session: SessionSummary } | null => {
    const reposNow = loadRepos();
    for (const repoId of [null as string | null, ...reposNow.map((r) => r.id)]) {
      const session = loadSessionIndex(repoId).sessions.find(
        (s) => s.engineSessionId === engineSessionId || s.id === engineSessionId,
      );
      if (session) return { repoId, session };
    }
    return null;
  };

  const resolveProjectCwd = async (cwd: string): Promise<string> => {
    if (!cwd) return cwd;
    try {
      return (await window.codeshell.projects.resolveRoot(cwd)).path;
    } catch {
      return cwd;
    }
  };

  const handleOpenAutomationRunSession = async (run: RunSummary): Promise<void> => {
    if (!run.sessionId) {
      setRunsInitialRunId(run.runId);
      setViewMode("runs");
      return;
    }

    const existing = findSessionByEngineId(run.sessionId);
    if (existing) {
      handleSelectSession(existing.repoId, existing.session.id);
      return;
    }

    const reposNow = loadRepos();
    const touchedRepoIds = new Set<string | null>();
    const repoFactory = makeCreateRepoForCwd(reposNow);
    await importAutomationRuns(
      [{
        runId: run.runId,
        sessionId: run.sessionId,
        cwd: await resolveProjectCwd(run.cwd),
        objective: run.objective,
        status: run.status,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        source: "automation",
        cronJobName: run.cronJobName,
      }],
      reposNow,
      {
        caseInsensitive: isCaseInsensitivePlatform(),
        existingEngineSessionIds: new Set(),
        cap: 1,
        fetchTranscript: (sid) => window.codeshell.getSessionTranscript(sid),
        createRepoForCwd: repoFactory.createRepoForCwd,
        writeImported: (repoId, summary, state) => {
          saveTranscript(repoId, summary.id, state);
          upsertImportedSession(repoId, summary);
          touchedRepoIds.add(repoId);
        },
      },
    );

    if (repoFactory.changed()) setRepos(reposNow.slice());
    if (touchedRepoIds.size > 0) {
      setSessionIndices((prev) => {
        const next = { ...prev };
        for (const rid of touchedRepoIds) next[repoKeyOf(rid)] = loadSessionIndex(rid);
        return next;
      });
    }

    const imported = findSessionByEngineId(run.sessionId);
    if (imported) handleSelectSession(imported.repoId, imported.session.id);
    else {
      setRunsInitialRunId(run.runId);
      setViewMode("runs");
    }
  };

  const handleOpenAutomationDiskSession = async (session: DiskSessionMeta): Promise<void> => {
    const existing = findSessionByEngineId(session.engineSessionId);
    if (existing) {
      handleSelectSession(existing.repoId, existing.session.id);
      return;
    }

    const reposNow = loadRepos();
    const repoFactory = makeCreateRepoForCwd(reposNow);
    const resolvedSession: DiskSessionMeta = {
      ...session,
      cwd: await resolveProjectCwd(session.cwd),
    };
    const [placement] = planDiskRebuild([resolvedSession], reposNow, {
      caseInsensitive: isCaseInsensitivePlatform(),
      createRepoForCwd: repoFactory.createRepoForCwd,
    });
    if (!placement) return;

    let state: MessagesReducerState;
    try {
      state = foldTranscript(await window.codeshell.getSessionTranscript(session.engineSessionId));
    } catch {
      state = foldTranscript([]);
    }
    saveTranscript(placement.repoId, placement.summary.id, state);
    const nextIdx = upsertImportedSession(placement.repoId, placement.summary);

    if (repoFactory.changed()) setRepos(reposNow.slice());
    setSessionIndices((prev) => ({
      ...prev,
      [repoKeyOf(placement.repoId)]: nextIdx,
    }));
    handleSelectSession(placement.repoId, placement.summary.id);
  };

  /**
   * Enter draft state: clear activeSessionId so chat shows the welcome
   * surface and no empty stub appears in the session list. A real
   * session row only materializes when the user sends the first message
   * (see `send` → ensureActiveSession + touchSession).
   */
  const handleNewConversation = (): void => {
    const repoId = activeRepoId;
    setSessionIndices((prev) => ({
      ...prev,
      [repoKeyOf(repoId)]: setActiveSession(repoId, null),
    }));
    // Reset the shared per-repo draft panel slot so a previous draft's open
    // panels don't carry into this fresh conversation (see the longer note in
    // handleNewConversationForRepo — same reasoning, same in-memory reset).
    const draftBucket = bucketKey(repoId, null);
    clearPanelState(draftBucket);
    setPanelByBucket((prev) => ({ ...prev, [draftBucket]: emptyPanelBucketState() }));
    setView((v) => ({ ...v, viewMode: "chat" }));
  };

  const handleRenameSession = (
    repoId: string | null,
    sessionId: string,
    title: string,
  ): void => {
    const next = renameSessionLocal(repoId, sessionId, title, true);
    setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));
  };

  const handleArchiveSession = (
    repoId: string | null,
    sessionId: string,
    archived: boolean,
  ): void => {
    const next = archiveSession(repoId, sessionId, archived);
    setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));
  };

  const handleDeleteSession = (
    repoId: string | null,
    sessionId: string,
  ): void => {
    // Capture source/runId BEFORE wiping the local entry — needed to also
    // remove the on-disk session + run dirs.
    const summary = sessionIndices[repoKeyOf(repoId)]?.sessions.find((s) => s.id === sessionId);
    const next = deleteSessionLocal(repoId, sessionId);
    setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));

    // Drop the deleted session's panel state so its (hidden) PanelArea — and the
    // browser <webview> / terminal pty it keeps mounted — is torn down instead of
    // leaking, and its persisted layout doesn't linger in localStorage.
    const deletedBucket = bucketKey(repoId, sessionId);
    clearPanelState(deletedBucket);
    setPanelByBucket((prev) => {
      if (!(deletedBucket in prev)) return prev;
      const rest = { ...prev };
      delete rest[deletedBucket];
      return rest;
    });

    // Delete means delete: EVERY session (not just automation) must have its
    // on-disk dir removed and its background shells reaped, else
    // ~/.code-shell/sessions/<id>/ + orphan shells leak. The `sessions:delete`
    // IPC does closeSession(reap shells) → deleteSession(rm dir) → forgetSession.
    // Automation additionally cancels the in-flight run first (so it stops
    // rewriting the dir we're about to delete) and clears any legacy run dir.
    const plan = planSessionDeletion(summary ?? { id: sessionId, title: "", createdAt: 0, updatedAt: 0 });
    void (async () => {
      if (plan.cancelCronJobId) {
        await window.codeshell.cancelAutomationRun(plan.cancelCronJobId).catch((e) =>
          window.codeshell.log("session.delete.cancel.failed", { cronJobId: plan.cancelCronJobId, error: String(e) }),
        );
      }
      await window.codeshell.deleteSession(plan.deleteEngineId).catch((e) =>
        window.codeshell.log("session.delete.session.failed", { engineId: plan.deleteEngineId, error: String(e) }),
      );
      // deleteRun is a no-op for current jobs (which write sessions/, not
      // runs/), but still clears legacy RunManager-era run dirs.
      if (plan.deleteRunId) {
        await window.codeshell.deleteRun(plan.deleteRunId).catch((e) =>
          window.codeshell.log("session.delete.run.failed", { runId: plan.deleteRunId, error: String(e) }),
        );
      }
    })();
  };

  useEffect(() => {
    const coalescers = coalescersRef.current;
    return () => {
      for (const c of coalescers.values()) c.dispose();
      coalescers.clear();
    };
  }, []);

  // Backfill automation runs from disk into the sidebar on startup. Disk is
  // the source of truth; localStorage is our projection. Runs are deduped by
  // engineSessionId and capped to the 50 most-recent per project. Re-running
  // is safe (idempotent) because upsertImportedSession keys on engineSessionId.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let runs: ImportableRun[];
      try {
        const raw = await window.codeshell.listRuns();
        runs = raw.map((r) => ({
          runId: r.runId,
          sessionId: r.sessionId,
          cwd: r.cwd,
          objective: r.objective,
          status: r.status,
          finishedAt: r.finishedAt,
          createdAt: r.createdAt,
          source: r.source,
          cronJobName: r.cronJobName,
        }));
      } catch {
        return; // no runs dir / read error — nothing to backfill
      }
      if (cancelled || runs.length === 0) return;
      runs = await Promise.all(
        runs.map(async (r) => ({ ...r, cwd: await resolveProjectCwd(r.cwd) })),
      );
      if (cancelled) return;

      // Known engineSessionIds across every repo index (manual + already-imported).
      // A still-running automation import is intentionally NOT counted, so the
      // next backfill re-imports it once it completes and upsertImportedSession
      // overwrites the partial transcript in place. Manual sessions and
      // completed/failed/cancelled imports dedupe normally.
      const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);
      const dedupable = (s: SessionSummary): boolean =>
        s.source !== "automation" || !s.runStatus || TERMINAL_RUN.has(s.runStatus);
      const currentRepos = loadRepos();
      const known = new Set<string>();
      for (const r of currentRepos) {
        for (const s of loadSessionIndex(r.id).sessions) {
          if (s.engineSessionId && dedupable(s)) known.add(s.engineSessionId);
        }
      }
      for (const s of loadSessionIndex(null).sessions) {
        if (s.engineSessionId && dedupable(s)) known.add(s.engineSessionId);
      }

      const touchedRepoIds = new Set<string | null>();
      const repoFactory = makeCreateRepoForCwd(currentRepos);
      await importAutomationRuns(runs, currentRepos, {
        caseInsensitive: isCaseInsensitivePlatform(),
        existingEngineSessionIds: known,
        cap: 50,
        fetchTranscript: (sid) => window.codeshell.getSessionTranscript(sid),
        createRepoForCwd: repoFactory.createRepoForCwd,
        writeImported: (repoId, summary, state) => {
          saveTranscript(repoId, summary.id, state);
          upsertImportedSession(repoId, summary);
          touchedRepoIds.add(repoId);
        },
      });
      if (cancelled) return;

      if (repoFactory.changed()) setRepos(currentRepos.slice());
      if (touchedRepoIds.size > 0) {
        setSessionIndices((prev) => {
          const next = { ...prev };
          for (const rid of touchedRepoIds) next[repoKeyOf(rid)] = loadSessionIndex(rid);
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Rebuild an empty repo's session list from disk (localStorage cleared/lost).
  // Only when the active repo's index is empty → no disk scan otherwise. Mirrors
  // D1's automation placement: match disk cwd → repo, auto-create on miss.
  useEffect(() => {
    const repoKey = repoKeyOf(activeRepoId);
    const idx = sessionIndices[repoKey];
    if (idx && idx.sessions.length > 0) return; // has data → don't scan disk
    if (diskProbedRef.current.has(repoKey)) return; // already scanned for this repo
    diskProbedRef.current.add(repoKey);
    let cancelled = false;
    let probed = false; // disk read resolved (with or without sessions)
    void (async () => {
      try {
        const page = await window.codeshell.listDiskSessions({ limit: 30 });
        probed = true;
        if (cancelled || page.sessions.length === 0) return;
        const sessions = await Promise.all(
          page.sessions.map(async (s) => ({ ...s, cwd: await resolveProjectCwd(s.cwd) })),
        );
        if (cancelled) return;
        const reposNow = loadRepos();
        const repoFactory = makeCreateRepoForCwd(reposNow);
        const placements = planDiskRebuild(sessions, reposNow, {
          caseInsensitive: isCaseInsensitivePlatform(),
          createRepoForCwd: repoFactory.createRepoForCwd,
        });
        if (cancelled) return;
        const touched = new Set<string>();
        for (const { repoId, summary } of placements) {
          upsertImportedSession(repoId, summary);
          touched.add(repoKeyOf(repoId));
        }
        if (repoFactory.changed()) setRepos(reposNow.slice());
        setSessionIndices((prev) => {
          const next = { ...prev };
          for (const k of touched) next[k] = loadSessionIndex(k === GLOBAL_KEY ? null : k);
          return next;
        });
      } catch {
        // disk unavailable — leave empty and allow a later retry for this repo.
        diskProbedRef.current.delete(repoKey);
      }
    })();
    return () => {
      cancelled = true;
      // If we tore down before the disk read resolved, drop the mark so a
      // future visit can retry. A completed probe keeps its mark — that's what
      // breaks the re-scan loop when a page maps only into other repos.
      if (!probed) diskProbedRef.current.delete(repoKey);
    };
  }, [activeRepoId, sessionIndices]);

  function getCoalescer(bucket: string) {
    let c = coalescersRef.current.get(bucket);
    if (!c) {
      c = createEventCoalescer((events) =>
        dispatch({ type: "stream_batch", bucket, events }),
      );
      coalescersRef.current.set(bucket, c);
    }
    return c;
  }

  useEffect(() => {
    window.codeshell.log("app.mount", { codeshellKeys: Object.keys(window.codeshell ?? {}) });

    const offStream = window.codeshell.onStreamEvent((env: StreamEventEnvelope) => {
      const event = env.event;
      if (event.type === "background_agent_completed") {
        toast({
          message: bgCompletionText(event),
          variant: event.status === "completed" ? "success" : "error",
        });
        // fall through: the reducer still appends the system message below.
      }
      // Multi-session routing: every envelope carries the engine sessionId.
      // We mirror engineSessionId → bucket in a ref so stream events route to
      // the right tab even when several runs are in flight at once. Fallback
      // to the single runningBucketRef only for legacy / pre-bind events
      // (engineSessionId empty or not yet in the table).
      // Route the event to its UI bucket. On a route-table miss (e.g. after a
      // renderer remount wiped the in-memory table while a worker kept resuming
      // the same engine session), resolveBucket reverse-looks-up the engine
      // sessionId in the on-disk indices instead of dropping the event.
      const target = resolveBucket(
        env.sessionId ?? "",
        engineToBucketRef.current,
        sessionIndicesRef.current,
        runningBucketRef.current,
      );
      if (!target) {
        if ((event.type === "turn_complete" || event.type === "error") && !event.agentId) {
          const runningBucket = runningBucketRef.current;
          if (runningBucket) {
            setBusyForKey(runningBucket, false);
            runningBucketRef.current = null;
          }
        }
        return;
      }
      // Backfill the route table so subsequent events for this session take the
      // fast path (and so turn_complete/error below can clear the right bucket).
      if (env.sessionId && !engineToBucketRef.current.has(env.sessionId)) {
        engineToBucketRef.current.set(env.sessionId, target);
      }

      // steer_injected: the engine just spliced a queued draft into the running
      // turn. Now (and only now) remove it from the panel — the coalescer will
      // also feed this event to the reducer, which renders it as a user bubble.
      // This is the insert-time ↔ display-time decoupling: the item was visible
      // and revocable until this confirmation arrived.
      if (event.type === "steer_injected" && event.id) {
        const id = event.id;
        injectedSteerIdsRef.current.add(id);
        steeredIdsRef.current.delete(id);
        setQueuedInputs((prev) => removeQueuedInputById(prev, target, id));
      }

      const noisy =
        event.type === "text_delta" ||
        event.type === "tool_use_args_delta" ||
        event.type === "usage_update" ||
        event.type === "thinking_delta";
      if (!noisy) {
        window.codeshell.log("stream.event", {
          type: event.type,
          bucket: target,
          engineSessionId: env.sessionId || null,
        });
      }
      getCoalescer(target).push(event);

      // session_started carries the authoritative engine sessionId. Persist
      // the binding (engineSessionId == uiSessionId is the new normal, but
      // older sessions on disk may differ) and seed the routing table.
      if (event.type === "session_started") {
        // session_started fires once at the start of every run() — including a
        // run the renderer DIDN'T initiate, e.g. core waking an idle session
        // when a background shell (download) finishes. The send() path already
        // set busy (idempotent here); but a core-initiated wakeup never went
        // through send(), so this is the only point the composer learns "a turn
        // is now running" and shows the working spinner. turn_complete (below)
        // clears it. (session_started carries no agentId, so it's always the
        // top-level run, never a sub-agent.)
        setBusyForKey(target, true);
        const sep = target.indexOf("::");
        if (sep > 0) {
          const repoKey = target.slice(0, sep);
          const uiSessionId = target.slice(sep + 2);
          const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
          if (uiSessionId && uiSessionId !== "_none_") {
            engineToBucketRef.current.set(event.sessionId, target);
            const nextIdx = bindEngineSession(repoId, uiSessionId, event.sessionId);
            setSessionIndices((prev) => ({ ...prev, [repoKey]: nextIdx }));
          }
        }
      }

      // session_title: LLM-generated sidebar title (first turn only).
      // Reuse the session_started bucket-parse pattern. Never clobber a
      // manual rename (titleManual flag set by handleRenameSession).
      if (event.type === "session_title") {
        const sep = target.indexOf("::");
        if (sep > 0) {
          const repoKey = target.slice(0, sep);
          const uiSessionId = target.slice(sep + 2);
          const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
          if (uiSessionId && uiSessionId !== "_none_") {
            setSessionIndices((prev) => {
              const cur = prev[repoKey]?.sessions.find((s) => s.id === uiSessionId);
              if (!cur || cur.titleManual) return prev; // never clobber manual rename
              const next = renameSessionLocal(repoId, uiSessionId, event.title);
              return { ...prev, [repoKey]: next };
            });
          }
        }
      }

      // A *sub-agent's* turn_complete / error carries an agentId (engine.ts
      // injects it into every child stream event). It must NOT clear the main
      // bucket's busy flag, mark it unread, or terminate the automation run —
      // the parent turn is still running and will emit its own (agentId-less)
      // turn_complete when it actually finishes. Treating the child's
      // turn_complete as the parent's flipped the top-bar/sidebar to "完成"
      // (idle) mid-run while the agent kept working. The per-agent card's own
      // done state is handled separately in the reducer via `agent_end`.
      if ((event.type === "turn_complete" || event.type === "error") && !event.agentId) {
        setBusyForKey(target, false);
        // A turn just finished → its file edits have landed on disk. Nudge the
        // Files panel to re-read the file it's previewing (and refresh its
        // tree): the panel reads a file once on select and otherwise never sees
        // external writes, so an AI edit to the open file would show stale until
        // re-selected. Fire-and-forget DOM event (same channel style as
        // codeshell:open-file); FilesPanel decides whether it's viewing an
        // affected path.
        window.dispatchEvent(new CustomEvent("codeshell:files-changed"));
        // A turn finished in a bucket the user is NOT looking at → mark unread
        // so the sidebar shows a dot. Read the active bucket from the ref (not
        // a captured `activeBucket`): this onStreamEvent callback is registered
        // once and would otherwise close over a stale value.
        if (target !== activeBucketRef.current) {
          setUnreadBuckets((prev) => {
            if (prev.has(target)) return prev;
            const next = new Set(prev);
            next.add(target);
            return next;
          });
        }
        // Don't null runningBucketRef here — another concurrent send may
        // still be using it as a fallback. The ref is only a soft hint;
        // engineToBucketRef is the authoritative routing for in-flight runs.

        // Flip a live automation session's runStatus from its frozen "running"
        // to a terminal state. Without this it stays "running" forever, which
        // (a) makes delete treat a long-finished run as in-flight, and (b)
        // keeps it out of the backfill dedup skip-set. Find the owning session
        // by engineSessionId (== local id for automation imports) and update it.
        if (env.sessionId) {
          const eid = env.sessionId;
          const reposNow = loadRepos();
          for (const rid of [null as string | null, ...reposNow.map((r) => r.id)]) {
            const owner = loadSessionIndex(rid).sessions.find(
              (s) => s.source === "automation" && s.engineSessionId === eid,
            );
            if (owner) {
              const nextIdx = updateSessionRunStatus(
                rid,
                owner.id,
                event.type === "error" ? "failed" : "completed",
              );
              setSessionIndices((prev) => ({ ...prev, [repoKeyOf(rid)]: nextIdx }));
              break;
            }
          }
        }
      }
    });
    // Live automation session: main announces {sessionId, cwd, title} once when
    // an in-main automation run emits session_started. Stream events carry no
    // cwd, so without this the run can't be attributed to a project until the
    // next startup disk-backfill. We create the sidebar session immediately
    // (reusing the source:"automation" import machinery) and register the route
    // so this run's subsequent stream events land in the right bucket.
    const offAutomationSession = window.codeshell.onAutomationSession((meta) => {
      window.codeshell.log("automation.session.announce", {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
      });
      // Idempotency: if any repo already has this engine session (a prior
      // announce, or a disk-backfilled import), don't duplicate.
      const reposNow = loadRepos();
      const alreadyKnown =
        [null as string | null, ...reposNow.map((r) => r.id)].some((rid) =>
          loadSessionIndex(rid).sessions.some(
            (s) => s.engineSessionId === meta.sessionId,
          ),
        );
      if (alreadyKnown) {
        // Still (re)register the route in case the table was wiped by a remount.
        const knownRepoId =
          [null as string | null, ...reposNow.map((r) => r.id)].find((rid) =>
            loadSessionIndex(rid).sessions.some(
              (s) => s.engineSessionId === meta.sessionId,
            ),
          ) ?? null;
        engineToBucketRef.current.set(
          meta.sessionId,
          bucketKey(knownRepoId, meta.sessionId),
        );
        return;
      }
      void (async () => {
        const resolvedMeta = {
          ...meta,
          cwd: await resolveProjectCwd(meta.cwd),
        };
        const reposAfterResolve = loadRepos();
        const existingRepoId =
          [null as string | null, ...reposAfterResolve.map((r) => r.id)].find((rid) =>
            loadSessionIndex(rid).sessions.some(
              (s) => s.engineSessionId === meta.sessionId,
            ),
          );
        if (existingRepoId !== undefined) {
          engineToBucketRef.current.set(
            meta.sessionId,
            bucketKey(existingRepoId, meta.sessionId),
          );
          return;
        }
        const repoFactory = makeCreateRepoForCwd(reposAfterResolve);
        const placement = placeLiveAutomationSession(resolvedMeta, reposAfterResolve, {
          caseInsensitive: isCaseInsensitivePlatform(),
          createRepoForCwd: repoFactory.createRepoForCwd,
        });
        if (!placement) return;
        const { repoId, summary } = placement;
        const nextIdx = upsertImportedSession(repoId, summary);
        const bucket = bucketKey(repoId, summary.id);
        // Register the route so this run's stream events (already arriving) bucket
        // correctly. The session_started handler's reverse-lookup would also find
        // it now that it's on disk, but setting the fast path is cheap.
        engineToBucketRef.current.set(meta.sessionId, bucket);
        // Mark the bucket busy NOW so the sidebar shows the running spinner
        // immediately. Automation never goes through send() (it runs headless in
        // main), so without this the run-now session would sit with no status
        // indicator until — and only ever — turn_complete, which then clears busy
        // and (if off-screen) flips it to the unread dot. The announce arrives
        // before this run's session_started stream event (automation-host emits
        // onSession() then emit() on the same ordered channel), so no turn_complete
        // can clear this before we set it. asking>running>unread precedence then
        // matches interactive chat.
        setBusyForKey(bucket, true);
        // Show the triggering prompt as the opening user message. Automation never
        // goes through send() (it runs in main), so without this the live UI would
        // open straight into the assistant's reply with no visible question. Only
        // on first placement (re-announce hits the alreadyKnown early-return above),
        // so the bubble isn't duplicated.
        if (meta.prompt.trim()) {
          dispatch({ type: "user_message", bucket, text: meta.prompt });
        }
        if (repoFactory.changed()) setRepos(reposAfterResolve.slice());
        setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: nextIdx }));
      })();
    });
    const offMobileSession = window.codeshell.onMobileSession((meta) => {
      window.codeshell.log("mobile.session.announce", {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
      });
      const reposNow = loadRepos();
      const knownRepoId =
        [null as string | null, ...reposNow.map((r) => r.id)].find((rid) =>
          loadSessionIndex(rid).sessions.some(
            (s) => s.engineSessionId === meta.sessionId || s.id === meta.sessionId,
          ),
        ) ?? undefined;
      const known =
        knownRepoId !== undefined
          ? loadSessionIndex(knownRepoId).sessions.find(
              (s) => s.engineSessionId === meta.sessionId || s.id === meta.sessionId,
            )
          : undefined;

      let repoId: string | null;
      let sessionId: string;
      let nextIdx: SessionIndex;
      const title = titleFromWire(meta.prompt || meta.title || meta.sessionId);

      if (known) {
        repoId = knownRepoId ?? null;
        sessionId = known.id;
        nextIdx = touchSession(repoId, sessionId, title);
      } else {
        const repoFactory = makeCreateRepoForCwd(reposNow);
        const now = Date.now();
        const [placement] = planDiskRebuild(
          [{
            id: meta.sessionId,
            engineSessionId: meta.sessionId,
            cwd: meta.cwd,
            title,
            updatedAt: now,
            origin: "desktop",
          }],
          reposNow,
          {
            caseInsensitive: isCaseInsensitivePlatform(),
            createRepoForCwd: repoFactory.createRepoForCwd,
          },
        );
        if (!placement) return;
        repoId = placement.repoId;
        sessionId = placement.summary.id;
        nextIdx = upsertImportedSession(repoId, {
          ...placement.summary,
          title,
          createdAt: now,
          updatedAt: now,
        });
        if (repoFactory.changed()) setRepos(reposNow.slice());
      }

      const bucket = bucketKey(repoId, sessionId);
      engineToBucketRef.current.set(meta.sessionId, bucket);
      setBusyForKey(bucket, true);
      if (meta.prompt.trim()) dispatch({ type: "user_message", bucket, text: meta.prompt });
      setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: nextIdx }));
    });
    const offApproval = window.codeshell.onApprovalRequest((env: ApprovalRequestEnvelope) => {
      window.codeshell.log("approval.request", {
        requestId: env.requestId,
        toolName: env.request.toolName,
        engineSessionId: env.sessionId ?? null,
      });
      // AskUserQuestion is delivered through the same channel as tool
      // approvals (toolName === "__ask_user__"). Route it into the chat
      // stream as an inline AskUserMessage instead of the approval modal
      // so the user picks an answer inline — much less disruptive than
      // a blocking dialog.
      if (env.request.toolName === "__ask_user__") {
        const args = (env.request.args ?? {}) as Record<string, unknown>;
        const question =
          (typeof args.question === "string" && args.question) ||
          env.request.description ||
          "";
        const header = typeof args.header === "string" ? args.header : undefined;
        const multiSelect = args.multiSelect === true;
        const optionsOnly = args.optionsOnly === true;
        const options =
          Array.isArray(args.options)
            ? (args.options as unknown[])
                .filter(
                  (o): o is { label: string; description: string; tone?: unknown } =>
                    !!o &&
                    typeof o === "object" &&
                    typeof (o as Record<string, unknown>).label === "string" &&
                    typeof (o as Record<string, unknown>).description === "string",
                )
                .map((o): AskUserOption => {
                  const tone: AskUserOption["tone"] =
                    o.tone === "ok" || o.tone === "danger" || o.tone === "neutral"
                      ? o.tone
                      : undefined;
                  return { label: o.label, description: o.description, ...(tone ? { tone } : {}) };
                })
            : undefined;
        // Resolve the ORIGINATING session's bucket via the shared resolver
        // (live table → on-disk index reverse lookup → runningBucket only when
        // there's no sessionId). When a sessionId is present but unresolvable
        // (cold table + not yet in the index), fall back to the active bucket so
        // the user still sees the prompt, but warn — and either way carry
        // env.sessionId on the message so the ANSWER routes back to the right
        // session regardless of which bucket rendered it.
        const resolved = resolveBucket(
          env.sessionId ?? "",
          engineToBucketRef.current,
          sessionIndicesRef.current,
          runningBucketRef.current,
        );
        if (env.sessionId && !resolved) {
          console.warn(
            "[ask_user] could not resolve bucket for session; rendering in active bucket",
            env.sessionId,
          );
        }
        const bucket = resolved ?? activeBucketRef.current;
        dispatch({
          type: "ask_user",
          bucket,
          requestId: env.requestId,
          engineSessionId: env.sessionId,
          question,
          header,
          options,
          multiSelect,
          optionsOnly,
        });
        return;
      }
      // 完全访问权限 (bypass): auto-approve any request that reaches the
      // renderer for this bucket. The engine's bypassPermissions backend
      // already approves everything, so requests rarely surface here; this
      // is belt-and-braces so "full access" never silently blocks on a
      // modal. Resolve the request's OWN bucket (not the active one) —
      // concurrent runs may target a different tab.
      const resolved = resolveBucket(
        env.sessionId ?? "",
        engineToBucketRef.current,
        sessionIndicesRef.current,
        runningBucketRef.current,
      );
      if (env.sessionId && !resolved) {
        console.warn(
          "[approval] could not resolve bucket for session; rendering in active bucket",
          env.sessionId,
        );
      }
      const targetBucket = resolved ?? activeBucketRef.current;
      if (permissionForBucketRef.current(targetBucket) === "bypass") {
        if (env.sessionId) {
          void window.codeshell.approve(env.sessionId, env.requestId, "approve");
        } else {
          void window.codeshell.approve(env.requestId, "approve");
        }
        void window.codeshell.mobileRemote.notifyApprovalResolved({
          requestId: env.requestId,
          sessionId: env.sessionId,
          approved: true,
        });
        return;
      }
      approvalBucketsRef.current.set(env.requestId, targetBucket);
      setApprovalQueue((q) => [...q, env]);
      setApproval((cur) => cur ?? env);
    });
    const offApprovalResolved = window.codeshell.onApprovalResolved((env: ApprovalResolvedEnvelope) => {
      if (!env.requestId) return;
      approvalBucketsRef.current.delete(env.requestId);
      setApprovalQueue((prev) => {
        const remaining = prev.filter((e) => e.requestId !== env.requestId);
        setApproval((cur) => {
          if (!cur || cur.requestId === env.requestId) return remaining[0] ?? null;
          return cur;
        });
        return remaining;
      });
    });
    const offMobilePermissionMode = window.codeshell.onMobilePermissionMode(
      (env: MobilePermissionModeEnvelope) => {
        if (!env.sessionId) return;
        const bucketFromRoute =
          engineToBucketRef.current.get(env.sessionId) ||
          resolveBucket(
            env.sessionId,
            engineToBucketRef.current,
            sessionIndicesRef.current,
            runningBucketRef.current,
          );
        let bucket = bucketFromRoute;
        if (!bucket) {
          for (const [repoKey, index] of Object.entries(sessionIndicesRef.current)) {
            const summary = index.sessions.find((s) => s.id === env.sessionId);
            if (summary) {
              bucket = bucketKey(repoKey === GLOBAL_KEY ? null : repoKey, summary.id);
              break;
            }
          }
        }
        if (!bucket) return;
        const mode = fromMobilePermissionMode(env.mode);
        setPermissionOverrides((prev) => {
          if (mode === defaultPermissionModeRef.current) {
            const { [bucket]: _removed, ...rest } = prev;
            return rest;
          }
          return { ...prev, [bucket]: mode };
        });
      },
    );
    const offStatus = window.codeshell.onStatus((evt) => {
      window.codeshell.log("status", evt as Record<string, unknown>);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      window.codeshell.log("lifecycle", evt as Record<string, unknown>);
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        if (evt.code === 0) setLifecycle(null);
        else setLifecycle(`Agent exited (code ${evt.code}).`);
        // Worker died — every in-flight run is dead with it. Clear busy
        // for *all* buckets we have routes for, not just the latest ref.
        const inflight = Array.from(engineToBucketRef.current.values());
        if (inflight.length > 0) {
          setBusyKeys((prev) => {
            const next = new Set(prev);
            for (const b of inflight) next.delete(b);
            return next;
          });
        }
        runningBucketRef.current = null;
        // Do NOT clear engineToBucketRef here. The worker exits cleanly after
        // every run (and may later respawn + resume the same engine session),
        // so wiping the route table on exit is exactly what made resumed-
        // session events miss their bucket and get dropped (blank UI). The
        // bucket↔session bindings belong to the session, not the worker
        // lifecycle, and are safe to keep — resolveBucket reconciles against
        // on-disk indices anyway.
      }
    });
    return () => {
      offStream();
      offAutomationSession();
      offMobileSession();
      offApproval();
      offApprovalResolved();
      offMobilePermissionMode();
      offStatus();
      offLifecycle();
    };
    // `toast` from useToast is a stable reference (memoized in ToastProvider),
    // so listing it here does not re-register these long-lived IPC listeners.
  }, [toast]);

  const send = (
    text: string,
    sendOpts: { bucket?: string; clientMessageId?: string } = {},
  ): Promise<void> => {
    // createSession persists to localStorage synchronously, so reading
    // it back via touchSession() right after sees the new entry.
    const parsedBucket = sendOpts.bucket ? parsePanelBucket(sendOpts.bucket) : null;
    const targetRepoId = parsedBucket ? parsedBucket.repoId : activeRepoId;
    const targetSessionId = parsedBucket ? parsedBucket.sessionId : activeSessionId;
    const wasDraft = targetSessionId === null;
    const sid = targetSessionId ?? ensureActiveSession(targetRepoId);
    const bucket = bucketKey(targetRepoId, sid);
    const repoKey = repoKeyOf(targetRepoId);
    const targetRepo = repos.find((r) => r.id === targetRepoId) ?? null;
    const sendPermissionMode = permissionOverrides[bucket] ?? defaultPermissionMode;
    const sendGoalEnabled = goalOverrides[bucket] ?? false;
    const sendModelKey = modelOverrides[bucket] ?? defaultActiveModelKey;
    const clientMessageId = sendOpts.clientMessageId ?? newQueuedId();

    // A draft has no sessionId, so its permission/goal overrides were keyed
    // under the SHARED per-repo "_none_" bucket (bucketKey collapses every
    // draft to <repo>::_none_). On the first send the draft solidifies into a
    // real session — migrate the override onto the real bucket so the choice
    // FOLLOWS this session, then clear the shared draft slot so it doesn't
    // "粘连" onto the next 新对话 / other drafts in this repo (#11 per-session
    // permission stickiness).
    if (wasDraft && bucket !== (sendOpts.bucket ?? activeBucket)) {
      const draftBucket = sendOpts.bucket ?? activeBucket;
      setPermissionOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
      setGoalOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
      setModelOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
    }
    // Pin this session's model on its first send. Capturing the model in
    // effect right now means a LATER change to the global default won't drag
    // this (now-existing) session onto a different model. Only seed if the
    // bucket has no explicit override yet — never clobber a deliberate switch.
    if (sendModelKey && modelOverrides[bucket] === undefined) {
      const pinned = sendModelKey;
      setModelOverrides((prev) =>
        prev[bucket] === undefined ? { ...prev, [bucket]: pinned } : prev,
      );
    }

    // Look up any previously-bound engine sessionId for this UI session.
    // Pre-multi-session sessions on disk may have an engineSessionId that
    // differs from the UI sessionId (the old auto-bound flow). For brand
    // new sessions we use the UI sessionId directly as the engine
    // sessionId so the engineToBucket route is populated synchronously.
    const summary =
      sessionIndices[repoKey]?.sessions.find((s) => s.id === sid)
      ?? loadSessionIndex(targetRepoId).sessions.find((s) => s.id === sid);
    const engineSessionId = summary?.engineSessionId ?? sid;

    window.codeshell.log("send", {
      textLen: text.length,
      repo: targetRepo?.name ?? null,
      bucket,
      engineSessionId,
      clientMessageId,
    });
    dispatch({
      type: "user_message",
      bucket,
      text,
      isGoal: sendGoalEnabled && !!text.trim(),
      clientMessageId,
    });
    setBusyForKey(bucket, true);
    runningBucketRef.current = bucket;
    // Register the route NOW so concurrent sends can each find their own
    // bucket. session_started will reinforce this with the same value (or
    // overwrite with the engine-generated id for legacy sessions).
    engineToBucketRef.current.set(engineSessionId, bucket);

    // Touch session: bump updatedAt + adopt first user prompt as title,
    // and persist engineSessionId so future sends in this UI session
    // pass the same value (and the engine resumes the right convo).
    setSessionIndices((prev) => {
      const touched = touchSession(targetRepoId, sid, titleFromWire(text));
      const next = summary?.engineSessionId
        ? touched
        : bindEngineSession(targetRepoId, sid, engineSessionId);
      return { ...prev, [repoKey]: next };
    });

    const opts: {
      cwd?: string;
      sessionId?: string;
      permissionMode?: ReturnType<typeof toCorePermissionMode>;
      goal?: string;
      clientMessageId?: string;
    } = { sessionId: engineSessionId, clientMessageId };
    if (sendPermissionMode !== null) {
      opts.permissionMode = toCorePermissionMode(sendPermissionMode);
    }
    // Pass cwd explicitly in BOTH cases: a real repo → its path; no-repo chat →
    // the no-repo sandbox. Never leave cwd undefined — the long-lived worker
    // would otherwise default to a stale project (see noRepoCwdRef). Falls back
    // to undefined only if the one-time fetch hasn't resolved yet, in which case
    // the core-side stdio worker still defaults to noRepoDir() (defense #2).
    if (targetRepo) opts.cwd = targetRepo.path;
    else if (noRepoCwdRef.current) opts.cwd = noRepoCwdRef.current;
    // Goal mode: this send's prompt IS the goal — the engine runs
    // loop-until-done. Goal text == prompt text (reuses the composer input).
    // Persistent goal (CC /goal): the toggle means "make THIS message a goal".
    // Once sent, core persists it on the session and later bare sends inherit it
    // — so we auto-disable the toggle after establishing the goal. Otherwise a
    // toggle left on would make every follow-up REPLACE the goal with its own
    // text (one active goal per session), which is never what the user wants.
    // The active goal stays visible in the TopBar popover; clear it there.
    if (sendGoalEnabled && text.trim()) {
      opts.goal = text;
      setGoalOverrides((prev) => ({ ...prev, [bucket]: false }));
    }

    // Pin this session's engine to its per-bucket model before the turn. The
    // engine session may have just been created fresh (resume / first send /
    // draft where the user picked a non-default model) on the worker's current
    // model — without this, a session pinned to model A would silently run on
    // the worker default. configure({sessionId,model}) → requestModelSwitch
    // applies immediately when idle, so it lands before the turn starts. Skip
    // when the bucket has no override (it follows the default — no switch needed).
    // Final fallback to `activeModelKey` (= the model the UI currently shows
    // for this session, itself defaulting to the global default). The engine
    // session may have been created on a DIFFERENT model than the UI shows —
    // e.g. the user changed the model from the Settings page (which only
    // updates disk activeKey, not this renderer's per-bucket override) or the
    // worker started on a stale pin. Without this fallback, `bucketModel`
    // could be undefined while the engine quietly runs on its old model — the
    // deepseek-vision rejection bug, where a "switched to gpt-5" session still
    // ran on deepseek-v4-flash and refused the image. Always pin before the
    // turn so the engine matches what the UI claims.
    const bucketModel = modelOverrides[bucket] ?? sendModelKey;
    return runAfterModelSwitch({
      sessionId: engineSessionId,
      model: bucketModel,
      text,
      opts,
      run: window.codeshell.run,
    }).then((r) => {
        // Belt-and-braces: clear busy for THIS run's bucket even if the
        // stream never delivered turn_complete (e.g. error in setup, or
        // the worker shutdown before flushing the event). Use the closed-
        // over `bucket`, not runningBucketRef — concurrent sends may have
        // moved the ref by the time we resolve.
        setBusyForKey(bucket, false);
        if (runningBucketRef.current === bucket) {
          runningBucketRef.current = null;
        }
        window.codeshell.log("run.resolved", {
          bucket,
          result: r as unknown as Record<string, unknown>,
        });
        // Surface early-return failures that never produced a stream. Some
        // RunResult reasons (image_error, model_error, prompt_too_long) are
        // returned by the engine BEFORE any turn starts — no turn_start, no
        // assistant_message, no turn_complete reaches the stream. Without
        // this branch the only trace is `r.text` in the log: busy clears,
        // nothing renders, and it reads as "卡住 / 没反应" (the deepseek-
        // vision rejection bug). Render the engine's human-readable message
        // as a turn_end(error) line in the stream + an error toast.
        const result = r as { reason?: string; text?: string } | null;
        const reason = result?.reason;
        if (
          reason === "image_error" ||
          reason === "model_error" ||
          reason === "prompt_too_long"
        ) {
          const detail = result?.text?.replace(/^ERROR:\s*/, "") || t("misc.app.requestRejected");
          dispatch({ type: "turn_end", bucket, reason: "error", detail });
          toast({ message: detail, variant: "error" });
        }
      })
      .catch((err) => {
        // Server crashed / RPC rejected / non-abort error. Without this
        // the run promise silently rejects, busy never clears, and the
        // composer stays disabled until the user reloads. Cancellation
        // is now reported via a successful RunResult with reason
        // "aborted_streaming" (see protocol/server.ts), so anything
        // reaching here is a real failure worth logging.
        setBusyForKey(bucket, false);
        if (runningBucketRef.current === bucket) {
          runningBucketRef.current = null;
        }
        window.codeshell.log("run.rejected", {
          bucket,
          error: String((err as Error)?.message ?? err),
        });
      });
  };

  useEffect(() => {
    if (!activeSessionId) return;
    const queued = queuedInputs[activeBucket];
    if (!queued || queued.length === 0) return;

    if (busy) {
      // A relay (打断重发) was requested for this bucket: don't steer — the abort
      // is in flight and the !busy branch will drain+re-send once it lands.
      if (relayingBuckets.has(activeBucket)) return;
      // Step-gap steering (默认, 不打断): hand each not-yet-sent queued draft to
      // the engine, which splices it into the running turn at its NEXT step
      // boundary. The item STAYS in the panel (visible + revocable) — it's only
      // removed when the engine's steer_injected event confirms it, at which
      // point it renders as a user bubble. Send each id exactly once.
      const engineSessionId = resolveActiveEngineSessionId();
      if (!engineSessionId) return; // run starting up; re-fires once it resolves
      const bucket = activeBucket;
      for (const item of queued) {
        if (injectedSteerIdsRef.current.has(item.id) || steeredIdsRef.current.has(item.id)) {
          continue;
        }
        steeredIdsRef.current.add(item.id);
        void window.codeshell
          .steer(engineSessionId, item.text, item.id, item.clientMessageId)
          .then((res) => {
            const accepted = (res as { result?: { accepted?: boolean } })?.result?.accepted;
            if (accepted !== false) return;
            if (!steeredIdsRef.current.has(item.id)) return;
            void enqueueSerialTask(downgradeRunQueueRef.current, async () => {
              if (!steeredIdsRef.current.has(item.id)) return;
              steeredIdsRef.current.delete(item.id);
              injectedSteerIdsRef.current.delete(item.id);
              setQueuedInputs((prev) => removeQueuedInputById(prev, bucket, item.id));
              dispatch({ type: "remove_pending_steers", bucket, steerIds: [item.id] });
              window.codeshell.log("steer.idle_downgrade.run_started", {
                bucket,
                engineSessionId,
                steerId: item.id,
                clientMessageId: item.clientMessageId,
              });
              await send(item.text, { bucket, clientMessageId: item.clientMessageId });
            });
          })
          .catch((err) => {
            steeredIdsRef.current.delete(item.id);
            window.codeshell.log("steer.enqueue_failed", {
              bucket,
              engineSessionId,
              steerId: item.id,
              clientMessageId: item.clientMessageId,
              error: String((err as Error)?.message ?? err),
            });
          });
      }
      return;
    }

    // !busy: no live run. Either a 引导打断 relay handoff (drain the WHOLE queue
    // as one merged re-send) or a leftover queue typed while idle (take the next
    // item). Clear the relay marker once we fire.
    const isRelay = relayingBuckets.has(activeBucket);
    if (isRelay) {
      const { text, ids, state: next } = drainQueuedInput(queuedInputs, activeBucket);
      ids.forEach((id) => {
        steeredIdsRef.current.delete(id);
        injectedSteerIdsRef.current.delete(id);
      });
      dispatch({ type: "remove_pending_steers", bucket: activeBucket, steerIds: ids });
      setQueuedInputs(next);
      setRelayingBuckets((prev) => {
        if (!prev.has(activeBucket)) return prev;
        const n = new Set(prev);
        n.delete(activeBucket);
        return n;
      });
      if (text) send(text);
      return;
    }
    const { item, state: next } = dequeueQueuedInput(queuedInputs, activeBucket);
    if (!item) {
      setQueuedInputs(next);
      return;
    }
    // The turn ended (busy→false). If this entry was already auto-steered into
    // the engine but the turn finished BEFORE consuming it (no steer_injected),
    // the entry is stranded in steerQueueBySid and would be eaten by the next
    // run — re-sending it here as a fresh run would then double (one send +
    // one leftover steer_injected). Revoke the stale steer first, so this
    // send() is the single source. (cancel/turn-end does NOT clear the steer
    // queue — same seam as the relay path's revokeSteeredForRelay.)
    if (steeredIdsRef.current.has(item.id)) {
      const engineSessionId = resolveActiveEngineSessionId();
      if (engineSessionId) void window.codeshell.unsteer(engineSessionId, item.id);
      steeredIdsRef.current.delete(item.id);
    }
    injectedSteerIdsRef.current.delete(item.id);
    dispatch({ type: "remove_pending_steers", bucket: activeBucket, steerIds: [item.id] });
    setQueuedInputs(next);
    if (item.text) send(item.text, { bucket: activeBucket, clientMessageId: item.clientMessageId });
  }, [busy, activeBucket, activeSessionId, queuedInputs, relayingBuckets]);

  const newQueuedId = (): string =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `q-${queuedSeqRef.current++}`;

  const queueInput = (text: string): void => {
    const id = newQueuedId();
    const clientMessageId = newQueuedId();
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatch({
      type: "user_message",
      bucket: activeBucket,
      text: trimmed,
      injected: true,
      steerId: id,
      pending: true,
      clientMessageId,
    });
    setQueuedInputs((prev) => enqueueQueuedInput(prev, activeBucket, id, trimmed, clientMessageId));
  };

  // Before a relay (打断重发) aborts + re-sends the queue as a fresh run, revoke
  // every queued draft that was ALREADY auto-steered into the engine. Otherwise
  // the leftover steer entries survive the abort and get consumed by the new
  // run → the same text lands twice (one relay re-send + one steer_injected).
  // This is the queue↔relay seam: cancel() does not clear steerQueueBySid.
  const revokeSteeredForRelay = (): void => {
    const engineSessionId = resolveActiveEngineSessionId();
    if (!engineSessionId) return;
    for (const item of queuedInputs[activeBucket] ?? []) {
      if (!steeredIdsRef.current.has(item.id)) continue;
      void window.codeshell.unsteer(engineSessionId, item.id);
      steeredIdsRef.current.delete(item.id);
    }
  };

  const forceSend = (text: string): void => {
    revokeSteeredForRelay();
    setQueuedInputs((prev) => enqueueQueuedInput(prev, activeBucket, newQueuedId(), text));
    setRelayingBuckets((prev) => new Set(prev).add(activeBucket));
    stop(activeBucket, { relay: true });
  };

  const clearActiveQueuedInput = (): void => {
    const ids = (queuedInputs[activeBucket] ?? []).map((i) => i.id);
    setQueuedInputs((prev) => clearQueuedInput(prev, activeBucket));
    const engineSessionId = resolveActiveEngineSessionId();
    ids.forEach((id) => {
      steeredIdsRef.current.delete(id);
      injectedSteerIdsRef.current.delete(id);
      // Best-effort revoke any that were already steered; consumed ones are a
      // no-op (removed=false) and will still arrive as bubbles.
      if (engineSessionId) void window.codeshell.unsteer(engineSessionId, id);
    });
    dispatch({ type: "remove_pending_steers", bucket: activeBucket, steerIds: ids });
  };

  const removeActiveQueuedInputAt = (index: number): void => {
    const item = (queuedInputs[activeBucket] ?? [])[index];
    if (!item) return;
    const bucket = activeBucket;
    // Drop BY ID, not index — the queue may shift between click and the async
    // unsteer reply (another item could inject/remove meanwhile).
    const drop = (): void => {
      steeredIdsRef.current.delete(item.id);
      injectedSteerIdsRef.current.delete(item.id);
      dispatch({ type: "remove_pending_steers", bucket, steerIds: [item.id] });
      setQueuedInputs((prev) => removeQueuedInputById(prev, bucket, item.id));
    };
    const engineSessionId = resolveActiveEngineSessionId();
    if (!engineSessionId || !steeredIdsRef.current.has(item.id)) {
      // Never steered (idle queue) — safe to drop immediately.
      drop();
      return;
    }
    // Already steered: ask the engine to revoke. If it was already consumed
    // (removed === false) leave the panel entry — its steer_injected event will
    // turn it into a bubble shortly (静默, no error). rpc() resolves the whole
    // {id, result} envelope, so the flag is at .result.removed.
    void window.codeshell.unsteer(engineSessionId, item.id).then((res) => {
      const removed = (res as { result?: { removed?: boolean } })?.result?.removed;
      if (removed !== false) drop();
    });
  };

  // 全部引导(打断重发): abort the current turn and re-send the WHOLE queued draft
  // merged into one message. Same relay-abort semantics as forceSend — the
  // queue stays put; the !busy auto-send effect drains it as a relay re-send
  // once the abort lands. (Non-interrupting step-boundary injection is now the
  // QUEUE's default — see the auto-send effect — so this button is the explicit
  // INTERRUPT entry, matching the composer 引导 button.)
  const guideActiveQueuedInput = (): void => {
    const queued = queuedInputs[activeBucket];
    if (!queued || queued.length === 0) return;
    revokeSteeredForRelay();
    setRelayingBuckets((prev) => new Set(prev).add(activeBucket));
    stop(activeBucket, { relay: true });
  };

  const stop = (bucketOverride?: string, opts?: { relay?: boolean }): void => {
    // Guard: when wired as a click handler (onClick={stop}) React passes the
    // MouseEvent as the first arg. Only honor a real string override; anything
    // else falls through to the running/active bucket. Without this the event
    // object reaches `bucket.indexOf` and throws — silently breaking Stop.
    const override = typeof bucketOverride === "string" ? bucketOverride : undefined;
    // opts.relay = 引导打断 (handoff to a queued re-send). We still draw the
    // "你在 Ns 后停止了" marker for it now (gives elapsed + keeps the killed turn's
    // content un-collapsed); the relayingBuckets marker set by the caller keeps
    // liveTurnActive lit across the cancel→re-send gap. (relay no longer changes
    // the turn_end dispatch — kept in the signature for call-site clarity.)
    void opts;
    // The composer Stop button belongs to the VIEWED conversation (its
    // visibility is busy=busyKeys.has(activeBucket)), so default to activeBucket
    // — NOT the global runningBucket ref, which points at whichever conversation
    // sent last and would abort the wrong one when two run concurrently.
    const bucket = resolveStopBucket(override, activeBucket, runningBucketRef.current);
    if (!bucket) return;
    const sep = bucket.indexOf("::");
    const uiSessionId = sep > 0 ? bucket.slice(sep + 2) : null;
    const repoKey = sep > 0 ? bucket.slice(0, sep) : null;
    const repoId = repoKey === GLOBAL_KEY || repoKey === null ? null : repoKey;
    const summary = uiSessionId && uiSessionId !== "_none_"
      ? sessionIndices[repoKey ?? GLOBAL_KEY]?.sessions.find((s) => s.id === uiSessionId)
        ?? loadSessionIndex(repoId).sessions.find((s) => s.id === uiSessionId)
      : undefined;
    const engineSessionId = summary?.engineSessionId ?? uiSessionId ?? undefined;
    window.codeshell.log("stop.click", { bucket, engineSessionId });
    // Fire the cancel IPC, but don't wait for the round-trip — the
    // user pressed Stop and expects the UI to reflect that NOW. Clear
    // busy + routing optimistically; any stream events that arrive
    // after this point are tail-end noise we can drop (the engine has
    // already been told to abort).
    // Manual-stop marker (TODO 2.8): a thin "你在 Ns 后停止了" line, using the
    // turn-start time captured when busy went true. Read BEFORE setBusyForKey
    // clears it.
    const startedAt = busySinceRef.current.get(bucket);
    const elapsedMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
    setBusyForKey(bucket, false);
    if (runningBucketRef.current === bucket) runningBucketRef.current = null;
    // Always mark the interrupted turn — even on the relay (引导接力) path. The
    // "你在 Ns 后停止了" line gives the elapsed time AND tags the turn as stopped,
    // which makes its TurnProcessGroup show its produced content flat (stopped →
    // itemsVisible) instead of collapsing behind the fold header. relay still
    // re-sends the queued input on the next busy=false tick; the turn_end just
    // closes out the killed turn (and clears the streaming pointers, which the
    // relay handoff needs anyway — see appendTurnEndMessage).
    dispatch({ type: "turn_end", bucket, reason: "stopped", elapsedMs });
    void window.codeshell.cancel(engineSessionId);
  };

  const resolveEngineSessionIdForBucket = (bucket: string): string | undefined => {
    const { repoKey, repoId, sessionId: uiSessionId } = parsePanelBucket(bucket);
    const summary =
      uiSessionId
        ? sessionIndices[repoKey]?.sessions.find((s) => s.id === uiSessionId) ??
          loadSessionIndex(repoId).sessions.find((s) => s.id === uiSessionId)
        : undefined;
    return summary?.engineSessionId ?? uiSessionId ?? undefined;
  };

  // Resolve the engine sessionId for the currently-running bucket (same logic
  // stop() uses). Returns undefined when nothing maps.
  const resolveActiveEngineSessionId = (): string | undefined =>
    resolveEngineSessionIdForBucket(runningBucketRef.current ?? activeBucket);

  const compactActiveSession = (): void => {
    if (busyKeys.has(activeBucket)) {
      toast({ message: t("chat.compact.running"), variant: "error" });
      return;
    }
    const bucket = activeBucket;
    const engineSessionId = resolveEngineSessionIdForBucket(bucket);
    if (!engineSessionId) {
      toast({ message: t("chat.compact.noSession"), variant: "error" });
      return;
    }
    const fmt = new Intl.NumberFormat();
    void window.codeshell
      .compactSession(engineSessionId)
      .then((result) => {
        const data = result.data;
        dispatch({
          type: "stream",
          bucket,
          event: {
            type: "usage_update",
            promptTokens: data.after,
          } as StreamEvent,
        });
        if (data.before === data.after) {
          toast({
            message: t("chat.compact.unchanged", { tokens: fmt.format(data.after) }),
            variant: "success",
          });
          return;
        }
        toast({
          message: t("chat.compact.done", {
            before: fmt.format(data.before),
            after: fmt.format(data.after),
            saved: fmt.format(Math.max(0, data.before - data.after)),
          }),
          variant: "success",
        });
      })
      .catch((e) => {
        toast({
          message: t("chat.compact.failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
          variant: "error",
        });
      });
  };

  // Extend the running goal (TODO 3.1). Fired by the "approaching limit" extend
  // button; opts target whichever ceiling is closest (turns or stop-blocks).
  const extendGoal = (opts: {
    addTurns?: number;
    addStopBlocks?: number;
    addTokenBudget?: number;
    addTimeBudgetMs?: number;
  }): void => {
    const engineSessionId = resolveActiveEngineSessionId();
    if (!engineSessionId) return;
    void window.codeshell.goalExtend(engineSessionId, opts).catch((e) =>
      window.codeshell.log("goal.extend.failed", { error: String(e) }),
    );
  };

  const decideEnvelope = (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ): void => {
    // Multi-session: thread engine sessionId so the worker routes the
    // decision back to the right session's pendingApprovals map. `scope`
    // (once/session/project) + `pathScope` (file/dir/tool, file tools) only
    // ride along on approve; deny ignores them.
    const approveScope = decision === "approve" ? scope : undefined;
    const approvePathScope = decision === "approve" ? pathScope : undefined;
    if (env.sessionId) {
      // (sessionId, requestId, decision, reason, answer, scope, pathScope)
      void window.codeshell.approve(env.sessionId, env.requestId, decision, reason, undefined, approveScope, approvePathScope);
    } else {
      // Legacy (requestId, decision, reason, answer, scope, pathScope)
      void window.codeshell.approve(env.requestId, decision, reason, undefined, approveScope, approvePathScope);
    }
    void window.codeshell.mobileRemote.notifyApprovalResolved({
      requestId: env.requestId,
      sessionId: env.sessionId,
      approved: decision === "approve",
    });
    approvalBucketsRef.current.delete(env.requestId);
    // The card itself gives instant optimistic feedback via its own local
    // state (ApprovalCard `decided`), so the user never waits on this root-App
    // re-render. Time the synchronous state churn anyway: if a future large
    // session makes the App re-render janky on click, perf.approval.decide will
    // surface it (no-op when perf logging is off). See the 2026-06-07 approval-
    // scope spec / debugging note: IPC is fire-and-forget and the stream build
    // is memoized, so this state update is the only synchronous work on click.
    timePhase("approval.decide", () => {
      // Compute the post-decision queue ONCE here. Reading `approvalQueue` from
      // render scope inside the setApproval updater would see the STALE pre-filter
      // value (the setApprovalQueue update above is batched and not yet committed),
      // so with multiple queued approvals the "next" lookup could surface an
      // already-decided one or skip the next. Derive both updates from this single
      // filtered list instead.
      const remaining = approvalQueue.filter((e) => e.requestId !== env.requestId);
      setApprovalQueue(remaining);
      setApprovalHistory((h) => [
        ...h,
        { decision, envelope: env, reason, at: Date.now() },
      ]);
      setApproval((cur) => {
        if (!cur || cur.requestId === env.requestId) {
          return remaining[0] ?? null;
        }
        return cur;
      });
    });
  };

  const showWelcome = state.messages.length === 0;
  const visibleApproval =
    approval && approvalBucketsRef.current.get(approval.requestId) === activeBucket
      ? approval
      : null;

  const setViewMode = (v: ViewMode): void => setView((prev) => ({ ...prev, viewMode: v }));

  // Right-side panel dock (dynamic tabs: files/browser/review/terminal). Panel
  // state is bucket-owned below; only nonce sources stay global so repeated
  // clicks can refire even if the same file/url is selected twice.
  // Monotonic nonce source for revealFile, in a ref so the open-file handler
  // (registered once) doesn't close over a stale `revealFile`.
  const revealFileNonceRef = useRef<number>(0);
  // A Files panel reports it has actually revealed the requested file; mark that
  // nonce consumed so the request keeps lingering on its bucket prop (a later
  // manually-opened Files tab reads it as already-handled and won't replay the
  // old file) WITHOUT the timing race the old setTimeout(0) flip had.
  const openUrlNonceRef = useRef<number>(0);
  // Comment anchors pinned from the panels (diff line / browser element / file
  // line). They show as chips above the composer and ride along with the next
  // message. Panels push them via the "codeshell:add-anchor" window event.
  // Keyed by session bucket (anchorBuckets.ts) so switching sessions switches
  // annotation sets; the browser surfaces echo the active bucket's browser
  // anchors (synced to main → broadcast to popout windows below).
  const [anchorsByBucket, setAnchorsByBucket] = useState<AnchorsByBucket>({});
  const anchors = anchorsIn(anchorsByBucket, activeBucket);
  // The add/remove event listeners register once; route through a ref so they
  // always target the CURRENT bucket, not the one from their mount render.
  const activeAnchorBucketRef = useRef(activeBucket);
  activeAnchorBucketRef.current = activeBucket;
  const removeAnchor = (id: string): void => {
    setAnchorsByBucket((s) => removeAnchorFrom(s, activeAnchorBucketRef.current, id));
  };
  const updateAnchorComment = (id: string, comment: string): void => {
    setAnchorsByBucket((s) =>
      updateAnchorCommentIn(s, activeAnchorBucketRef.current, id, comment),
    );
  };
  const clearAnchors = (): void => {
    // Clear the active bucket AND the repo's draft slot — see clearAnchorBuckets.
    setAnchorsByBucket((s) =>
      clearAnchorBuckets(s, [activeAnchorBucketRef.current, bucketKey(activeRepoId, null)]),
    );
  };
  // Panel state is owned by session bucket, not by the global App shell. This
  // mirrors Codex's thread-owned dock model: switching sessions changes which
  // PanelArea is visible; it never rewrites one session's browser/files/terminal
  // state into another session.
  const [panelByBucket, setPanelByBucket] = useState<Record<string, PanelBucketState>>(
    () => ({ [activeBucket]: hydratePanelBucketState(activeBucket) }),
  );

  const updatePanelBucket = useCallback(
    (targetBucket: string, updater: (state: PanelBucketState) => PanelBucketState) => {
      setPanelByBucket((prev) => {
        const current = prev[targetBucket] ?? hydratePanelBucketState(targetBucket);
        const next = updater(current);
        if (next === current) return prev;
        return { ...prev, [targetBucket]: next };
      });
    },
    [],
  );

  const onRevealConsumed = useCallback(
    (targetBucket: string, nonce: number) => {
      updatePanelBucket(targetBucket, (state) => {
        if (!state.revealFile || state.revealFile.nonce !== nonce || state.revealFile.consumed) return state;
        return { ...state, revealFile: { ...state.revealFile, consumed: true } };
      });
    },
    [updatePanelBucket],
  );

  useEffect(() => {
    setPanelByBucket((prev) => {
      // Ensure the active bucket has state, and prune stale entries that are
      // fully empty (closed, no tabs) and not the active one — those render no
      // PanelArea, so keeping them would only grow the map without effect.
      let changed = false;
      const nextEntries: [string, PanelBucketState][] = [];
      for (const [bucket, state] of Object.entries(prev)) {
        if (bucket !== activeBucket && !state.open && state.tabs.length === 0) {
          changed = true; // drop it
          continue;
        }
        nextEntries.push([bucket, state]);
      }
      if (!prev[activeBucket]) {
        nextEntries.push([activeBucket, hydratePanelBucketState(activeBucket)]);
        changed = true;
      }
      return changed ? Object.fromEntries(nextEntries) : prev;
    });
  }, [activeBucket]);

  // Persist only buckets whose serialized panel state actually changed, so a
  // single-bucket edit (e.g. switching a tab) doesn't rewrite every bucket's
  // localStorage key.
  const savedPanelSnapshotsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const seen = new Set<string>();
    for (const [bucket, state] of Object.entries(panelByBucket)) {
      seen.add(bucket);
      const snapshot = { open: state.open, tabs: state.tabs, activeId: state.activeId };
      const serialized = JSON.stringify(snapshot);
      if (savedPanelSnapshotsRef.current.get(bucket) === serialized) continue;
      savePanelState<PanelTab>(bucket, snapshot);
      savedPanelSnapshotsRef.current.set(bucket, serialized);
    }
    // Forget buckets that were removed (e.g. pruned or session-deleted); their
    // localStorage key is cleared at the removal site, so just drop the cache.
    for (const bucket of [...savedPanelSnapshotsRef.current.keys()]) {
      if (!seen.has(bucket)) savedPanelSnapshotsRef.current.delete(bucket);
    }
  }, [panelByBucket]);

  const activePanelState = panelByBucket[activeBucket] ?? emptyPanelBucketState();

  const panelBuckets = useMemo(() => {
    const buckets = new Set<string>();
    for (const [bucket, state] of Object.entries(panelByBucket)) {
      if (state.tabs.length > 0) buckets.add(bucket);
    }
    if (activePanelState.open || activePanelState.tabs.length > 0) buckets.add(activeBucket);
    return [...buckets];
  }, [activeBucket, activePanelState.open, activePanelState.tabs.length, panelByBucket]);

  const togglePanel = (): void =>
    updatePanelBucket(activeBucket, (state) => {
      const open = !state.open;
      return {
        ...state,
        open,
        requestNonce: state.requestNonce + 1,
        requestKind: null,
        openUrl: open ? state.openUrl : undefined,
      };
    });

  const openPanel = (kind: PanelTab): void =>
    updatePanelBucket(activeBucket, (state) => ({
      ...state,
      open: true,
      requestNonce: state.requestNonce + 1,
      requestKind: kind,
    }));

  // Dock width (px), persisted. The divider on the dock's left edge drags it.
  const PANEL_MIN = 320;
  const PANEL_MAX_FRAC = 0.7; // never let the dock eat more than 70% of the window
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("codeshell.panelWidth"));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : 480;
  });
  const beginPanelResize = (startX: number, startWidth: number): void => {
    const onMove = (ev: MouseEvent): void => {
      // Dock is on the RIGHT, so dragging left (smaller clientX) widens it.
      const delta = startX - ev.clientX;
      const max = Math.max(PANEL_MIN, Math.floor(window.innerWidth * PANEL_MAX_FRAC));
      const next = Math.min(max, Math.max(PANEL_MIN, startWidth + delta));
      setPanelWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setPanelWidth((w) => {
        localStorage.setItem("codeshell.panelWidth", String(w));
        return w;
      });
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Conversational automation creation: seed the chat composer with a starter
  // prompt and switch to chat. The agent explains automation, asks what to do
  // and when, then calls CronCreate — the user never touches cron syntax.
  const [composerSeed, setComposerSeed] = useState("");
  const [composerSeedNonce, setComposerSeedNonce] = useState(0);
  const startConversationalAutomation = (): void => {
    // Start a FRESH draft session — never pile onto whatever task/run session
    // happened to be active. Mirrors handleNewConversation: clear
    // activeSessionId so a brand-new session materializes on first send.
    const repoId = activeRepoId;
    setSessionIndices((prev) => ({
      ...prev,
      [repoKeyOf(repoId)]: setActiveSession(repoId, null),
    }));
    setComposerSeed(t("misc.app.automationSeed"));
    setComposerSeedNonce((n) => n + 1);
    setViewMode("chat");
  };
  const toggleSidebar = (): void =>
    setView((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  // toggleInspector retained as a no-op for menu/palette wiring that
  // still references the action verb but the panel itself is gone.
  const toggleInspector = (): void => undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      // Is the user typing into an editable field? Panel-switch hotkeys
      // (esp. ⌃` and ⌘⇧E, which produce/consume printable chars) must not
      // fire while typing, or they'd swallow keystrokes. The app-global
      // ⌘K/⌘P/⌘F palette/search keys deliberately still work from inputs.
      const t = e.target as HTMLElement | null;
      const typing =
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
        const idx = sessionIndices[repoKeyOf(activeRepoId)];
        const target = idx?.sessions[n];
        if (target) {
          e.preventDefault();
          handleSelectSession(activeRepoId, target.id);
        }
      } else if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        if (searchOpen) setSearchOpen(false);
        if (sessionSearchOpen) setSessionSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen, searchOpen, sessionSearchOpen, sessionIndices, activeRepoId]);

  // A chat "files changed" card asked to review its edited files: open the
  // review panel in the dock, focused on those files.
  useEffect(() => {
    const onReview = (e: Event): void => {
      const detail = (e as CustomEvent<{ files?: string[]; diff?: string }>).detail;
      const files = detail?.files;
      updatePanelBucket(activeBucketRef.current, (state) => ({
        ...state,
        open: true,
        reviewFiles: Array.isArray(files) && files.length > 0 ? files : undefined,
        reviewDiff: detail?.diff || undefined,
        requestNonce: state.requestNonce + 1,
        requestKind: "review",
      }));
    };
    window.addEventListener("codeshell:review-files", onReview);
    return () => window.removeEventListener("codeshell:review-files", onReview);
  }, [updatePanelBucket]);

  // A chat answer link (http/https) was clicked: open it in the in-app browser
  // panel instead of the OS browser. BrowserPanel listens for the same event to
  // open the URL in a new tab; here we just surface the dock + browser panel.
  useEffect(() => {
    const onOpenUrl = (e: Event): void => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      // Carry the URL down on the target bucket BEFORE surfacing the panel, so
      // a freshly-mounted BrowserPanel navigates to it immediately.
      const nonce = (openUrlNonceRef.current ?? 0) + 1;
      openUrlNonceRef.current = nonce;
      updatePanelBucket(activeBucketRef.current, (state) => ({
        ...state,
        open: true,
        openUrl: { url, nonce },
        requestNonce: state.requestNonce + 1,
        requestKind: "browser",
      }));
    };
    window.addEventListener("codeshell:open-url", onOpenUrl);
    return () => window.removeEventListener("codeshell:open-url", onOpenUrl);
  }, [updatePanelBucket]);

  // A chat answer's file path link was clicked: open it in the in-app Files
  // panel. FilesPanel listens for the same event to select + reveal the file;
  // here we just surface the dock + files panel.
  useEffect(() => {
    const onOpenFile = (e: Event): void => {
      const detail = (e as CustomEvent<{ path?: string; cwd?: string | null }>).detail;
      if (!detail?.path) return;
      const nonce = (revealFileNonceRef.current ?? 0) + 1;
      revealFileNonceRef.current = nonce;
      // Fresh, un-consumed request — the targeted (or newly opened) Files panel
      // reveals it, then reports back via onRevealConsumed so we flip `consumed`
      // true. The request lingers on the shared prop (so a LATER manually-opened
      // Files tab sees it already-consumed and does NOT replay it — the "new tab
      // shows the old file" bug), but we mark it consumed only AFTER a panel has
      // actually revealed it. The old code flipped `consumed` on a setTimeout(0),
      // which raced the freshly-mounted panel's effect: when THIS click also
      // created the Files tab, the flip landed before the new panel's reveal
      // effect ran, so the first click opened an empty tab and you had to click
      // again. Event-driven consume removes that race.
      updatePanelBucket(activeBucketRef.current, (state) => ({
        ...state,
        open: true,
        revealFile: { path: detail.path!, cwd: detail.cwd ?? null, nonce, consumed: false },
        requestNonce: state.requestNonce + 1,
        requestKind: "files",
      }));
    };
    window.addEventListener("codeshell:open-file", onOpenFile);
    return () => window.removeEventListener("codeshell:open-file", onOpenFile);
  }, [updatePanelBucket]);

  // A panel pinned a comment anchor (diff line / browser element / file line).
  // Accumulate it as a chip above the composer (into the active bucket).
  useEffect(() => {
    const onAnchor = (e: Event): void => {
      const anchor = (e as CustomEvent<{ anchor?: Anchor }>).detail?.anchor;
      if (anchor) {
        setAnchorsByBucket((s) => addAnchorTo(s, activeAnchorBucketRef.current, anchor));
      }
    };
    window.addEventListener("codeshell:add-anchor", onAnchor);
    return () => window.removeEventListener("codeshell:add-anchor", onAnchor);
  }, []);

  // A browser popout window pinned an element anchor; it arrives over IPC
  // (no id assigned yet). Add it to the composer like a local one. Removals
  // initiated in a popout arrive the same way (by anchor id).
  useEffect(() => {
    const offAdd = window.codeshell.onBrowserAnchorFromPopout((raw) => {
      const a = raw as Omit<Anchor, "id">;
      if (a && a.kind && a.locator) {
        setAnchorsByBucket((s) =>
          addAnchorTo(s, activeAnchorBucketRef.current, { ...a, id: nextAnchorId() }),
        );
      }
    });
    const offRemove = window.codeshell.onBrowserAnchorRemoveFromPopout((id) => {
      if (typeof id === "string" && id) {
        setAnchorsByBucket((s) => removeAnchorFrom(s, activeAnchorBucketRef.current, id));
      }
    });
    const offUpdate = window.codeshell.onBrowserAnchorUpdateFromPopout((raw) => {
      const u = raw as { id?: string; comment?: string };
      if (u && typeof u.id === "string" && typeof u.comment === "string") {
        setAnchorsByBucket((s) =>
          updateAnchorCommentIn(s, activeAnchorBucketRef.current, u.id!, u.comment!),
        );
      }
    });
    return () => {
      offAdd();
      offRemove();
      offUpdate();
    };
  }, []);

  // Push the active bucket's browser anchors to main, which broadcasts them to
  // every browser popout window — the single state-down pipe that keeps all
  // browser surfaces showing the same annotation set (and clears them all when
  // a message sends). The main-window BrowserPanel gets the same list as a
  // plain prop instead.
  const browserAnchors = useMemo(() => browserAnchorsOf(anchors), [anchors]);
  useEffect(() => {
    window.codeshell.syncBrowserAnchors(browserAnchors);
  }, [browserAnchors]);

  useEffect(() => {
    const off = window.codeshell.onMenuEvent((evt, payload) => {
      switch (evt) {
        case "add-project":
          void handleAddRepo();
          break;
        case "open-recent": {
          const p = payload as { path: string; name: string } | undefined;
          if (!p) return;
          unmarkRepoPathRemoved(p.path);
          const existing = repos.find((r) => r.path === p.path);
          if (existing) setActiveRepoId(existing.id);
          else {
            const id = makeRepoId();
            setRepos((prev) => [...prev, { id, name: p.name, path: p.path, addedAt: Date.now() }]);
            setActiveRepoId(id);
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
  }, [repos]);

  // Refresh model list + active selection + permission from settings.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const cwd = activeRepo?.path;
        const projectS = cwd ? (await window.codeshell.getSettings("project", cwd)) ?? {} : {};
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
        const permissions = merged.permissions && typeof merged.permissions === "object"
          ? (merged.permissions as Record<string, unknown>)
          : {};
        setDefaultPermissionMode(fromSettingsPermissionMode(merged.permissionMode ?? permissions.defaultMode));
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
    return () => { cancelled = true; };
  }, [activeRepo, view.viewMode, settingsRevision]);

  useEffect(() => {
    void window.codeshell.setBadgeCount(approvalQueue.length);
  }, [approvalQueue.length]);

  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (prevBusyRef.current && !busy && document.hidden) {
      void window.codeshell.notify({
        title: "code-shell",
        body: activeRepo
          ? t("misc.app.notifyDone", { name: activeRepo.name })
          : t("misc.app.notifyAgentDone"),
      });
    }
    prevBusyRef.current = busy;
  }, [busy, activeRepo]);

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
      const repoKey = sep > 0 ? activeBucket.slice(0, sep) : null;
      const summary = uiSessionId && uiSessionId !== "_none_"
        ? sessionIndices[repoKey ?? GLOBAL_KEY]?.sessions.find((s) => s.id === uiSessionId)
        : undefined;
      engineSessionId = summary?.engineSessionId ?? uiSessionId ?? undefined;
    }
    if (engineSessionId) {
      void window.codeshell.approve(engineSessionId, requestId, "approve", undefined, answer);
    } else {
      void window.codeshell.approve(requestId, "approve", undefined, answer);
    }
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
    // Zero this session's cumulative cache stats immediately: a different model
    // has its own prompt cache, so the accumulated hit rate no longer applies.
    // The engine also resets its persisted copy (resetSessionUsage) — this is
    // the renderer-local mirror so the tooltip updates without a round-trip.
    dispatch({
      type: "stream",
      bucket: activeBucket,
      event: {
        type: "usage_update",
        promptTokens: 0,
        sessionPromptTokens: 0,
        sessionCacheReadTokens: 0,
        sessionCacheCreationTokens: 0,
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
    const summary = sessionIndices[activeRepoKey]?.sessions.find(
      (s) => s.id === activeSessionId,
    );
    return summary?.engineSessionId ?? activeSessionId;
  };

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

  const sessionTitleForTop = (() => {
    const idx = sessionIndices[activeRepoKey];
    const s = idx?.sessions.find((x) => x.id === activeSessionId);
    return s?.title ?? null;
  })();

  // Live-activity summary for the TopBar status popover. Recomputed
  // whenever messages change — cheap (single pass from the most
  // recent user message), no allocations beyond the returned object.
  const liveActivity = useMemo(
    () => summarizeLiveActivity(state.messages),
    [state.messages],
  );

  // Count background sub-agents still running in THIS session. When the model
  // spawns with run_in_background, the main run resolves immediately (busy
  // clears, the composer re-enables — by design), but the children keep
  // working. We surface that with a separate "后台 N 个子代理运行中" indicator
  // so the UI doesn't look idle while agents are still in flight. Derived from
  // the reducer's AgentMessage entries (done=false set on agent_start, true on
  // agent_end), so no extra state to track. (perf/ux: bg-agent-busy-2026-06-02)
  const runningAgents = useMemo(
    () =>
      state.messages.reduce(
        (n, m) => (m.kind === "agent" && !m.done && !m.error ? n + 1 : n),
        0,
      ),
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

  // Clear the active persistent goal (CC /goal clear) for the active session.
  // goalClear's core path clears state.json authoritatively, but for an idle /
  // aborted session there is NO live worker and thus NO stream to push a
  // goal_cleared event back on — so state.activeGoal (which drives the GOAL
  // popover) would never get nulled and the block would stay on screen despite
  // the disk clear succeeding ("清除 点了没反应"). So we optimistically feed a
  // goal_cleared event into the reducer for this bucket ourselves: the popover
  // disappears immediately, independent of whether a worker exists. The dropped
  // composer toggle keeps the next bare send from re-inheriting the goal.
  const handleClearGoal = (): void => {
    const eid = engineSessionIdForActive();
    if (!eid) return;
    void window.codeshell.goalClear(eid).catch((e) =>
      window.codeshell.log("goal.clear.failed", { error: String(e) }),
    );
    // Reflect immediately (client-side, no dependency on a backend event):
    // null out state.activeGoal for this bucket so the GOAL block hides now.
    dispatch({
      type: "stream",
      bucket: activeBucket,
      event: { type: "goal_cleared" } as StreamEvent,
    });
    // And drop the composer goal toggle for this bucket.
    setGoalOverrides((prev) => ({ ...prev, [activeBucket]: false }));
  };

  const platformClassEarly = isMac ? "platform-darwin" : "";

  if (view.viewMode === "settings_page") {
    return (
      <div className={`h-screen overflow-hidden bg-background text-foreground ${platformClassEarly}`.trim()}>
        <SettingsPage
          activeRepoPath={activeRepo?.path ?? null}
          repos={repos}
          sessionIndices={sessionIndices}
          onRestoreArchivedSession={(repoId, sessionId) => {
            const next = archiveSession(repoId, sessionId, false);
            setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));
          }}
          onDeleteArchivedSession={handleDeleteSession}
          isMac={isMac}
          isFullscreen={isFullscreen}
          onBack={() => setViewMode("chat")}
        />
      </div>
    );
  }

  const platformClass = platformClassEarly;
  const isChatView = view.viewMode === "chat";

  return (
    <div
      className={`flex h-screen flex-col overflow-hidden bg-background text-foreground ${platformClass}`.trim()}
      data-sidebar={view.sidebarCollapsed ? "collapsed" : "open"}
      data-inspector="hidden"
    >
      <div className="shrink-0">
        <TopBar
          repoName={activeRepo?.name ?? null}
          sessionTitle={sessionTitleForTop}
          busy={busy}
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
          activity={liveActivity}
          tasks={latestTasks}
          activeGoal={state.activeGoal}
          onClearGoal={handleClearGoal}
        />
      </div>

      <div className="flex min-h-0 flex-1">
      {!view.sidebarCollapsed && (
      <div className="flex shrink-0 overflow-hidden">
        <Sidebar
          repos={repos}
          sessions={sessionIndices}
          activeRepoId={activeRepoId}
          activeSessionId={activeSessionId}
          collapsedRepos={collapsedRepos}
          sidebarCollapsed={view.sidebarCollapsed}
          sessionStatuses={sessionStatusMap}
          onSelectRepo={setActiveRepoId}
          onSelectSession={handleSelectSession}
          onToggleRepo={handleToggleRepo}
          onAddRepo={() => { void handleAddRepo(); }}
          onRemoveRepo={handleRemoveRepo}
          onPinRepo={handlePinRepo}
          onRenameRepo={handleRenameRepo}
          onArchiveAllSessions={handleArchiveAllSessions}
          onNewConversationForRepo={handleNewConversationForRepo}
          onNewConversation={handleNewConversation}
          onOpenSearch={() => setSessionSearchOpen(true)}
          onOpenAutomations={() => setViewMode("automation")}
          onOpenCustomize={() => setViewMode("customize")}
          onOpenCredentials={() => setViewMode("credentials")}
          onOpenSettingsPage={() => setViewMode("settings_page")}
          onRenameSession={handleRenameSession}
          onArchiveSession={handleArchiveSession}
          onDeleteSession={handleDeleteSession}
          activeRepoPath={activeRepo?.path ?? null}
          viewMode={view.viewMode}
        />
      </div>
      )}

      {/* Chat column + dock share a relative container so a maximized panel can
          overlay the chat/composer (TODO 2.4) without covering the sidebar. */}
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {lifecycle && <div className="border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">{lifecycle}</div>}
        {view.viewMode === "approvals" ? (
          <ApprovalsView
            queue={approvalQueue}
            history={approvalHistory}
            onDecide={decideEnvelope}
          />
        ) : view.viewMode === "logs" ? (
          <LogsView />
        ) : view.viewMode === "customize" ? (
          <CustomizeView activeRepoPath={activeRepo?.path ?? null} />
        ) : view.viewMode === "credentials" ? (
          <CredentialsPage activeRepoPath={activeRepo?.path ?? null} />
        ) : view.viewMode === "runs" ? (
          <RunsView initialRunId={runsInitialRunId} />
        ) : view.viewMode === "automation" ? (
          <AutomationView
            onCreateConversational={startConversationalAutomation}
            onViewRun={(runId) => { setRunsInitialRunId(runId); setViewMode("runs"); }}
            onOpenRunSession={(run) => { void handleOpenAutomationRunSession(run); }}
            onOpenDiskSession={(session) => { void handleOpenAutomationDiskSession(session); }}
            onOpenSession={handleSelectSession}
            sessionIndices={sessionIndices}
            repos={repos}
          />
        ) : (
          <>
            <ChatView
              messages={state.messages}
              awaitingHydration={awaitingHydration}
              turnEpoch={state.turnEpoch}
              engineSessionId={state.sessionId}
              liveTurnActive={liveTurnActive}
              onSend={send}
              onQueueInput={queueInput}
              onForceSend={forceSend}
              onCompactCommand={compactActiveSession}
              onStop={() => stop()}
              busy={busy}
              queuedInputCount={queuedInputs[activeBucket]?.length ?? 0}
              queuedInputItems={(queuedInputs[activeBucket] ?? []).map((i) => i.text)}
              onClearQueuedInput={clearActiveQueuedInput}
              onRemoveQueuedInput={removeActiveQueuedInputAt}
              onGuideQueuedInput={guideActiveQueuedInput}
              runningAgents={runningAgents}
              activeRepoId={activeRepoId}
              composerSeed={composerSeed}
              composerSeedNonce={composerSeedNonce}
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
              imageDetail={imageDetail}
              pendingApproval={visibleApproval}
              onApprovalDecide={
                visibleApproval
                  ? (decision, reason, scope, pathScope) => decideEnvelope(visibleApproval, decision, reason, scope, pathScope)
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
              // Session-cumulative cache totals drive the "本会话累计命中率"
              // tooltip (per-turn hit rate isn't actionable — see ContextRing).
              cacheReadTokens={state.sessionCacheReadTokens}
              cacheCreationTokens={state.sessionCacheCreationTokens}
              sessionPromptTokens={state.sessionPromptTokens}
              repos={repos}
              // Picking a project (or 不使用项目) from the composer's
              // ProjectPicker enters a fresh draft for that repo rather than a
              // bare setActiveRepoId — otherwise the chat snaps to whatever
              // session that bucket last had active (the top of its list),
              // which reads as an unexpected auto-jump. (The reload-time
              // auto-jump was fixed separately in transcripts.ts; this is the
              // interactive project-switch path, same symptom, different code.)
              onSelectRepo={handleNewConversationForRepo}
              onAddRepo={() => { void handleAddRepo(); }}
              activeRepoPath={activeRepo?.path ?? null}
              // cwd used to RESOLVE message content (relative path links, inline
              // images) — distinct from activeRepoPath (git/STT/branch, which
              // must stay null for a no-repo chat). A no-repo session actually
              // runs under the sandbox cwd, so fall back to it; otherwise a
              // relative `docs/x.md` link can't resolve and renders as dead text.
              messageCwd={activeRepo?.path ?? noRepoCwdRef.current}
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
                      {activeRepo
                        ? t("misc.app.welcomeTitleRepo", { name: activeRepo.name })
                        : t("misc.app.welcomeTitleNoRepo")}
                    </div>
                    {!activeRepo && (
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
        <SearchBar
          open={searchOpen}
          value={searchQuery}
          onChange={setSearchQuery}
          onClose={() => setSearchOpen(false)}
          matchCount={matchCount}
        />
      </main>

      {/* PanelArea stays MOUNTED across close→reopen (hidden via display:none
          when !open) so the browser <webview> and terminal pty survive a dock
          close — reopening lands on the same live page instead of reloading
          from scratch (matches Codex). Closing only hides; the webview process
          is reclaimed by BrowserPanel's own idle-eviction after a few minutes.
          We still gate on having tabs so an empty dock doesn't mount stray
          panel bodies before the user has opened anything. */}
      {panelBuckets.map((panelBucket) => {
        const panelState = panelByBucket[panelBucket] ?? emptyPanelBucketState();
        const isActivePanelBucket = panelBucket === activeBucket;
        const { repoId: panelRepoId } = parsePanelBucket(panelBucket);
        const panelRepo = panelRepoId ? repos.find((r) => r.id === panelRepoId) ?? null : null;
        const hidden = !isActivePanelBucket || !isChatView || !panelState.open;
        const keepActiveBodyLive = panelState.open && (!isActivePanelBucket || !isChatView);

        return (
          <PanelArea
            key={panelBucket}
            // The dock is a chat-only surface. Hidden session-owned docks stay
            // mounted under their own bucket so browser/files/terminal state
            // cannot be rewritten by another session.
            hidden={hidden}
            keepActiveBodyLive={keepActiveBodyLive}
            cwd={panelRepo?.path ?? null}
            onClose={() =>
              updatePanelBucket(panelBucket, (state) => ({
                ...state,
                open: false,
                requestNonce: state.requestNonce + 1,
                requestKind: null,
                openUrl: undefined,
              }))
            }
            requestNonce={panelState.requestNonce}
            requestKind={panelState.requestKind}
            reviewFiles={panelState.reviewFiles}
            reviewDiff={panelState.reviewDiff}
            revealFile={panelState.revealFile}
            onRevealConsumed={(nonce) => onRevealConsumed(panelBucket, nonce)}
            openUrl={panelState.openUrl}
            width={panelWidth}
            onResizeStart={beginPanelResize}
            onAttachImage={(p) => void attachImageByPath(p)}
            browserAnchors={anchorsIn(anchorsByBucket, panelBucket)}
            onRemoveBrowserAnchor={isActivePanelBucket ? removeAnchor : undefined}
            onUpdateBrowserAnchor={isActivePanelBucket ? updateAnchorComment : undefined}
            engineSessionId={resolveEngineSessionIdForBucket(panelBucket) ?? null}
            tabs={panelState.tabs}
            setTabs={(next) =>
              updatePanelBucket(panelBucket, (state) => {
                const tabs = typeof next === "function" ? next(state.tabs) : next;
                const activeId =
                  state.activeId && tabs.some((tab) => tab.id === state.activeId)
                    ? state.activeId
                    : tabs[0]?.id ?? null;
                return { ...state, tabs, activeId };
              })
            }
            activeId={panelState.activeId}
            setActiveId={(next) =>
              updatePanelBucket(panelBucket, (state) => ({
                ...state,
                activeId: typeof next === "function" ? next(state.activeId) : next,
              }))
            }
            bucket={panelBucket}
          />
        );
      })}
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
        repos={repos}
        sessions={sessionIndices}
        activeRepoId={activeRepoId}
        onPick={(repoId, sid) => handleSelectSession(repoId, sid)}
      />

      <TrustGate
        repoPath={activeRepo?.path ?? null}
        onDecide={() => { /* trust persisted in main */ }}
      />

      {/* Inspector panel removed — tool detail lives inline in each
          tool card's expandable body. */}
    </div>
  );
}

function resolveActiveKey(s: Record<string, unknown>): string | null {
  // Unified catalog: defaults.text holds the active text connection's instance
  // id — the engine's priority #1 (engine.ts) and the picker's option key.
  const defaults = s.defaults && typeof s.defaults === "object"
    ? (s.defaults as Record<string, unknown>)
    : {};
  if (typeof defaults.text === "string" && defaults.text) return defaults.text;
  return null;
}

export { App };
export default App;
