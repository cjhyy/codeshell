import React, { useEffect, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
import { Sidebar } from "./Sidebar";
import {
  applyStreamEvent,
  appendUserMessage,
  INITIAL_STATE,
  type MessagesReducerState,
  type ApprovalState,
} from "./types";
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

type Action =
  | { type: "user_message"; text: string }
  | { type: "stream"; event: StreamEvent }
  | { type: "reset" };

function reducer(state: MessagesReducerState, action: Action): MessagesReducerState {
  if (action.type === "user_message") return appendUserMessage(state, action.text);
  if (action.type === "reset") return INITIAL_STATE;
  return applyStreamEvent(state, action.event);
}

function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState<Repo[]>(() => loadRepos());
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => loadActiveRepoId());

  useEffect(() => { saveRepos(repos); }, [repos]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);

  // Clear the conversation when the active repo changes. Each repo gets
  // its own "fresh chat" — Phase 3b will replace this with real
  // per-repo session persistence, but until then the right UX is to
  // show that switching context = new conversation, not the old one
  // dangling over the new repo. Skip on first mount (when both prev
  // and curr come from localStorage and we're not switching anything).
  const prevRepoIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevRepoIdRef.current !== undefined && prevRepoIdRef.current !== activeRepoId) {
      dispatch({ type: "reset" });
      setApproval(null);
      setLifecycle(null);
      void window.codeshell.cancel().catch(() => {/* worker may already be dead */});
    }
    prevRepoIdRef.current = activeRepoId;
  }, [activeRepoId]);

  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null;

  const handleAddRepo = async (): Promise<void> => {
    window.codeshell.log("sidebar.add_clicked", {});
    const picked = await window.codeshell.pickDir();
    if (!picked) return;
    if (repos.some((r) => r.path === picked.path)) {
      // Already added — just select it instead of duplicating.
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
      window.codeshell.log("stream.event", {
        type: event.type,
        textLen: "text" in event ? (event as { text: string }).text.length : undefined,
      });
      dispatch({ type: "stream", event });
      if (event.type === "turn_complete") setBusy(false);
      if (event.type === "error") setBusy(false);
    });
    const offApproval = window.codeshell.onApprovalRequest((env: ApprovalRequestEnvelope) => {
      window.codeshell.log("approval.request", { requestId: env.requestId, toolName: env.request.toolName });
      setApproval(env);
    });
    const offStatus = window.codeshell.onStatus((evt) => {
      window.codeshell.log("status", evt as Record<string, unknown>);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      window.codeshell.log("lifecycle", evt as Record<string, unknown>);
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        // code=0 means the worker self-exited cleanly after a turn — that's
        // the expected on-demand-spawn flow, not an error worth banner-ing.
        // Anything else is a crash and the user should see it.
        if (evt.code === 0) {
          setLifecycle(null);
          setBusy(false); // defensive: in case turn_complete somehow didn't fire
        } else {
          setLifecycle(`Agent exited (code ${evt.code}).`);
          setBusy(false);
        }
      }
    });
    return () => {
      offStream();
      offApproval();
      offStatus();
      offLifecycle();
    };
  }, []);

  // Track state changes so we can tell whether the reducer ran but the
  // UI didn't update vs. the reducer never ran at all.
  useEffect(() => {
    window.codeshell.log("state.update", {
      messageCount: state.messages.length,
      streamingId: state.streamingAssistantId,
      last: state.messages.at(-1) as Record<string, unknown> | undefined,
    });
  }, [state]);

  const send = (text: string): void => {
    window.codeshell.log("send", { textLen: text.length, repo: activeRepo?.name ?? null });
    dispatch({ type: "user_message", text });
    setBusy(true);
    void window.codeshell.run(text, activeRepo ? { cwd: activeRepo.path } : undefined).then((r) =>
      window.codeshell.log("run.resolved", { result: r as unknown as Record<string, unknown> }),
    );
  };

  const stop = (): void => {
    window.codeshell.log("stop.click", {});
    void window.codeshell.cancel();
    // Don't clear busy here — let turn_complete/error event do it,
    // matching the existing run-complete code path.
  };

  const decide = (decision: "approve" | "deny", reason?: string): void => {
    if (!approval) return;
    void window.codeshell.approve(approval.requestId, decision, reason);
    setApproval(null);
  };

  const showWelcome = state.messages.length === 0;

  return (
    <div className="app-grid">
      <Sidebar
        repos={repos}
        activeRepoId={activeRepoId}
        onSelectRepo={setActiveRepoId}
        onAddRepo={() => { void handleAddRepo(); }}
        onRemoveRepo={handleRemoveRepo}
      />
      <main className="main">
        {lifecycle && <div className="banner">{lifecycle}</div>}
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
        <ChatView messages={state.messages} onSend={send} onStop={stop} busy={busy} activeRepoId={activeRepoId} />
        {approval && <ApprovalModal envelope={approval} onDecide={decide} />}
      </main>
    </div>
  );
}

// Named export for main.tsx which uses `import { App }`
export { App };
export default App;
