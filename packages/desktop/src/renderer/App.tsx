import React, { useEffect, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { InspectorPanel } from "./InspectorPanel";
import {
  applyStreamEvent,
  appendUserMessage,
  INITIAL_STATE,
  type MessagesReducerState,
  type ApprovalState,
  type ToolMessage,
} from "./types";
import { loadTranscript, saveTranscript } from "./transcripts";
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

/**
 * Transcripts are keyed by repoId; null repoId uses a "global" bucket.
 * Reducer is repo-aware: every dispatched action carries the repo it
 * targets, so a stream event arriving after the user has switched
 * repos still folds into the right bucket (won't poison the new repo's
 * view, won't drop on the floor either).
 */
type TranscriptsMap = Record<string, MessagesReducerState>;

const GLOBAL_KEY = "__global__";
function bucketKey(repoId: string | null): string {
  return repoId ?? GLOBAL_KEY;
}

type Action =
  | { type: "user_message"; repoKey: string; text: string }
  | { type: "stream"; repoKey: string; event: StreamEvent }
  | { type: "hydrate"; repoKey: string; state: MessagesReducerState };

function reducer(map: TranscriptsMap, action: Action): TranscriptsMap {
  if (action.type === "hydrate") {
    return { ...map, [action.repoKey]: action.state };
  }
  const current = map[action.repoKey] ?? INITIAL_STATE;
  const next =
    action.type === "user_message"
      ? appendUserMessage(current, action.text)
      : applyStreamEvent(current, action.event);
  if (next === current) return map;
  return { ...map, [action.repoKey]: next };
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

  const activeRepoKey = bucketKey(activeRepoId);
  const runningRepoKeyRef = useRef<string | null>(null);

  useEffect(() => { saveRepos(repos); }, [repos]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);
  useEffect(() => { saveView(view); }, [view]);

  useEffect(() => {
    if (transcripts[activeRepoKey]) return;
    const loaded = loadTranscript(activeRepoId);
    dispatch({ type: "hydrate", repoKey: activeRepoKey, state: loaded });
  }, [activeRepoKey, activeRepoId, transcripts]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const s = transcripts[activeRepoKey];
      if (!s) return;
      const repoId = activeRepoKey === GLOBAL_KEY ? null : activeRepoKey;
      saveTranscript(repoId, s);
    }, 600);
    return () => clearTimeout(handle);
  }, [transcripts, activeRepoKey]);

  const state = transcripts[activeRepoKey] ?? INITIAL_STATE;
  const busy = busyKeys.has(activeRepoKey);
  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null;

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
    if (repos.some((r) => r.path === picked.path)) {
      const existing = repos.find((r) => r.path === picked.path);
      if (existing) setActiveRepoId(existing.id);
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
    window.codeshell.log("repo.added", { id: next.id, path: next.path });
  };

  const handleRemoveRepo = (id: string): void => {
    setRepos((prev) => prev.filter((r) => r.id !== id));
    if (activeRepoId === id) setActiveRepoId(null);
    window.codeshell.log("repo.removed", { id });
  };

  useEffect(() => {
    window.codeshell.log("app.mount", { codeshellKeys: Object.keys(window.codeshell ?? {}) });

    const offStream = window.codeshell.onStreamEvent((event: StreamEvent) => {
      const targetKey = runningRepoKeyRef.current ?? GLOBAL_KEY;
      const noisy =
        event.type === "text_delta" ||
        event.type === "tool_use_args_delta" ||
        event.type === "usage_update" ||
        event.type === "thinking_delta";
      if (!noisy) {
        window.codeshell.log("stream.event", { type: event.type, targetKey });
      }
      dispatch({ type: "stream", repoKey: targetKey, event });
      if (event.type === "turn_complete" || event.type === "error") {
        setBusyForKey(targetKey, false);
        runningRepoKeyRef.current = null;
      }
    });
    const offApproval = window.codeshell.onApprovalRequest((env: ApprovalRequestEnvelope) => {
      window.codeshell.log("approval.request", { requestId: env.requestId, toolName: env.request.toolName });
      setApprovalQueue((q) => [...q, env]);
      // First-in-queue also becomes the modal blocker so the existing
      // blocking flow keeps working for the user looking at chat.
      setApproval((cur) => cur ?? env);
    });
    const offStatus = window.codeshell.onStatus((evt) => {
      window.codeshell.log("status", evt as Record<string, unknown>);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      window.codeshell.log("lifecycle", evt as Record<string, unknown>);
      const runningKey = runningRepoKeyRef.current;
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        if (evt.code === 0) setLifecycle(null);
        else setLifecycle(`Agent exited (code ${evt.code}).`);
        if (runningKey) setBusyForKey(runningKey, false);
        runningRepoKeyRef.current = null;
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
    const targetKey = activeRepoKey;
    window.codeshell.log("send", { textLen: text.length, repo: activeRepo?.name ?? null, targetKey });
    dispatch({ type: "user_message", repoKey: targetKey, text });
    setBusyForKey(targetKey, true);
    runningRepoKeyRef.current = targetKey;
    void window.codeshell
      .run(text, activeRepo ? { cwd: activeRepo.path } : undefined)
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
        // Promote next queued envelope into modal (if any).
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

  return (
    <div
      className="app-grid"
      data-sidebar={view.sidebarCollapsed ? "collapsed" : "open"}
      data-inspector={view.inspectorCollapsed ? "collapsed" : "open"}
    >
      <div className="topbar-region">
        <TopBar
          repoName={activeRepo?.name ?? null}
          sessionTitle={state.sessionId ? state.sessionId.slice(0, 8) : null}
          branch={null}
          model={null}
          permissionMode={null}
          promptTokens={state.promptTokens > 0 ? state.promptTokens : undefined}
          busy={busy}
        />
      </div>

      <div className="sidebar-region">
        <Sidebar
          repos={repos}
          activeRepoId={activeRepoId}
          onSelectRepo={setActiveRepoId}
          onAddRepo={() => { void handleAddRepo(); }}
          onRemoveRepo={handleRemoveRepo}
          viewMode={view.viewMode}
          onSelectView={setViewMode}
          approvalsBadge={approvalQueue.length}
          runsBadge={busy ? 1 : 0}
        />
      </div>

      <main className="main-region main">
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
        ) : view.viewMode === "chat" ? (
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
            />
          </>
        ) : (
          <div className="view-placeholder">
            <div className="view-placeholder-title">{viewLabel(view.viewMode)}</div>
            <div className="view-placeholder-hint">该视图将在后续阶段实现</div>
          </div>
        )}
        {approval && <ApprovalModal envelope={approval} onDecide={decide} />}
      </main>

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

function viewLabel(v: ViewMode): string {
  switch (v) {
    case "sessions": return "会话";
    case "approvals": return "审批";
    case "runs": return "运行";
    case "mcp": return "插件";
    case "logs": return "日志";
    case "settings": return "设置";
    default: return v;
  }
}

export { App };
export default App;
