// packages/web/app/App.tsx — CodeShell browser client (no-account web host).
//
// One page: session rail on the left, chat on the right. Speaks the core
// protocol via ProtocolClient; approvals render as inline decision cards.
import React from "react";
import {
  defaultWsUrl,
  ProtocolClient,
  type ApprovalRequestPayload,
  type ConnectionState,
  type SessionSummary,
  type StreamEventPayload,
} from "./protocol.js";
import {
  appendUserMessage,
  initialChatState,
  reduceStream,
  type ChatState,
} from "../src/lib/streamReducer.js";
import { summarizeApproval } from "../src/lib/riskClassify.js";
import { chatFromTranscript, sessionTitle } from "./chat.js";

function newSessionId(): string {
  return crypto.randomUUID();
}

export function App() {
  const clientRef = React.useRef<ProtocolClient | null>(null);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [chat, setChat] = React.useState<ChatState>(initialChatState());
  const [approvals, setApprovals] = React.useState<ApprovalRequestPayload[]>([]);
  const [draft, setDraft] = React.useState("");
  const [workerNote, setWorkerNote] = React.useState<string | null>(null);
  const activeIdRef = React.useRef<string | null>(null);
  activeIdRef.current = activeId;

  const refreshSessions = React.useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const res = await client.listSessions();
      setSessions([...res.data].sort((a, b) => b.startedAt - a.startedAt));
    } catch {
      // First boot or a temporarily unavailable host — an empty list is accurate.
      setSessions([]);
    }
  }, []);

  React.useEffect(() => {
    const client = new ProtocolClient(defaultWsUrl());
    clientRef.current = client;
    const offState = client.onStateChange((state) => {
      setConnection(state);
      if (state === "open") {
        setWorkerNote(null);
        void refreshSessions();
      }
    });
    const offNotify = client.onNotification((method, params) => {
      if (method === "agent/streamEvent") {
        const { sessionId, event } = params as unknown as StreamEventPayload;
        const eventType = (event as { type?: string }).type;
        if (sessionId === activeIdRef.current) {
          setChat((prev) => reduceStream(prev, event));
        }
        if (eventType === "stream_request_start") setWorkerNote(null);
        if (eventType === "turn_complete") void refreshSessions();
        return;
      }
      if (method === "agent/approvalRequest") {
        const payload = params as unknown as ApprovalRequestPayload;
        setApprovals((prev) =>
          prev.some((a) => a.requestId === payload.requestId) ? prev : [...prev, payload],
        );
        return;
      }
      if (method === "agent/approvalResolved") {
        const requestId = (params as { requestId?: string }).requestId;
        if (requestId) setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
        return;
      }
      if (method === "serve/workerExit") {
        const clean = (params as { clean?: boolean }).clean;
        setWorkerNote(
          clean
            ? "agent worker 已退出，发送消息会自动重启"
            : "agent worker 崩溃，发送消息会自动重启",
        );
        setChat((prev) => ({ ...prev, run: "idle" }));
      }
    });
    client.connect();
    return () => {
      offState();
      offNotify();
      client.close();
    };
  }, [refreshSessions]);

  const openSession = async (sessionId: string): Promise<void> => {
    setActiveId(sessionId);
    setApprovals([]);
    setChat(initialChatState());
    const client = clientRef.current;
    if (!client) return;
    try {
      const detail = await client.sessionDetail(sessionId);
      setChat(chatFromTranscript(detail.data.transcript));
    } catch {
      // A brand-new session has no transcript yet; start empty.
    }
  };

  const startNewSession = (): void => {
    setActiveId(newSessionId());
    setApprovals([]);
    setChat(initialChatState());
  };

  const send = (): void => {
    const text = draft.trim();
    const client = clientRef.current;
    if (!text || !client) return;
    const sessionId = activeId ?? newSessionId();
    if (!activeId) setActiveId(sessionId);
    setDraft("");
    setChat((prev) => appendUserMessage(prev, text));
    client.run({ sessionId, task: text });
  };

  const decide = (payload: ApprovalRequestPayload, approved: boolean, answer?: string): void => {
    clientRef.current?.approve(
      { ...payload, sessionId: payload.sessionId ?? activeId ?? "" },
      approved,
      answer,
    );
    setApprovals((prev) => prev.filter((a) => a.requestId !== payload.requestId));
  };

  const stop = (): void => {
    if (activeId) clientRef.current?.cancel(activeId);
  };

  const running = chat.run === "running" || chat.run === "waiting";
  const workspaceCwd =
    sessions.find((session) => session.sessionId === activeId)?.cwd ?? sessions[0]?.cwd ?? null;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <span className={`dot ${connection}`} title={connection} />
          <strong>CodeShell</strong>
          <button className="ghost" onClick={startNewSession}>
            ＋ 新会话
          </button>
        </div>
        {workspaceCwd ? (
          <div className="rail-cwd" title={workspaceCwd}>
            {workspaceCwd}
          </div>
        ) : null}
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                className={s.sessionId === activeId ? "session active" : "session"}
                onClick={() => void openSession(s.sessionId)}
              >
                <span className="session-title">
                  {s.sessionId === activeId
                    ? sessionTitle(chat, s.sessionId)
                    : s.preview?.trim() || s.sessionId.slice(0, 8)}
                </span>
                <span className="session-meta">
                  {s.status} · {s.turnCount} turns
                </span>
              </button>
            </li>
          ))}
          {sessions.length === 0 ? <li className="empty">还没有会话</li> : null}
        </ul>
      </aside>

      <main className="chat">
        {workerNote ? <div className="banner">{workerNote}</div> : null}
        {connection !== "open" ? (
          <div className="banner">
            连接{connection === "connecting" ? "中…" : "已断开，重连中…"}
          </div>
        ) : null}
        <div className="messages">
          {chat.goal ? <div className="banner goal">{chat.goal}</div> : null}
          {chat.items.map((item) => {
            switch (item.kind) {
              case "user":
                return (
                  <div key={item.id} className="msg user">
                    {item.text}
                  </div>
                );
              case "assistant":
                return (
                  <div key={item.id} className="msg assistant">
                    {item.text}
                    {!item.done ? <span className="cursor">▍</span> : null}
                  </div>
                );
              case "tool":
                return (
                  <div key={item.id} className={`msg tool${item.error ? " tool-error" : ""}`}>
                    <span className="tool-head">
                      ⚙ {item.name} {item.done ? (item.error ? "✗" : "✓") : "…"}
                    </span>
                    {item.summary ? <span className="tool-summary"> {item.summary}</span> : null}
                    {item.result ? (
                      <details>
                        <summary>结果</summary>
                        <pre className="tool-result">{item.result}</pre>
                      </details>
                    ) : null}
                  </div>
                );
              case "subagent":
                return (
                  <div key={item.id} className="msg info">
                    ↳ {item.label} — {item.status}
                  </div>
                );
              case "system_error":
                return (
                  <div key={item.id} className="msg error">
                    {item.text}
                  </div>
                );
              default:
                return null;
            }
          })}
          {approvals.map((a) => (
            <ApprovalCard key={a.requestId} payload={a} onDecide={decide} />
          ))}
          {chat.items.length === 0 && approvals.length === 0 ? (
            <div className="empty-chat">选择左侧会话，或直接输入开始新对话</div>
          ) : null}
        </div>
        <footer className="composer">
          <textarea
            value={draft}
            placeholder="输入任务…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {running ? (
            <button className="stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="send" onClick={send} disabled={connection !== "open"}>
              发送
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

