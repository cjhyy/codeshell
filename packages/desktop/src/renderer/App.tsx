import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { InspectorPanel } from "./InspectorPanel";
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
  touchSession,
  setActiveSession,
  type SessionIndex,
} from "./transcripts";
import type {
  AgentLifecycleEvent,
  ApprovalRequestEnvelope,
} from "../preload/types";
import {
  loadRepos,
  saveRepos,
  loadActiveRepoId,
  saveActiveRepoId,
  makeRepoId,
  type Repo,
} from "./repos";
import { loadView, saveView, type ViewState, type ViewMode } from "./view";
import { PanelLeft } from "./ui/icons";
import { IconButton } from "./ui/IconButton";
import { ApprovalsView } from "./approvals/ApprovalsView";
import { LogsView } from "./logs/LogsView";
// SettingsView replaced by SettingsMenu + SettingsModal triggered from sidebar bottom.
import { McpView } from "./mcp/McpView";
import { RunsView } from "./runs/RunsView";
import { CommandPalette, buildCommands } from "./shell/CommandPalette";
import { SearchBar } from "./shell/SearchBar";
import { TrustGate } from "./workspace-trust/TrustGate";
import { UpdaterBanner } from "./updater/UpdaterBanner";
import type { PermissionMode } from "./chat/PermissionPill";
import type { ModelOption } from "./chat/ModelPill";

