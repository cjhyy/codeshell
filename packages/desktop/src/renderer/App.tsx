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

function App() {
  const [transcripts, dispatch] = useReducer(reducer, {} as TranscriptsMap);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  /** Repo keys currently waiting on the agent worker to finish a run. */
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const [repos, setRepos] = useState<Repo[]>(() => loadRepos());
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => loadActiveRepoId());

  /**
   * `activeRepoKey` is what we currently *show*. `runningRepoKey` is
   * what the in-flight worker actually belongs to — set when send()
   * fires, used to route incoming stream events back to the right
   * bucket even if the user has since switched repos.
   */
  const activeRepoKey = bucketKey(activeRepoId);
  const runningRepoKeyRef = useRef<string | null>(null);

  useEffect(() => { saveRepos(repos); }, [repos]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);

  // Lazy-load a repo's transcript on first view, so cold start doesn't
  // read every persisted bucket into memory upfront.
  useEffect(() => {
    if (transcripts[activeRepoKey]) return;
    const loaded = loadTranscript(activeRepoId);
    dispatch({ type: "hydrate", repoKey: activeRepoKey, state: loaded });
  }, [activeRepoKey, activeRepoId, transcripts]);

  // Persist transcripts whenever they change.
  useEffect(() => {
    for (const [key, s] of Object.entries(transcripts)) {
      const repoId = key === GLOBAL_KEY ? null : key;
      saveTranscript(repoId, s);
    }
  }, [transcripts]);

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
      // Route every stream event back to the repo whose send() spawned
      // the worker, NOT to whatever repo is currently visible — the
      // user may have switched repos while the run is mid-flight.
      const targetKey = runningRepoKeyRef.current ?? GLOBAL_KEY;
      window.codeshell.log("stream.event", {
        type: event.type,
        textLen: "text" in event ? (event as { text: string }).text.length : undefined,
        targetKey,
      });
      dispatch({ type: "stream", repoKey: targetKey, event });
      if (event.type === "turn_complete" || event.type === "error") {
        setBusyForKey(targetKey, false);
        runningRepoKeyRef.current = null;
      }
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
      const runningKey = runningRepoKeyRef.current;
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        if (evt.code === 0) {
          setLifecycle(null);
        } else {
          setLifecycle(`Agent exited (code ${evt.code}).`);
        }
        // Worker is gone — clear busy for whichever repo it was running.
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

  // Track state changes so we can tell whether the reducer ran but the
  // UI didn't update vs. the reducer never ran at all.
  useEffect(() => {
    window.codeshell.log("state.update", {
      activeKey: activeRepoKey,
      messageCount: state.messages.length,
      streamingId: state.streamingAssistantId,
      last: state.messages.at(-1) as Record<string, unknown> | undefined,
    });
  }, [state, activeRepoKey]);

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