function ApprovalCard({
  payload,
  onDecide,
}: {
  payload: ApprovalRequestPayload;
  onDecide: (payload: ApprovalRequestPayload, approved: boolean, answer?: string) => void;
}) {
  const [answer, setAnswer] = React.useState("");
  const isAskUser = payload.request.toolName === "__ask_user__";
  const { summary, risk } = summarizeApproval(
    payload.request.args,
    payload.request.riskLevel,
    payload.request.toolName,
  );
  return (
    <div className="approval">
      <div className="approval-title">
        {isAskUser ? "Agent 提问" : `工具审批：${payload.request.toolName}`}
        {!isAskUser ? <em> · {risk}</em> : null}
      </div>
      {payload.request.description ? (
        <div className="approval-desc">{payload.request.description}</div>
      ) : null}
      {!isAskUser ? (
        <>
          <div className="approval-summary">{summary}</div>
          <details className="approval-raw">
            <summary>原始参数</summary>
            <pre className="approval-args">{JSON.stringify(payload.request.args, null, 2)}</pre>
          </details>
        </>
      ) : null}
      {isAskUser ? (
        <textarea
          className="approval-answer"
          value={answer}
          placeholder="输入回答…"
          onChange={(e) => setAnswer(e.target.value)}
        />
      ) : null}
      <div className="approval-actions">
        <button
          className="send"
          onClick={() => onDecide(payload, true, isAskUser ? answer : undefined)}
        >
          {isAskUser ? "回答" : "允许"}
        </button>
        <button className="stop" onClick={() => onDecide(payload, false)}>
          拒绝
        </button>
      </div>
    </div>
  );
}
