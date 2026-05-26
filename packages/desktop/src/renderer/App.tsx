import React, { useCallback, useEffect, useRef, useState } from "react";
import type { StreamEnvelope } from "../preload/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionState {
  sessionId: string;
  label: string;
  lines: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Narrow the raw unknown event to pull out a displayable line of text. */
function eventToLine(event: unknown): string | null {
  if (event == null || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;

  // text_delta — most common streaming event
  if (e.type === "text_delta" && typeof e.text === "string") {
    return e.text;
  }
  // assistant message with content array
  if (e.type === "assistant_message") {
    return `[assistant_message]`;
  }
  // tool_use / tool_result summary
  if (e.type === "tool_use" && typeof e.name === "string") {
    return `[tool_use: ${e.name}]`;
  }
  if (e.type === "tool_result") {
    return `[tool_result]`;
  }
  // run_complete / error
  if (e.type === "run_complete") return `[run_complete]`;
  if (e.type === "error" && typeof e.message === "string") return `[error: ${e.message}]`;

  // Fallback: stringify the type field or the whole event
  if (typeof e.type === "string") return `[${e.type}]`;
  try {
    return JSON.stringify(event).slice(0, 120);
  } catch {
    return "[unknown event]";
  }
}

// ─── SessionPanel ─────────────────────────────────────────────────────────────

interface SessionPanelProps {
  session: SessionState;
  onClose: (sessionId: string) => void;
  onCancel: (sessionId: string) => void;
}

function SessionPanel({ session, onClose, onCancel }: SessionPanelProps): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom whenever lines change
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [session.lines]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        border: "1px solid #d1d5db",
        borderRadius: 6,
        padding: 10,
        background: "#fff",
        minWidth: 280,
        flex: "1 1 280px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 12, color: "#374151" }}>
          {session.label}
        </span>
        <button
          onClick={() => onCancel(session.sessionId)}
          style={smallBtn}
          title="Cancel running turn"
        >
          Cancel
        </button>
        <button
          onClick={() => onClose(session.sessionId)}
          style={{ ...smallBtn, background: "#fee2e2", color: "#b91c1c" }}
          title="Close session and free resources"
        >
          Close
        </button>
      </div>

      {/* Session ID (truncated) */}
      <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>
        {session.sessionId}
      </div>

      {/* Output area */}
      <textarea
        ref={textareaRef}
        readOnly
        value={session.lines.join("")}
        style={{
          flex: 1,
          minHeight: 180,
          resize: "vertical",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          padding: 8,
          border: "1px solid #e5e7eb",
          borderRadius: 4,
          background: "#f9fafb",
          color: "#111827",
          lineHeight: 1.5,
        }}
      />
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  background: "#f9fafb",
  color: "#374151",
  cursor: "pointer",
};

// ─── App ──────────────────────────────────────────────────────────────────────

let _sessionCounter = 0;

export function App(): React.ReactElement {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  // Stable ref so the stream handler closure never becomes stale
  const sessionsRef = useRef<Map<string, SessionState>>(sessions);
  sessionsRef.current = sessions;

  const [taskInput, setTaskInput] = useState("hello from session");

  // ── Stream event handler (stable reference via useCallback) ─────────────────
  const handleStreamEvent = useCallback((env: StreamEnvelope) => {
    const { sessionId, event } = env;
    const line = eventToLine(event);
    if (line == null) return;

    setSessions((prev) => {
      const session = prev.get(sessionId);
      if (!session) return prev; // unknown sessionId — ignore
      const next = new Map(prev);
      next.set(sessionId, { ...session, lines: [...session.lines, line] });
      return next;
    });
  }, []);

  // ── Register / unregister on mount / unmount ─────────────────────────────────
  useEffect(() => {
    if (typeof window !== "undefined" && window.codeshell) {
      window.codeshell.onStreamEvent(handleStreamEvent);
    }
    return () => {
      if (typeof window !== "undefined" && window.codeshell) {
        window.codeshell.offStreamEvent(handleStreamEvent);
      }
    };
  }, [handleStreamEvent]);

  // ── Start a new session ───────────────────────────────────────────────────────
  const startSession = useCallback(() => {
    if (!window.codeshell) return;
    _sessionCounter += 1;
    const sessionId = crypto.randomUUID();
    const label = `Session ${_sessionCounter}`;
    const task = taskInput.trim() || `hello from ${label}`;

    const newSession: SessionState = { sessionId, label, lines: [] };
    setSessions((prev) => {
      const next = new Map(prev);
      next.set(sessionId, newSession);
      return next;
    });

    window.codeshell.run(task, { sessionId }).catch((err: unknown) => {
      // Surface errors into the session output
      setSessions((prev) => {
        const session = prev.get(sessionId);
        if (!session) return prev;
        const next = new Map(prev);
        const msg = err instanceof Error ? err.message : String(err);
        next.set(sessionId, { ...session, lines: [...session.lines, `[run error: ${msg}]`] });
        return next;
      });
    });
  }, [taskInput]);

  // ── Cancel a running turn ─────────────────────────────────────────────────────
  const cancelSession = useCallback((sessionId: string) => {
    window.codeshell?.cancel(sessionId).catch(() => {/* ignore */});
  }, []);

  // ── Close a session ───────────────────────────────────────────────────────────
  const closeSession = useCallback((sessionId: string) => {
    window.codeshell?.closeSession(sessionId).catch(() => {/* ignore */});
    setSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const sessionList = Array.from(sessions.values());
  const bridgePresent = typeof window !== "undefined" && !!window.codeshell;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid #e5e7eb",
          background: "#f9fafb",
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, marginRight: 4 }}>code-shell · desktop</span>
        <input
          type="text"
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && startSession()}
          placeholder="Task prompt…"
          style={{
            flex: 1,
            maxWidth: 360,
            padding: "4px 8px",
            fontSize: 12,
            border: "1px solid #d1d5db",
            borderRadius: 4,
            outline: "none",
          }}
        />
        <button
          onClick={startSession}
          disabled={!bridgePresent}
          style={{
            padding: "4px 14px",
            fontSize: 12,
            fontWeight: 600,
            border: "none",
            borderRadius: 4,
            background: bridgePresent ? "#2563eb" : "#93c5fd",
            color: "#fff",
            cursor: bridgePresent ? "pointer" : "not-allowed",
          }}
        >
          Start session
        </button>
        <span
          style={{
            fontSize: 11,
            color: bridgePresent ? "#16a34a" : "#dc2626",
            marginLeft: 4,
          }}
        >
          {bridgePresent ? "bridge ready" : "bridge pending"}
        </span>
      </div>

      {/* Sessions area */}
      {sessionList.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            opacity: 0.5,
            fontSize: 13,
          }}
        >
          <div>No active sessions.</div>
          <div style={{ fontSize: 11 }}>
            Enter a task and click <strong>Start session</strong> to open one.
          </div>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            padding: 12,
            overflowY: "auto",
            alignContent: "flex-start",
          }}
        >
          {sessionList.map((s) => (
            <SessionPanel
              key={s.sessionId}
              session={s}
              onClose={closeSession}
              onCancel={cancelSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}