const GLOBAL_KEY = "__global__";
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
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeModel, setActiveModel] = useState<{ provider: string; model: string } | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
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
  const runningBucketRef = useRef<string | null>(null);
  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null;

  useEffect(() => { saveRepos(repos); }, [repos]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);
  useEffect(() => { saveView(view); }, [view]);

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
  const busy = busyKeys.has(activeBucket);

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

  const handleSelectSession = (repoId: string | null, sessionId: string): void => {
    const key = repoKeyOf(repoId);
    setActiveRepoId(repoId);
    setSessionIndices((prev) => ({
      ...prev,
      [key]: setActiveSession(repoId, sessionId),
    }));
    setSelectedToolId(null);
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
    setSelectedToolId(null);
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
    const next = deleteSessionLocal(repoId, sessionId);
    setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));
  };

  useEffect(() => {
    window.codeshell.log("app.mount", { codeshellKeys: Object.keys(window.codeshell ?? {}) });

    const offStream = window.codeshell.onStreamEvent((event: StreamEvent) => {
      const target = runningBucketRef.current;
      if (!target) return;
      const noisy =
        event.type === "text_delta" ||
        event.type === "tool_use_args_delta" ||
        event.type === "usage_update" ||
        event.type === "thinking_delta";
      if (!noisy) {
        window.codeshell.log("stream.event", { type: event.type, bucket: target });
      }
      dispatch({ type: "stream", bucket: target, event });

      // Bind engine sessionId back to the UI session on the first
      // session_started for this run. Subsequent sends in the same UI
      // session will pass this id explicitly so the worker resumes the
      // right engine conversation instead of guessing.
      if (event.type === "session_started") {
        // target is "repoKey::uiSessionId"
        const sep = target.indexOf("::");
        if (sep > 0) {
          const repoKey = target.slice(0, sep);
          const uiSessionId = target.slice(sep + 2);
          const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
          if (uiSessionId && uiSessionId !== "_none_") {
            const nextIdx = bindEngineSession(repoId, uiSessionId, event.sessionId);
            setSessionIndices((prev) => ({ ...prev, [repoKey]: nextIdx }));
          }
        }
      }

      if (event.type === "turn_complete" || event.type === "error") {
        setBusyForKey(target, false);
        runningBucketRef.current = null;
      }
    });
    const offApproval = window.codeshell.onApprovalRequest((env: ApprovalRequestEnvelope) => {
      window.codeshell.log("approval.request", { requestId: env.requestId, toolName: env.request.toolName });
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
        const bucket = runningBucketRef.current ?? activeBucket;
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
      setApprovalQueue((q) => [...q, env]);
      setApproval((cur) => cur ?? env);
    });
    const offStatus = window.codeshell.onStatus((evt) => {
      window.codeshell.log("status", evt as Record<string, unknown>);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      window.codeshell.log("lifecycle", evt as Record<string, unknown>);
      const runningKey = runningBucketRef.current;
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        if (evt.code === 0) setLifecycle(null);
        else setLifecycle(`Agent exited (code ${evt.code}).`);
        if (runningKey) setBusyForKey(runningKey, false);
        runningBucketRef.current = null;
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
    window.codeshell.log("send", { textLen: text.length, repo: activeRepo?.name ?? null, bucket });
    dispatch({ type: "user_message", bucket, text });
    setBusyForKey(bucket, true);
    runningBucketRef.current = bucket;

    // Touch session: bump updatedAt + adopt first user prompt as title.
    setSessionIndices((prev) => ({
      ...prev,
      [repoKeyOf(activeRepoId)]: touchSession(activeRepoId, sid, text),
    }));

    // Resolve the engine sessionId bound to this UI session, if any.
    // First send of a UI session → undefined → core creates a fresh
    // engine session and we'll capture its id from session_started.
    // Without this, core silently resumes the last active engine
    // session, which is why '新对话' was leaking the previous chat's
    // context (it greeted itself with "我是新的对话...").
    const repoKey = repoKeyOf(activeRepoId);
    const summary =
      sessionIndices[repoKey]?.sessions.find((s) => s.id === sid)
      // fallback: ensureActiveSession just persisted but state may not have
      // re-read yet — pull from localStorage to be safe.
      ?? loadSessionIndex(activeRepoId).sessions.find((s) => s.id === sid);
    const engineSessionId = summary?.engineSessionId;

    const opts: { cwd?: string; sessionId?: string } = {};
    if (activeRepo) opts.cwd = activeRepo.path;
    if (engineSessionId) opts.sessionId = engineSessionId;

    void window.codeshell
      .run(text, opts)
      .then((r) =>
        window.codeshell.log("run.resolved", { result: r as unknown as Record<string, unknown> }),
      );
  };

  const stop = (): void => {
    window.codeshell.log("stop.click", {});
    void window.codeshell.cancel();
  };

  const decideEnvelope = (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
  ): void => {
    void window.codeshell.approve(env.requestId, decision, reason);
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

  const decide = (decision: "approve" | "deny", reason?: string): void => {
    if (!approval) return;
    decideEnvelope(approval, decision, reason);
  };

  const showWelcome = state.messages.length === 0;

  const setViewMode = (v: ViewMode): void => setView((prev) => ({ ...prev, viewMode: v }));
  const toggleSidebar = (): void =>
    setView((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  const toggleInspector = (): void =>
    setView((p) => ({ ...p, inspectorCollapsed: !p.inspectorCollapsed }));

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        toggleInspector();
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
          toggleInspector();
          break;
        case "new-window":
          void window.codeshell.newWindow();
          break;
      }
    });
    return off;
  }, [repos]);

  // Refresh model + permission + provider list from settings whenever
  // active repo or view changes (after a SettingsView write the user
  // typically returns to chat — that's our cue to re-poll).
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const cwd = activeRepo?.path;
        const projectS = cwd ? (await window.codeshell.getSettings("project", cwd)) ?? {} : {};
        const userS = (await window.codeshell.getSettings("user")) ?? {};
        const merged: Record<string, unknown> = { ...userS, ...projectS };
        if (cancelled) return;
        setActiveModel(
          typeof merged.model === "string" && typeof merged.provider === "string"
            ? { provider: merged.provider, model: merged.model }
            : null,
        );
        const pm = typeof merged.permissionMode === "string" ? merged.permissionMode : "default";
        setPermissionMode(
          pm === "plan" || pm === "default" || pm === "accept_edits" || pm === "bypass"
            ? (pm as PermissionMode)
            : "default",
        );
        setModelOptions(candidatesFromSettings(merged));
      } catch {
        // ignore
      }
    };
    void refresh();
    return () => { cancelled = true; };
  }, [activeRepo, view.viewMode]);

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
    void window.codeshell.approve(requestId, "approve", undefined, answer);
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
    setPermissionMode(m);
    void window.codeshell.updateSettings("user", { permissionMode: m });
  };

  const onModelChange = (opt: ModelOption): void => {
    setActiveModel({ provider: opt.provider, model: opt.model });
    void window.codeshell.updateSettings("user", { provider: opt.provider, model: opt.model });
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

  return (
    <div
      className="app-grid"
      data-sidebar={view.sidebarCollapsed ? "collapsed" : "open"}
      data-inspector={view.inspectorCollapsed ? "collapsed" : "open"}
    >
      <div className="topbar-region">
        <TopBar
          repoName={activeRepo?.name ?? null}
          sessionTitle={sessionTitleForTop}
          busy={busy}
        />
      </div>

      <div className="sidebar-region">
        <Sidebar
          repos={repos}
          sessions={sessionIndices}
          activeRepoId={activeRepoId}
          activeSessionId={activeSessionId}
          collapsedRepos={collapsedRepos}
          approvalsBadge={approvalQueue.length}
          onSelectRepo={setActiveRepoId}
          onSelectSession={handleSelectSession}
          onToggleRepo={handleToggleRepo}
          onAddRepo={() => { void handleAddRepo(); }}
          onRemoveRepo={handleRemoveRepo}
          onNewConversation={handleNewConversation}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenAutomations={() => setViewMode("runs")}
          onOpenPlugins={() => setViewMode("mcp")}
          onOpenApprovals={() => setViewMode("approvals")}
          onOpenRuns={() => setViewMode("runs")}
          onOpenLogs={() => setViewMode("logs")}
          onRenameSession={handleRenameSession}
          onArchiveSession={handleArchiveSession}
          onDeleteSession={handleDeleteSession}
          activeRepoPath={activeRepo?.path ?? null}
          viewMode={view.viewMode}
        />
      </div>

      <main className="main-region main">
        <UpdaterBanner />
        <div className="main-toolbar">
          <IconButton label={view.sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} onClick={toggleSidebar}>
            <PanelLeft size={14} />
          </IconButton>
          <span className="main-toolbar-spacer" />
          <IconButton
            label={view.inspectorCollapsed ? "展开详情" : "折叠详情"}
            onClick={toggleInspector}
          >
            <PanelLeft size={14} style={{ transform: "scaleX(-1)" }} />
          </IconButton>
        </div>
        {lifecycle && <div className="banner">{lifecycle}</div>}
        {view.viewMode === "approvals" ? (
          <ApprovalsView
            queue={approvalQueue}
            history={approvalHistory}
            onDecide={decideEnvelope}
          />
        ) : view.viewMode === "logs" ? (
          <LogsView />
        ) : view.viewMode === "mcp" ? (
          <McpView />
        ) : view.viewMode === "runs" ? (
          <RunsView />
        ) : (
          <>
            {showWelcome && (
              <div className="welcome">
                <div className="welcome-title">
                  {activeRepo ? activeRepo.name : "code-shell"}
                </div>
                <div className="welcome-hint">
                  {activeRepoId === null
                    ? "先在左侧添加一个项目"
                    : "开始一个新对话 — 试试: 列出当前目录"}
                </div>
              </div>
            )}
            <ChatView
              messages={state.messages}
              onSend={send}
              onStop={stop}
              busy={busy}
              activeRepoId={activeRepoId}
              selectedToolId={selectedToolId}
              onSelectTool={(m: ToolMessage) => setSelectedToolId(m.id)}
              onAskUserAnswer={handleAskUserAnswer}
              permissionMode={permissionMode}
              onPermissionChange={onPermissionChange}
              modelOptions={modelOptions}
              activeModel={activeModel}
              onModelChange={onModelChange}
              contextTokens={state.promptTokens}
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
        {approval && <ApprovalModal envelope={approval} onDecide={decide} />}
      </main>

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

      <TrustGate
        repoPath={activeRepo?.path ?? null}
        onDecide={() => { /* trust persisted in main */ }}
      />

      <div className="inspector-region">
        <InspectorPanel
          collapsed={view.inspectorCollapsed}
          onToggle={toggleInspector}
          selectedTool={
            selectedToolId
              ? (state.messages.find(
                  (m) => m.kind === "tool" && m.id === selectedToolId,
                ) as ToolMessage | undefined) ?? null
              : null
          }
        />
      </div>
    </div>
  );
}

/** Read providers[].models[] out of merged settings into composer-ready options. */
function candidatesFromSettings(s: Record<string, unknown>): ModelOption[] {
  const out: ModelOption[] = [];
  const providers = s.providers;
  if (!Array.isArray(providers)) return out;
  for (const p of providers) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    const provider =
      typeof obj.name === "string" ? obj.name :
      typeof obj.kind === "string" ? obj.kind : "";
    const models = obj.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (typeof m === "string") out.push({ provider, model: m });
      else if (m && typeof m === "object" && typeof (m as Record<string, unknown>).name === "string") {
        const mm = m as Record<string, unknown>;
        out.push({
          provider,
          model: mm.name as string,
          label: typeof mm.label === "string" ? mm.label : undefined,
        });
      }
    }
  }
  return out;
}

export { App };
export default App;
