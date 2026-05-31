import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { summarizeLiveActivity } from "./topbar/liveActivity";
// InspectorPanel removed — tool details now live inline in the chat
// stream's expandable tool cards (no dedicated detail pane).
import {
  applyStreamEvent,
  appendUserMessage,
  appendAskUserMessage,
  markAskUserAnswered,
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
  touchSession,
  setActiveSession,
  NO_REPO_KEY,
  type SessionIndex,
  type SessionSummary,
} from "./transcripts";
import { titleFromWire } from "./chat/attachments";
import type {
  AgentLifecycleEvent,
  ApprovalRequestEnvelope,
  StreamEventEnvelope,
} from "../preload/types";
import {
  loadRepos,
  saveRepos,
  loadActiveRepoId,
  saveActiveRepoId,
  makeRepoId,
  type Repo,
} from "./repos";
import { importAutomationRuns, type ImportableRun } from "./automation/importRuns";
import { isCaseInsensitivePlatform } from "./automation/pathMatch";
import { loadView, saveView, type ViewState, type ViewMode } from "./view";
import { ApprovalsView } from "./approvals/ApprovalsView";
import { LogsView } from "./logs/LogsView";
// Full-page Settings — driven by viewMode === 'settings_page'.
import { SettingsPage } from "./settings/SettingsPage";
import { RunsView } from "./runs/RunsView";
import { AutomationView } from "./automation/AutomationView";
import { CustomizeView } from "./customize/CustomizeView";
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
// and the persistence layer can't drift apart.
const GLOBAL_KEY = NO_REPO_KEY;
function repoKeyOf(repoId: string | null): string {
  return repoId ?? GLOBAL_KEY;
}
/** Compose a transcripts-map bucket key from repo + UI session id. */
function bucketKey(repoId: string | null, sessionId: string | null): string {
  return `${repoKeyOf(repoId)}::${sessionId ?? "_none_"}`;
}

type TranscriptsMap = Record<string, MessagesReducerState>;

type Action =
  | { type: "user_message"; bucket: string; text: string }
  | { type: "stream"; bucket: string; event: StreamEvent }
  | { type: "hydrate"; bucket: string; state: MessagesReducerState }
  | {
      type: "ask_user";
      bucket: string;
      requestId: string;
      question: string;
      header?: string;
      options?: AskUserOption[];
      multiSelect: boolean;
    }
  | { type: "ask_user_answered"; bucket: string; requestId: string; answer: string };

