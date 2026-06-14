import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { timePhase } from "./perf";
import { summarizeLiveActivity } from "./topbar/liveActivity";
// InspectorPanel removed — tool details now live inline in the chat
// stream's expandable tool cards (no dedicated detail pane).
import { useToast } from "./ui/ToastProvider";
import {
  applyStreamEvent,
  bgCompletionText,
  appendUserMessage,
  appendAskUserMessage,
  markAskUserAnswered,
  appendTurnEndMessage,
  INITIAL_STATE,
  type MessagesReducerState,
  type ApprovalState,
  type ToolMessage,
  type AskUserOption,
  type TaskListMessage,
} from "./types";
import {
  loadTranscript,
  saveTranscript,
  loadSessionIndex,
  createSession,
  deleteSessionLocal,
  renameSessionLocal,
  archiveSession,
  bindEngineSession,
  upsertImportedSession,
  updateSessionRunStatus,
  touchSession,
  setActiveSession,
  NO_REPO_KEY,
  bucketKey,
  repoKeyOf,
  migrateBucketOverride,
  clearBucketOverride,
  loadPanelState,
  savePanelState,
  type SessionIndex,
  type SessionSummary,
} from "./transcripts";
import { titleFromWire, buildPathAttachment, type ImageAttachment } from "./chat/attachments";
import { resolveBucket } from "./streamRouting";
import { statusForBucket, type SessionStatus } from "./sessionStatus";
import { selectReplayEvents } from "./snapshotReplay";
import type {
  AgentLifecycleEvent,
  ApprovalRequestEnvelope,
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
  removeQueuedInputAt,
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
import { UpdaterBanner } from "./updater/UpdaterBanner";
import { loadGitPrefs } from "./gitPrefs";
import { createEventCoalescer } from "./streamCoalescer";
import {
  fromSettingsPermissionMode,
  toCorePermissionMode,
  type PermissionMode,
} from "./chat/PermissionPill";
import type { ModelOption } from "./chat/ModelPill";

// Bucket key for sessions without a project — re-exported from transcripts.
// We use NO_REPO_KEY everywhere instead of a local const so the renderer
// and the persistence layer can't drift apart. `bucketKey`/`repoKeyOf` are
// imported from transcripts (the single source of truth) so App's map build
// can't drift from Sidebar's row lookup.
const GLOBAL_KEY = NO_REPO_KEY;

type TranscriptsMap = Record<string, MessagesReducerState>;

interface ComposerDraftState {
  text: string;
  attachments: ImageAttachment[];
}

type ComposerDraftsMap = Record<string, ComposerDraftState>;

const EMPTY_ATTACHMENTS: ImageAttachment[] = [];

type Action =
  | { type: "user_message"; bucket: string; text: string }
  | { type: "stream"; bucket: string; event: StreamEvent }
  | { type: "stream_batch"; bucket: string; events: StreamEvent[] }
  | { type: "hydrate"; bucket: string; state: MessagesReducerState }
  | {
      type: "ask_user";
      bucket: string;
      requestId: string;
      question: string;
      header?: string;
      options?: AskUserOption[];
      multiSelect: boolean;
      optionsOnly?: boolean;
    }
  | { type: "ask_user_answered"; bucket: string; requestId: string; answer: string }
  | {
      type: "turn_end";
      bucket: string;
      reason: "stopped" | "timeout" | "error";
      elapsedMs?: number;
      detail?: string;
    };

function reducer(map: TranscriptsMap, action: Action): TranscriptsMap {
  if (action.type === "hydrate") {
    return { ...map, [action.bucket]: action.state };
  }
  const current = map[action.bucket] ?? INITIAL_STATE;
  let next: MessagesReducerState;
  switch (action.type) {
    case "user_message":
      next = appendUserMessage(current, action.text, Date.now());
      break;
    case "ask_user":
      next = appendAskUserMessage(current, {
        requestId: action.requestId,
        question: action.question,
        header: action.header,
        options: action.options,
        multiSelect: action.multiSelect,
        optionsOnly: action.optionsOnly,
      });
      break;
    case "ask_user_answered":
      next = markAskUserAnswered(current, action.requestId, action.answer);
      break;
    case "turn_end":
      next = appendTurnEndMessage(current, action.reason, action.elapsedMs, action.detail);
      break;
    case "stream":
      next = applyStreamEvent(current, action.event);
      break;
    case "stream_batch": {
      // Fold the whole 50ms batch into one new state so the list re-renders
      // once per window, not once per event. applyStreamEvent returns the
      // same ref when an event is a no-op, so an all-no-op batch leaves
      // `next === current` and the dispatch below bails out.
      next = timePhase(
        "reducer.batch",
        () => {
          let acc = current;
          for (const ev of action.events) acc = applyStreamEvent(acc, ev);
          return acc;
        },
        () => ({ events: action.events.length, msgs: current.messages.length }),
      );
      break;
    }
  }
  if (next === current) return map;
  return { ...map, [action.bucket]: next };
}

interface ApprovalHistoryEntry {
  decision: "approve" | "deny";
  envelope: ApprovalRequestEnvelope;
  reason?: string;
  at: number;
}

function App() {
  const toast = useToast();
  const [transcripts, dispatch] = useReducer(reducer, {} as TranscriptsMap);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequestEnvelope[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalHistoryEntry[]>([]);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
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
  // settings.activeKey. A per-session switch updates this default too (so the
  // next 新对话 inherits it), but it must NOT retroactively drag existing
  // sessions onto a different model — that's what `modelOverrides` is for.
  const [defaultActiveModelKey, setDefaultActiveModelKey] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode | null>(null);
  // Provider-agnostic image clarity (low/standard/high) from merged settings;
  // drives renderer-side downscale before send. Undefined = follow default.
  const [imageDetail, setImageDetail] = useState<"low" | "standard" | "high" | undefined>(undefined);
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, PermissionMode>>({});
  /**
   * Per-bucket model override, keyed by the SAME bucketKey() as
   * permission/goal overrides. A session that has switched models (or whose
   * model was pinned at first send) lives here; everything else falls back to
   * `defaultActiveModelKey`. This is the fix for "切换模型不应改掉旧 session
   * 的模型": each session remembers its own model, and changing the global
   * default never overwrites an existing bucket's entry.
   */
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  /** Per-bucket Goal-mode toggle (orthogonal to permission). */
  const [goalOverrides, setGoalOverrides] = useState<Record<string, boolean>>({});
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  /** Transient: a run to pre-select when jumping into the runs view (e.g. from
   *  the 自动化 detail's 「查看最近运行」 button). Not persisted in view state. */
  const [runsInitialRunId, setRunsInitialRunId] = useState<string | null>(null);

  // Session indices per repo (keyed by repoKey).
  const [sessionIndices, setSessionIndices] = useState<Record<string, SessionIndex>>(() => {
    const out: Record<string, SessionIndex> = {};
    for (const r of loadRepos()) out[r.id] = loadSessionIndex(r.id);
    out[GLOBAL_KEY] = loadSessionIndex(null);
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
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);
  useEffect(() => { saveView(view); }, [view]);
  useEffect(() => { activeBucketRef.current = activeBucket; }, [activeBucket]);
  useEffect(() => { sessionIndicesRef.current = sessionIndices; }, [sessionIndices]);
  useEffect(() => { permissionModeRef.current = permissionMode; }, [permissionMode]);
  useEffect(() => {
    permissionForBucketRef.current = (bucket: string): PermissionMode | null =>
      permissionOverrides[bucket] ?? defaultPermissionMode;
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
    window.codeshell.log("repo.added", { id: next.id, path: next.path });
  };

  const handleRemoveRepo = (id: string): void => {
    const repo = repos.find((r) => r.id === id);
    if (repo) markRepoPathRemoved(repo.path);
    setRepos((prev) => prev.filter((r) => r.id !== id));
    if (activeRepoId === id) setActiveRepoId(null);
    setSessionIndices((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
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
    setRepos((prev) => prev.map((r) => (r.id === id ? { ...r, pinned } : r)));
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
        cwd: run.cwd,
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
    const [placement] = planDiskRebuild([session], reposNow, {
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
    // remove the on-disk session + run dirs for imported automation sessions.
    const summary = sessionIndices[repoKeyOf(repoId)]?.sessions.find((s) => s.id === sessionId);
    const next = deleteSessionLocal(repoId, sessionId);
    setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));
    if (summary?.source === "automation") {
      // Delete means delete — always remove the on-disk dirs, even if the run is
      // still in flight (user's explicit intent: kill it). The old code skipped
      // disk deletion for "running" runs, but a live-announced run's runStatus
      // is frozen at "running" and never refreshed, so it was ALWAYS skipped →
      // the session dir survived → the next backfill re-imported it forever.
      //
      // Cancel first (so the in-main automation run stops writing the session
      // dir we're about to delete and doesn't recreate it post-delete), THEN
      // delete. Cancel is best-effort: a no-op for an already-finished run.
      void (async () => {
        const inFlight = new Set(["queued", "running", "waiting_input", "waiting_approval", "blocked"]);
        const maybeRunning = summary.runStatus ? inFlight.has(summary.runStatus) : false;
        if (maybeRunning && summary.cronJobId) {
          await window.codeshell.cancelAutomationRun(summary.cronJobId).catch((e) =>
            window.codeshell.log("automation.delete.cancel.failed", { cronJobId: summary.cronJobId, error: String(e) }),
          );
        }
        const engineId = summary.engineSessionId ?? sessionId;
        await window.codeshell.deleteSession(engineId).catch((e) =>
          window.codeshell.log("automation.delete.session.failed", { engineId, error: String(e) }),
        );
        // deleteRun is a no-op for current jobs (which write sessions/, not
        // runs/), but still clears legacy RunManager-era run dirs.
        if (summary.runId) {
          await window.codeshell.deleteRun(summary.runId).catch((e) =>
            window.codeshell.log("automation.delete.run.failed", { runId: summary.runId, error: String(e) }),
          );
        }
      })();
    }
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
        const reposNow = loadRepos();
        const repoFactory = makeCreateRepoForCwd(reposNow);
        const placements = planDiskRebuild(page.sessions, reposNow, {
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
      const repoFactory = makeCreateRepoForCwd(reposNow);
      const placement = placeLiveAutomationSession(meta, reposNow, {
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
      if (repoFactory.changed()) setRepos(reposNow.slice());
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
                  (o): o is { label: string; description: string } =>
                    !!o &&
                    typeof o === "object" &&
                    typeof (o as Record<string, unknown>).label === "string" &&
                    typeof (o as Record<string, unknown>).description === "string",
                )
                .map((o) => ({ label: o.label, description: o.description }))
            : undefined;
        const bucket =
          (env.sessionId && engineToBucketRef.current.get(env.sessionId)) ||
          runningBucketRef.current ||
          activeBucketRef.current;
        dispatch({
          type: "ask_user",
          bucket,
          requestId: env.requestId,
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
      const targetBucket =
        (env.sessionId && engineToBucketRef.current.get(env.sessionId)) ||
        runningBucketRef.current ||
        activeBucketRef.current;
      if (permissionForBucketRef.current(targetBucket) === "bypass") {
        if (env.sessionId) {
          void window.codeshell.approve(env.sessionId, env.requestId, "approve");
        } else {
          void window.codeshell.approve(env.requestId, "approve");
        }
        return;
      }
      setApprovalQueue((q) => [...q, env]);
      setApproval((cur) => cur ?? env);
    });
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
      offApproval();
      offStatus();
      offLifecycle();
    };
    // `toast` from useToast is a stable reference (memoized in ToastProvider),
    // so listing it here does not re-register these long-lived IPC listeners.
  }, [toast]);

  const send = (text: string): void => {
    // createSession persists to localStorage synchronously, so reading
    // it back via touchSession() right after sees the new entry.
    const wasDraft = activeSessionId === null;
    const sid = activeSessionId ?? ensureActiveSession(activeRepoId);
    const bucket = bucketKey(activeRepoId, sid);
    const repoKey = repoKeyOf(activeRepoId);

    // A draft has no sessionId, so its permission/goal overrides were keyed
    // under the SHARED per-repo "_none_" bucket (bucketKey collapses every
    // draft to <repo>::_none_). On the first send the draft solidifies into a
    // real session — migrate the override onto the real bucket so the choice
    // FOLLOWS this session, then clear the shared draft slot so it doesn't
    // "粘连" onto the next 新对话 / other drafts in this repo (#11 per-session
    // permission stickiness).
    if (wasDraft && bucket !== activeBucket) {
      const draftBucket = activeBucket;
      setPermissionOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
      setGoalOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
      setModelOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
    }
    // Pin this session's model on its first send. Capturing the model in
    // effect right now means a LATER change to the global default won't drag
    // this (now-existing) session onto a different model. Only seed if the
    // bucket has no explicit override yet — never clobber a deliberate switch.
    if (activeModelKey && modelOverrides[bucket] === undefined) {
      const pinned = activeModelKey;
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
      ?? loadSessionIndex(activeRepoId).sessions.find((s) => s.id === sid);
    const engineSessionId = summary?.engineSessionId ?? sid;

    window.codeshell.log("send", {
      textLen: text.length,
      repo: activeRepo?.name ?? null,
      bucket,
      engineSessionId,
    });
    dispatch({ type: "user_message", bucket, text });
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
      const touched = touchSession(activeRepoId, sid, titleFromWire(text));
      const next = summary?.engineSessionId
        ? touched
        : bindEngineSession(activeRepoId, sid, engineSessionId);
      return { ...prev, [repoKey]: next };
    });

    const opts: {
      cwd?: string;
      sessionId?: string;
      permissionMode?: ReturnType<typeof toCorePermissionMode>;
      goal?: string;
    } = { sessionId: engineSessionId };
    if (permissionMode !== null) {
      opts.permissionMode = toCorePermissionMode(permissionMode);
    }
    if (activeRepo) opts.cwd = activeRepo.path;
    // Goal mode: this send's prompt IS the goal — the engine runs
    // loop-until-done. Goal text == prompt text (reuses the composer input).
    if (goalEnabled && text.trim()) opts.goal = text;

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
    const bucketModel =
      modelOverrides[bucket] ?? modelOverrides[activeBucket] ?? activeModelKey;
    if (bucketModel) {
      void window.codeshell.configure({ sessionId: engineSessionId, model: bucketModel });
    }

    void window.codeshell
      .run(text, opts)
      .then((r) => {
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
          const detail = result?.text?.replace(/^ERROR:\s*/, "") || "本轮请求被拒绝";
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
    if (busy || !activeSessionId) return;
    const queued = queuedInputs[activeBucket];
    if (!queued || queued.length === 0) return;
    // A 引导打断 relay drains the WHOLE queue as one merged message (the user
    // asked for everything to land at once); a natural turn-end auto-send takes
    // just the next item. Either way clear the relay marker once we fire.
    const isRelay = relayingBuckets.has(activeBucket);
    const { text, state: next } = isRelay
      ? drainQueuedInput(queuedInputs, activeBucket)
      : dequeueQueuedInput(queuedInputs, activeBucket);
    setQueuedInputs(next);
    if (isRelay) {
      setRelayingBuckets((prev) => {
        if (!prev.has(activeBucket)) return prev;
        const n = new Set(prev);
        n.delete(activeBucket);
        return n;
      });
    }
    if (text) send(text);
  }, [busy, activeBucket, activeSessionId, queuedInputs, relayingBuckets]);

  const queueInput = (text: string): void => {
    setQueuedInputs((prev) => enqueueQueuedInput(prev, activeBucket, text));
  };

  const forceSend = (text: string): void => {
    setQueuedInputs((prev) => enqueueQueuedInput(prev, activeBucket, text));
    setRelayingBuckets((prev) => new Set(prev).add(activeBucket));
    stop(activeBucket, { relay: true });
  };

  const clearActiveQueuedInput = (): void => {
    setQueuedInputs((prev) => clearQueuedInput(prev, activeBucket));
  };

  const removeActiveQueuedInputAt = (index: number): void => {
    setQueuedInputs((prev) => removeQueuedInputAt(prev, activeBucket, index));
  };

  // 引导打断: interrupt the current turn and send the ENTIRE queue merged into
  // one message. The relay marker keeps busy/liveTurnActive lit across the
  // cancel→re-send gap (no "正在思考" flicker) and tells the useEffect above to
  // drain everything rather than one item. (decisions #1 + #3)
  const guideActiveQueuedInput = (): void => {
    setRelayingBuckets((prev) => new Set(prev).add(activeBucket));
    stop(activeBucket, { relay: true });
  };

  const stop = (bucketOverride?: string, opts?: { relay?: boolean }): void => {
    // Guard: when wired as a click handler (onClick={stop}) React passes the
    // MouseEvent as the first arg. Only honor a real string override; anything
    // else falls through to the running/active bucket. Without this the event
    // object reaches `bucket.indexOf` and throws — silently breaking Stop.
    const override = typeof bucketOverride === "string" ? bucketOverride : undefined;
    // Relay = 引导打断: cancel the turn but DON'T draw a "你在 Ns 后停止了" line —
    // the user isn't stopping, they're handing off to a queued re-send that
    // fires on the next busy=false tick. The relay marker (relayingBuckets)
    // keeps liveTurnActive lit across the gap.
    const relay = opts?.relay === true;
    const bucket = override ?? runningBucketRef.current ?? activeBucket;
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
    if (!relay) dispatch({ type: "turn_end", bucket, reason: "stopped", elapsedMs });
    void window.codeshell.cancel(engineSessionId);
  };

  // Resolve the engine sessionId for the currently-running bucket (same logic
  // stop() uses). Returns undefined when nothing maps.
  const resolveActiveEngineSessionId = (): string | undefined => {
    const bucket = runningBucketRef.current ?? activeBucket;
    const sep = bucket.indexOf("::");
    const uiSessionId = sep > 0 ? bucket.slice(sep + 2) : null;
    const repoKey = sep > 0 ? bucket.slice(0, sep) : null;
    const repoId = repoKey === GLOBAL_KEY || repoKey === null ? null : repoKey;
    const summary =
      uiSessionId && uiSessionId !== "_none_"
        ? sessionIndices[repoKey ?? GLOBAL_KEY]?.sessions.find((s) => s.id === uiSessionId) ??
          loadSessionIndex(repoId).sessions.find((s) => s.id === uiSessionId)
        : undefined;
    return summary?.engineSessionId ?? uiSessionId ?? undefined;
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
    // The card itself gives instant optimistic feedback via its own local
    // state (ApprovalCard `decided`), so the user never waits on this root-App
    // re-render. Time the synchronous state churn anyway: if a future large
    // session makes the App re-render janky on click, perf.approval.decide will
    // surface it (no-op when perf logging is off). See the 2026-06-07 approval-
    // scope spec / debugging note: IPC is fire-and-forget and the stream build
    // is memoized, so this state update is the only synchronous work on click.
    timePhase("approval.decide", () => {
      setApprovalQueue((q) => q.filter((e) => e.requestId !== env.requestId));
      setApprovalHistory((h) => [
        ...h,
        { decision, envelope: env, reason, at: Date.now() },
      ]);
      setApproval((cur) => {
        if (!cur || cur.requestId === env.requestId) {
          const next = approvalQueue.find((e) => e.requestId !== env.requestId);
          return next ?? null;
        }
        return cur;
      });
    });
  };

  const showWelcome = state.messages.length === 0;

  const setViewMode = (v: ViewMode): void => setView((prev) => ({ ...prev, viewMode: v }));

  // Right-side panel dock (dynamic tabs: files/browser/review/terminal). Lives
  // alongside chat; the top-bar button toggles it. The dock manages its own
  // open tabs; App only asks it to open/focus a given kind via a request nonce.
  // Files the review tab should focus, set when a chat "files changed" card
  // requests review. Cleared is fine — review falls back to the whole tree.
  const [reviewFiles, setReviewFiles] = useState<string[] | undefined>(undefined);
  // The originating turn's diff snapshot (TODO 2.3a) — lets the review panel
  // show what that turn changed even after the edits are committed.
  const [reviewDiff, setReviewDiff] = useState<string | undefined>(undefined);
  // File the Files panel should select + reveal, set when a chat answer's path
  // link is clicked. The nonce re-fires reveal even when the same file is
  // clicked twice, and lets a freshly-created Files tab pick it up on mount.
  const [revealFile, setRevealFile] = useState<
    { path: string; cwd: string | null; nonce: number; consumed?: boolean } | undefined
  >(undefined);
  // Monotonic nonce source for revealFile, in a ref so the open-file handler
  // (registered once) doesn't close over a stale `revealFile`.
  const revealFileNonceRef = useRef<number>(0);
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
  // Panel-dock request: nonce + kind, in ONE state object so opening the dock
  // and choosing the kind is a single atomic update — PanelArea then mounts
  // seeing the right kind and never opens a stray tab for a stale value.
  // open=false means the dock is closed; the nonce only matters while open.
  const [panelRequest, setPanelRequest] = useState<{ nonce: number; kind: PanelTab | null; open: boolean }>({
    nonce: 0,
    kind: null,
    open: false,
  });
  // Panel dock tabs live in App (not PanelArea) so closing the dock and
  // reopening it doesn't wipe the open tabs (the dock unmounts on close).
  // PanelArea is a controlled component over these.
  const [panelTabs, setPanelTabs] = useState<{ id: string; kind: PanelTab }[]>([]);
  const [panelActiveId, setPanelActiveId] = useState<string | null>(null);
  // Top-bar toggle opens the dock on the card landing (kind null) / closes it.
  const togglePanel = (): void =>
    setPanelRequest((r) => ({ nonce: r.nonce + 1, kind: r.open ? r.kind : null, open: !r.open }));
  // Open the dock and request a tab of `kind` (used by hotkeys, palette, cards).
  const openPanel = (kind: PanelTab): void =>
    setPanelRequest((r) => ({ nonce: r.nonce + 1, kind, open: true }));

  // Per-session panel state (open/tabs/activeId). The dock rides with the
  // conversation: switching sessions restores that session's panels. Driven
  // off `activeBucket` (= bucketKey(activeRepoId, activeSessionId)), which is
  // the SINGLE derived key that changes on EVERY active-session switch — so
  // this covers every setActiveSession path (select / new / draft / delete /
  // automation) without instrumenting each call site.
  //
  // Race control. When `activeBucket` changes BOTH effects below re-run in the
  // same pass. The restore effect runs first and queues setState for the new
  // session's values, but those don't apply until the NEXT render — so on this
  // pass the save effect still sees the OLD session's panel values. Writing
  // them under the new `activeBucket` would corrupt the new session's saved
  // state. To prevent that, the restore effect sets `skipSaveForRef` to the
  // bucket it just restored; the save effect skips exactly one run for that
  // bucket (the transition tick) and then resumes. After that, every change to
  // the three panel states is the user's and gets persisted. panelWidth stays
  // global and is NOT keyed here.
  const skipSaveForRef = useRef<string | null>(activeBucket);
  useEffect(() => {
    const snap = loadPanelState<PanelTab>(activeBucket);
    setPanelTabs(snap.tabs);
    setPanelActiveId(snap.activeId);
    setPanelRequest((r) => ({ nonce: r.nonce + 1, kind: null, open: snap.open }));
    skipSaveForRef.current = activeBucket;
    // Only re-run when the active session/repo bucket changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBucket]);
  useEffect(() => {
    // Eat the transition tick after a restore so we don't write the previous
    // session's leftover values under the freshly-switched bucket.
    if (skipSaveForRef.current === activeBucket) {
      skipSaveForRef.current = null;
      return;
    }
    savePanelState<PanelTab>(activeBucket, {
      open: panelRequest.open,
      tabs: panelTabs,
      activeId: panelActiveId,
    });
  }, [panelTabs, panelActiveId, panelRequest.open, activeBucket]);

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
    setComposerSeed(
      "我想设置一个自动化。先简要说明自动化如何运作,然后问我几个问题,以了解我希望它做什么、以及何时运行(包括时区)。明确后用 CronCreate 工具帮我创建。",
    );
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
      setReviewFiles(Array.isArray(files) && files.length > 0 ? files : undefined);
      setReviewDiff(detail?.diff || undefined);
      setPanelRequest((prev) => ({ nonce: prev.nonce + 1, kind: "review", open: true }));
    };
    window.addEventListener("codeshell:review-files", onReview);
    return () => window.removeEventListener("codeshell:review-files", onReview);
  }, []);

  // A chat answer link (http/https) was clicked: open it in the in-app browser
  // panel instead of the OS browser. BrowserPanel listens for the same event to
  // open the URL in a new tab; here we just surface the dock + browser panel.
  useEffect(() => {
    const onOpenUrl = (): void => {
      setPanelRequest((prev) => ({ nonce: prev.nonce + 1, kind: "browser", open: true }));
    };
    window.addEventListener("codeshell:open-url", onOpenUrl);
    return () => window.removeEventListener("codeshell:open-url", onOpenUrl);
  }, []);

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
      // reveals it. We flip `consumed` true on the next tick so the request
      // lingers on the shared prop without making a LATER manually-opened Files
      // tab replay it (that was the "new tab shows the old file" bug).
      setRevealFile({ path: detail.path!, cwd: detail.cwd ?? null, nonce, consumed: false });
      setPanelRequest((prev) => ({ nonce: prev.nonce + 1, kind: "files", open: true }));
      setTimeout(() => {
        setRevealFile((prev) => (prev && prev.nonce === nonce ? { ...prev, consumed: true } : prev));
      }, 0);
    };
    window.addEventListener("codeshell:open-file", onOpenFile);
    return () => window.removeEventListener("codeshell:open-file", onOpenFile);
  }, []);

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
        const baseOpts = candidatesFromSettings(merged);
        setModelOptions(baseOpts);

        // Resolve maxContextTokens for entries that didn't declare one
        // via main-process model-meta-service (OpenRouter API → hardcoded
        // table → fallback). Done out-of-band so the initial render
        // doesn't wait on the network.
        const providers = Array.isArray(merged.providers)
          ? (merged.providers as Array<{ key?: string; kind?: string; baseUrl?: string; apiKey?: string }>)
          : [];
        const rawModels = Array.isArray(merged.models)
          ? (merged.models as Array<{
              key: string;
              model?: string;
              providerKey?: string;
              maxContextTokens?: number | null;
            }>)
          : [];
        const meta = await window.codeshell.resolveModelMeta(rawModels, providers);
        if (cancelled) return;
        const byKey = new Map(meta.map((m) => [m.key, m]));
        setModelOptions((prev) =>
          prev.map((o) => {
            const r = byKey.get(o.key);
            if (!r) return o;
            return {
              ...o,
              maxContextTokens: r.maxContextTokens,
              supportsVision: r.supportsVision,
            };
          }),
        );
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
        body: activeRepo ? `${activeRepo.name} — 完成` : "agent 已完成",
      });
    }
    prevBusyRef.current = busy;
  }, [busy, activeRepo]);

  const handleAskUserAnswer = (requestId: string, answer: string): void => {
    // AskUser is always inside the active bucket — derive the engine
    // sessionId so the worker routes the answer to the right session's
    // pending approval map.
    const sep = activeBucket.indexOf("::");
    const uiSessionId = sep > 0 ? activeBucket.slice(sep + 2) : null;
    const repoKey = sep > 0 ? activeBucket.slice(0, sep) : null;
    const summary = uiSessionId && uiSessionId !== "_none_"
      ? sessionIndices[repoKey ?? GLOBAL_KEY]?.sessions.find((s) => s.id === uiSessionId)
      : undefined;
    const engineSessionId = summary?.engineSessionId ?? uiSessionId ?? undefined;
    if (engineSessionId) {
      void window.codeshell.approve(engineSessionId, requestId, "approve", undefined, answer);
    } else {
      void window.codeshell.approve(requestId, "approve", undefined, answer);
    }
    dispatch({
      type: "ask_user_answered",
      bucket: activeBucket,
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
    // 2) Also adopt it as the global default so the NEXT 新对话 inherits it
    //    (user-chosen semantics). This only seeds future sessions; it never
    //    rewrites another bucket's existing override above.
    setDefaultActiveModelKey(opt.key);
    void window.codeshell.updateSettings("user", { activeKey: opt.key });
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

  const platformClassEarly =
    typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
      ? "platform-darwin"
      : "";

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
          onBack={() => setViewMode("chat")}
        />
      </div>
    );
  }

  const platformClass = platformClassEarly;

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
          panelOpen={panelRequest.open}
          onTogglePanel={togglePanel}
          activity={liveActivity}
          tasks={latestTasks}
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
        <UpdaterBanner />
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
              turnEpoch={state.turnEpoch}
              engineSessionId={state.sessionId}
              liveTurnActive={liveTurnActive}
              onSend={send}
              onQueueInput={queueInput}
              onForceSend={forceSend}
              onStop={() => stop()}
              busy={busy}
              queuedInputCount={queuedInputs[activeBucket]?.length ?? 0}
              queuedInputItems={queuedInputs[activeBucket] ?? []}
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
              pendingApproval={approval}
              onApprovalDecide={
                approval
                  ? (decision, reason, scope, pathScope) => decideEnvelope(approval, decision, reason, scope, pathScope)
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
              repoClean={activeGitMeta.clean}
              welcomeNode={
                showWelcome ? (
                  <div className="flex flex-col items-center gap-2 text-center">
                    <div className="text-3xl font-semibold tracking-tight text-foreground">
                      {activeRepo
                        ? `要在 ${activeRepo.name} 中构建什么?`
                        : `开始一个无项目对话`}
                    </div>
                    {!activeRepo && (
                      <div className="text-sm text-muted-foreground">
                        在下方选择一个项目，或直接在「不使用项目」模式开始
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

      {panelRequest.open && (
        <PanelArea
          cwd={activeRepo?.path ?? null}
          repoId={activeRepoId}
          // Match togglePanel's contract on close (bump nonce, clear kind) so
          // closing via the dock's own tab-X leaves the same state as the
          // top-bar toggle — avoids a stale `kind` lingering after close.
          onClose={() => setPanelRequest((r) => ({ nonce: r.nonce + 1, kind: null, open: false }))}
          requestNonce={panelRequest.nonce}
          requestKind={panelRequest.kind}
          reviewFiles={reviewFiles}
          reviewDiff={reviewDiff}
          revealFile={revealFile}
          width={panelWidth}
          onResizeStart={beginPanelResize}
          onAttachImage={(p) => void attachImageByPath(p)}
          browserAnchors={browserAnchors}
          onRemoveBrowserAnchor={removeAnchor}
          onUpdateBrowserAnchor={updateAnchorComment}
          engineSessionId={resolveActiveEngineSessionId() ?? null}
          tabs={panelTabs}
          setTabs={setPanelTabs}
          activeId={panelActiveId}
          setActiveId={setPanelActiveId}
        />
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

/**
 * Read top-level models[] out of merged settings.
 *
 * Code-shell's settings.json shape is:
 *   {
 *     activeKey: "deepseek-v4-pro",
 *     models: [{ key, label, providerKey, maxContextTokens, ... }],
 *     providers: [{ key, kind, label, ... }],
 *     model: { provider, name, ... }       // legacy single-model field
 *   }
 *
 * The engine picks the active model by matching activeKey against
 * models[].key. We mirror that here: read models[] for the dropdown,
 * read activeKey (or fall back to model.name) for the current pick.
 */
function candidatesFromSettings(s: Record<string, unknown>): ModelOption[] {
  const models = s.models;
  if (!Array.isArray(models)) return [];
  const out: ModelOption[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key : typeof obj.model === "string" ? obj.model : "";
    if (!key) continue;
    const label =
      typeof obj.label === "string" ? obj.label :
      typeof obj.model === "string" ? obj.model : key;
    const provider =
      typeof obj.providerKey === "string" ? obj.providerKey :
      typeof obj.provider === "string" ? obj.provider : "";
    const maxContextTokens =
      typeof obj.maxContextTokens === "number" ? obj.maxContextTokens : undefined;
    out.push({ key, label, provider, maxContextTokens });
  }
  return out;
}

function resolveActiveKey(s: Record<string, unknown>): string | null {
  if (typeof s.activeKey === "string" && s.activeKey) return s.activeKey;
  // Legacy: top-level `model.name` named the model directly.
  if (s.model && typeof s.model === "object") {
    const m = s.model as Record<string, unknown>;
    if (typeof m.name === "string") return m.name;
  }
  return null;
}

export { App };
export default App;
