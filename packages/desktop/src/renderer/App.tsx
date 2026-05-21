import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentClient } from "../../../../src/protocol/client.js";
import {
  IpcTransport,
  type IpcSink,
  type IpcSubscribe,
} from "../../../../src/protocol/transport.js";
import type { StreamEvent } from "../../../../src/types.js";

/**
 * Build an IpcTransport that talks to main through the preload bridge
 * exposed at window.codeShell. The renderer never touches ipcRenderer
 * directly — that surface is intentionally minimal so we can audit it.
 */
function buildClient(): AgentClient {
  const sink: IpcSink = (msg) => window.codeShell.sendRpc(msg);
  const subscribe: IpcSubscribe = (handler) => {
    const wrapped = window.codeShell.onRpc((msg) =>
      handler(msg as Parameters<typeof handler>[0]),
    );
    return () => window.codeShell.removeRpcListener(wrapped);
  };
  const transport = new IpcTransport(sink, subscribe);
  return new AgentClient({ transport });
}

type Bubble =
  | { role: "user"; text: string; id: string }
  | { role: "assistant"; text: string; id: string; pending?: boolean };

export function App(): React.ReactElement {
  const client = useMemo(() => buildClient(), []);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const currentAsstId = useRef<string | null>(null);

  useEffect(() => {
    client.onStreamEvent((ev: StreamEvent) => {
      // POC: only render text_delta + assistant_message + turn_complete.
      // Tool calls etc. ignored for now — Phase 2 wires them up.
      if (ev.type === "text_delta" && ev.text) {
        const aid = currentAsstId.current;
        if (!aid) return;
        setBubbles((prev) =>
          prev.map((b) =>
            b.id === aid && b.role === "assistant"
              ? { ...b, text: b.text + ev.text }
              : b,
          ),
        );
      } else if (ev.type === "turn_complete") {
        const aid = currentAsstId.current;
        if (aid) {
          setBubbles((prev) =>
            prev.map((b) =>
              b.id === aid && b.role === "assistant"
                ? { ...b, pending: false }
                : b,
            ),
          );
        }
      }
    });
  }, [client]);

  const onSubmit = async (): Promise<void> => {
    const task = input.trim();
    if (!task || running) return;
    setInput("");
    const userId = `u-${Date.now()}`;
    const asstId = `a-${Date.now()}`;
    currentAsstId.current = asstId;
    setBubbles((prev) => [
      ...prev,
      { role: "user", text: task, id: userId },
      { role: "assistant", text: "", id: asstId, pending: true },
    ]);
    setRunning(true);
    try {
      const result = await client.run(task, sessionId);
      if (result.sessionId && !sessionId) setSessionId(result.sessionId);
      // Final text already streamed via text_delta; just clear pending.
      setBubbles((prev) =>
        prev.map((b) =>
          b.id === asstId && b.role === "assistant"
            ? { ...b, pending: false }
            : b,
        ),
      );
    } catch (err) {
      setBubbles((prev) =>
        prev.map((b) =>
          b.id === asstId && b.role === "assistant"
            ? {
                ...b,
                text: `[error] ${(err as Error).message}`,
                pending: false,
              }
            : b,
        ),
      );
    } finally {
      setRunning(false);
      currentAsstId.current = null;
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        maxWidth: 760,
        margin: "0 auto",
        padding: "16px 12px",
        boxSizing: "border-box",
      }}
    >
      <header
        style={{
          fontSize: 13,
          opacity: 0.6,
          marginBottom: 8,
          letterSpacing: 0.3,
        }}
      >
        code-shell · desktop POC
        {sessionId ? ` · ${sessionId.slice(0, 12)}` : ""}
      </header>

      <main
        style={{
          flex: 1,
          overflowY: "auto",
          paddingRight: 4,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {bubbles.length === 0 && (
          <div
            style={{
              alignSelf: "center",
              opacity: 0.45,
              marginTop: "30vh",
              fontSize: 14,
            }}
          >
            Ask code-shell something.
          </div>
        )}
        {bubbles.map((b) => (
          <Bubble key={b.id} bubble={b} />
        ))}
      </main>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        style={{ marginTop: 16, display: "flex", gap: 8 }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={running ? "thinking…" : "Type a task"}
          disabled={running}
          autoFocus
          style={{
            flex: 1,
            border: "1px solid rgba(127,127,127,0.3)",
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 14,
            background: "transparent",
            color: "inherit",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={running || input.trim().length === 0}
          style={{
            border: "1px solid rgba(127,127,127,0.3)",
            borderRadius: 10,
            padding: "10px 16px",
            background: running ? "transparent" : "#0f0f0f",
            color: running ? "inherit" : "#fafafa",
            cursor: running ? "default" : "pointer",
            fontSize: 14,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function Bubble({ bubble }: { bubble: Bubble }): React.ReactElement {
  const isUser = bubble.role === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "80%",
        borderRadius: 12,
        padding: "10px 14px",
        fontSize: 14,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        background: isUser
          ? "rgba(15, 98, 254, 0.12)"
          : "rgba(127,127,127,0.10)",
      }}
    >
      {bubble.text}
      {bubble.role === "assistant" && bubble.pending && bubble.text === "" && (
        <span style={{ opacity: 0.4 }}>…</span>
      )}
    </div>
  );
}