function reducer(map: TranscriptsMap, action: Action): TranscriptsMap {
  if (action.type === "hydrate") {
    return { ...map, [action.bucket]: action.state };
  }
  const current = map[action.bucket] ?? INITIAL_STATE;
  let next: MessagesReducerState;
  switch (action.type) {
    case "user_message":
      next = appendUserMessage(current, action.text);
      break;
    case "ask_user":
      next = appendAskUserMessage(current, {
        requestId: action.requestId,
        question: action.question,
        header: action.header,
        options: action.options,
        multiSelect: action.multiSelect,
      });
      break;
    case "ask_user_answered":
      next = markAskUserAnswered(current, action.requestId, action.answer);
      break;
    case "stream":
      next = applyStreamEvent(current, action.event);
      break;
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
  const [transcripts, dispatch] = useReducer(reducer, {} as TranscriptsMap);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequestEnvelope[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalHistoryEntry[]>([]);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const [repos, setRepos] = useState<Repo[]>(() => loadRepos());
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => loadActiveRepoId());
  const [view, setView] = useState<ViewState>(() => loadView());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** Cmd+P / sidebar 搜索 — cross-project session picker (modal). */
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [activeModelKey, setActiveModelKey] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode | null>(null);
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, PermissionMode>>({});
  /** Per-bucket Goal-mode toggle (orthogonal to permission). */
  const [goalOverrides, setGoalOverrides] = useState<Record<string, boolean>>({});
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());

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
  const goalEnabled = goalOverrides[activeBucket] ?? false;
  const busy = busyKeys.has(activeBucket);
  /**
   * Most-recently-started run's bucket. Soft fallback only — the
   * authoritative per-session routing is engineToBucketRef. We keep this
   * around for the brief window between sending agent/run and receiving
   * the first stream event back (envelopes during that window may carry
   * an empty sessionId for very legacy engines).
   */
  const runningBucketRef = useRef<string | null>(null);
  /**
   * Engine sessionId → UI bucket. Populated when send() fires (we use the
   * UI sessionId directly as the engine sessionId — see notes in send())
   * and reinforced when session_started arrives. This is what makes
   * concurrent runs route to the correct tab.
   */
  const engineToBucketRef = useRef<Map<string, string>>(new Map());
  const activeBucketRef = useRef(activeBucket);
  /** Per-bucket event coalescers — buffer rapid text_delta / tool_use_args_delta. */
  const coalescersRef = useRef<Map<string, ReturnType<typeof createEventCoalescer>>>(
    new Map(),
  );
  const permissionModeRef = useRef<PermissionMode | null>(permissionMode);
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

  useEffect(() => { saveRepos(repos); }, [repos]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);
  useEffect(() => { saveView(view); }, [view]);
  useEffect(() => { activeBucketRef.current = activeBucket; }, [activeBucket]);
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

  // Lazy-hydrate transcript on first view of a bucket.
  useEffect(() => {
    if (!activeSessionId) return;
    if (transcripts[activeBucket]) return;
    const loaded = loadTranscript(activeRepoId, activeSessionId);
    dispatch({ type: "hydrate", bucket: activeBucket, state: loaded });
  }, [activeBucket, activeRepoId, activeSessionId, transcripts]);

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

  const state = transcripts[activeBucket] ?? INITIAL_STATE;

  const setBusyForKey = (key: string, val: boolean): void => {
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
      setActiveRepoId(dup.id);
      return;
    }
    const next: Repo = {
      id: makeRepoId(),
      name: picked.name,
      path: picked.path,
      addedAt: Date.now(),
    };
    setRepos((prev) => [...prev, next]);
    setActiveRepoId(next.id);
    setSessionIndices((prev) => ({
      ...prev,
      [next.id]: loadSessionIndex(next.id),
    }));
    window.codeshell.log("repo.added", { id: next.id, path: next.path });
  };

  const handleRemoveRepo = (id: string): void => {
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
    setView((v) => ({ ...v, viewMode: "chat" }));
  };

  const handleSelectSession = (repoId: string | null, sessionId: string): void => {
    const key = repoKeyOf(repoId);
    setActiveRepoId(repoId);
    setSessionIndices((prev) => ({
      ...prev,
      [key]: setActiveSession(repoId, sessionId),
    }));
    // Make sure we're looking at chat, not settings, when the user
    // explicitly picks a session.
    setView((v) => ({ ...v, viewMode: "chat" }));
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
    const next = renameSessionLocal(repoId, sessionId, title);
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
      // Skip the on-disk dirs only while the run is KNOWN to be still running.
      // Deleting a live run's session/run dir would race the worker (mid-write)
      // and leave a partial dir the next backfill re-imports as a zombie. A
      // missing runStatus means a legacy/terminal import — safe to delete. The
      // local entry is removed regardless; a still-running run simply re-appears
      // on the next backfill (it's not in the dedup skip-set).
      const inFlight = new Set(["queued", "running", "waiting_input", "waiting_approval", "blocked"]);
      const isStillRunning = summary.runStatus ? inFlight.has(summary.runStatus) : false;
      if (!isStillRunning) {
        const engineId = summary.engineSessionId ?? sessionId;
        void window.codeshell.deleteSession(engineId).catch((e) =>
          window.codeshell.log("automation.delete.session.failed", { engineId, error: String(e) }),
        );
        if (summary.runId) {
          void window.codeshell.deleteRun(summary.runId).catch((e) =>
            window.codeshell.log("automation.delete.run.failed", { runId: summary.runId, error: String(e) }),
          );
        }
      }
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
      let reposChanged = false;
      await importAutomationRuns(runs, currentRepos, {
        caseInsensitive: isCaseInsensitivePlatform(),
        existingEngineSessionIds: known,
        cap: 50,
        fetchTranscript: (sid) => window.codeshell.getSessionTranscript(sid),
        createRepoForCwd: (cwd) => {
          const id = makeRepoId();
          const name = cwd.split("/").filter(Boolean).pop() || cwd;
          const repo: Repo = { id, name, path: cwd, addedAt: Date.now() };
          currentRepos.push(repo);
          saveRepos(currentRepos);
          reposChanged = true;
          return id;
        },
        writeImported: (repoId, summary, state) => {
          saveTranscript(repoId, summary.id, state);
          upsertImportedSession(repoId, summary);
          touchedRepoIds.add(repoId);
        },
      });
      if (cancelled) return;

      if (reposChanged) setRepos(currentRepos.slice());
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

  function getCoalescer(bucket: string) {
    let c = coalescersRef.current.get(bucket);
    if (!c) {
      c = createEventCoalescer((event) =>
        dispatch({ type: "stream", bucket, event }),
      );
      coalescersRef.current.set(bucket, c);
    }
    return c;
  }

  useEffect(() => {
    window.codeshell.log("app.mount", { codeshellKeys: Object.keys(window.codeshell ?? {}) });

    const offStream = window.codeshell.onStreamEvent((env: StreamEventEnvelope) => {
      const event = env.event;
      // Multi-session routing: every envelope carries the engine sessionId.
      // We mirror engineSessionId → bucket in a ref so stream events route to
      // the right tab even when several runs are in flight at once. Fallback
      // to the single runningBucketRef only for legacy / pre-bind events
      // (engineSessionId empty or not yet in the table).
      const fromTable = env.sessionId ? engineToBucketRef.current.get(env.sessionId) : undefined;
      const target = fromTable ?? runningBucketRef.current;
      if (!target) return;

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

      if (event.type === "turn_complete" || event.type === "error") {
        setBusyForKey(target, false);
        // Don't null runningBucketRef here — another concurrent send may
        // still be using it as a fallback. The ref is only a soft hint;
        // engineToBucketRef is the authoritative routing for in-flight runs.
      }
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
        engineToBucketRef.current.clear();
      }
    });
    return () => {
      offStream();
      offApproval();
      offStatus();
      offLifecycle();
    };
  }, []);

  const send = (text: string): void => {
    // createSession persists to localStorage synchronously, so reading
    // it back via touchSession() right after sees the new entry.
    const sid = activeSessionId ?? ensureActiveSession(activeRepoId);
    const bucket = bucketKey(activeRepoId, sid);
    const repoKey = repoKeyOf(activeRepoId);

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

  const stop = (): void => {
    const bucket = runningBucketRef.current ?? activeBucket;
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
    setBusyForKey(bucket, false);
    if (runningBucketRef.current === bucket) runningBucketRef.current = null;
    void window.codeshell.cancel(engineSessionId);
  };

  const decideEnvelope = (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
  ): void => {
    // Multi-session: thread engine sessionId so the worker routes the
    // decision back to the right session's pendingApprovals map.
    if (env.sessionId) {
      void window.codeshell.approve(env.sessionId, env.requestId, decision, reason);
    } else {
      void window.codeshell.approve(env.requestId, decision, reason);
    }
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
  };

  const showWelcome = state.messages.length === 0;

  const setViewMode = (v: ViewMode): void => setView((prev) => ({ ...prev, viewMode: v }));

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
  }, [paletteOpen, searchOpen, sessionIndices, activeRepoId]);

  useEffect(() => {
    const off = window.codeshell.onMenuEvent((evt, payload) => {
      switch (evt) {
        case "add-project":
          void handleAddRepo();
          break;
        case "open-recent": {
          const p = payload as { path: string; name: string } | undefined;
          if (!p) return;
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
        setActiveModelKey(resolveActiveKey(merged));
        const permissions = merged.permissions && typeof merged.permissions === "object"
          ? (merged.permissions as Record<string, unknown>)
          : {};
        setDefaultPermissionMode(fromSettingsPermissionMode(merged.permissionMode ?? permissions.defaultMode));
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
    setActiveModelKey(opt.key);
    // Persist the choice for next process start.
    void window.codeshell.updateSettings("user", { activeKey: opt.key });
    // Notify the running agent worker immediately so the switch takes
    // effect on the very next turn — without this, the worker (which
    // reads llmConfig once at bootstrap) stays on the old model until
    // the electron process is restarted.
    void window.codeshell.configure({ model: opt.key });
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
          approvalsBadge={approvalQueue.length}
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
          <RunsView />
        ) : view.viewMode === "automation" ? (
          <AutomationView onCreateConversational={startConversationalAutomation} />
        ) : (
          <>
            <ChatView
              messages={state.messages}
              turnEpoch={state.turnEpoch}
              liveTurnActive={busy && state.streamingAssistantId !== null}
              onSend={send}
              onStop={stop}
              busy={busy}
              activeRepoId={activeRepoId}
              composerSeed={composerSeed}
              composerSeedNonce={composerSeedNonce}
              onAskUserAnswer={handleAskUserAnswer}
              pendingApproval={approval}
              onApprovalDecide={
                approval
                  ? (decision, reason) => decideEnvelope(approval, decision, reason)
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
              onSelectRepo={setActiveRepoId}
              onAddRepo={() => { void handleAddRepo(); }}
              activeRepoPath={activeRepo?.path ?? null}
              repoClean={activeGitMeta.clean}
              welcomeNode={
                showWelcome ? (
                  <div className="welcome">
                    <div className="welcome-title">
                      {activeRepo
                        ? `要在 ${activeRepo.name} 中构建什么?`
                        : `开始一个无项目对话`}
                    </div>
                    {!activeRepo && (
                      <div className="welcome-hint">
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
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={buildCommands({
          setViewMode,
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
