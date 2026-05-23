import React, { useEffect, useReducer, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
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

type Action =
  | { type: "user_message"; text: string }
  | { type: "stream"; event: StreamEvent };

function reducer(state: MessagesReducerState, action: Action): MessagesReducerState {
  if (action.type === "user_message") return appendUserMessage(state, action.text);
  return applyStreamEvent(state, action.event);
}

function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      else if (evt.type === "exited") setLifecycle(`Agent exited (code ${evt.code}).`);
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
    window.codeshell.log("send", { textLen: text.length, preview: text.slice(0, 60) });
    dispatch({ type: "user_message", text });
    setBusy(true);
    void window.codeshell.run(text).then((r) =>
      window.codeshell.log("run.resolved", { result: r as unknown as Record<string, unknown> }),
    );
  };

  const decide = (decision: "approve" | "deny", reason?: string): void => {
    if (!approval) return;
    void window.codeshell.approve(approval.requestId, decision, reason);
    setApproval(null);
  };

  return (
    <>
      {lifecycle && <div className="banner">{lifecycle}</div>}
      <ChatView messages={state.messages} onSend={send} busy={busy} />
      {approval && <ApprovalModal envelope={approval} onDecide={decide} />}
    </>
  );
}

// Named export for main.tsx which uses `import { App }`
export { App };
export default App;
