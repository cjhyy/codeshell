import { afterEach, describe, expect, test } from "bun:test";
import type { AgentClient, StreamEvent } from "@cjhyy/code-shell-core";
import React from "react";
import { flush, mount } from "../../../../tests/render-fixtures.js";
import { App } from "./App.js";
import { QueryGuard } from "./query-guard.js";
import { chatStore, createEntry } from "./store.js";

type StreamEnvelope = { sessionId?: string; event: StreamEvent };

class FakeAgentClient {
  private streamHandlers = new Set<(envelope: StreamEnvelope) => void>();
  private approvalHandlers = new Set<(...args: never[]) => void>();
  private transportResponse: (() => void) | undefined;
  private resolveRun:
    | ((result: {
        sessionId: string;
        text: string;
        reason: "completed";
        turnCount: number;
      }) => void)
    | undefined;

  onStreamEvent(handler: (envelope: StreamEnvelope) => void): void {
    this.streamHandlers.add(handler);
  }

  offStreamEvent(handler: (envelope: StreamEnvelope) => void): void {
    this.streamHandlers.delete(handler);
  }

  onApprovalRequest(handler: (...args: never[]) => void): void {
    this.approvalHandlers.add(handler);
  }

  offApprovalRequest(handler: (...args: never[]) => void): void {
    this.approvalHandlers.delete(handler);
  }

  async goalGetState(): Promise<null> {
    return null;
  }

  async cancel(): Promise<void> {}

  run(_task: unknown, _options?: unknown, onTransportResponse?: () => void): Promise<unknown> {
    this.transportResponse = onTransportResponse;
    return new Promise((resolve) => {
      this.resolveRun = resolve;
    });
  }

  hasPendingRun(): boolean {
    return this.resolveRun !== undefined;
  }

  finishLocal(sessionId: string): void {
    const onTransportResponse = this.transportResponse;
    const resolveRun = this.resolveRun;
    if (!onTransportResponse || !resolveRun) throw new Error("expected a pending local run");
    this.transportResponse = undefined;
    this.resolveRun = undefined;
    onTransportResponse();
    resolveRun({ sessionId, text: "local answer", reason: "completed", turnCount: 1 });
  }

  handOffToExternal(sessionId: string): void {
    const onTransportResponse = this.transportResponse;
    const resolveRun = this.resolveRun;
    if (!onTransportResponse || !resolveRun) throw new Error("expected a pending local run");
    this.transportResponse = undefined;
    this.resolveRun = undefined;

    // Match the TCP parser's same-chunk ordering: local response callback,
    // then the queued external run's early events, then the old Promise turn.
    onTransportResponse();
    this.emit(sessionId, { type: "session_started", sessionId, promptTokens: 0 } as StreamEvent);
    this.emit(sessionId, { type: "text_delta", text: "external early", tokens: 2 } as StreamEvent);
    resolveRun({ sessionId, text: "local answer", reason: "completed", turnCount: 1 });
  }

  emit(sessionId: string, event: StreamEvent): void {
    for (const handler of this.streamHandlers) handler({ sessionId, event });
  }
}

describe("App server-driven turn lifecycle", () => {
  afterEach(() => chatStore.clear());

  test("finalizes buffered text and releases only the external query owner", async () => {
    const client = new FakeAgentClient();
    const queryGuard = new QueryGuard();
    chatStore.setEntries([
      createEntry({ type: "thinking" }),
      createEntry({ type: "tool_running", toolName: "Read" }),
    ]);

    const harness = mount(
      <App
        client={client as unknown as AgentClient}
        model="test-model"
        effort="medium"
        maxTurns={4}
        cwd="/tmp"
        maxContextTokens={16_000}
        sessionId="external-session"
        queryGuard={queryGuard}
      />,
    );

    try {
      await flush();
      client.emit("external-session", {
        type: "session_started",
        sessionId: "external-session",
        promptTokens: 0,
      } as StreamEvent);
      expect(queryGuard.getSnapshot()).toBe(true);

      client.emit("external-session", {
        type: "text_delta",
        text: "external answer",
        tokens: 2,
      } as StreamEvent);
      client.emit("external-session", { type: "turn_complete" } as StreamEvent);

      expect(queryGuard.getSnapshot()).toBe(false);
      expect(chatStore.getEntries()).toEqual([
        expect.objectContaining({
          type: "assistant_text",
          text: "external answer",
          streaming: false,
        }),
      ]);
      expect(
        chatStore
          .getEntries()
          .some((entry) => entry.type === "thinking" || entry.type === "tool_running"),
      ).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test("a local response cannot double-finalize the next external turn's early buffer", async () => {
    const client = new FakeAgentClient();
    const queryGuard = new QueryGuard();
    const sessionId = "handoff-session";
    const harness = mount(
      <App
        client={client as unknown as AgentClient}
        model="test-model"
        effort="medium"
        maxTurns={4}
        cwd="/tmp"
        maxContextTokens={16_000}
        sessionId={sessionId}
        prefill="start local"
        queryGuard={queryGuard}
      />,
    );

    try {
      await flush();
      harness.stdin.write("\r");
      await flush();
      expect(client.hasPendingRun()).toBe(true);

      client.emit(sessionId, {
        type: "session_started",
        sessionId,
        promptTokens: 0,
      } as StreamEvent);
      client.emit(sessionId, {
        type: "text_delta",
        text: "local answer",
        tokens: 2,
      } as StreamEvent);
      client.handOffToExternal(sessionId);
      await flush();
      await flush();

      expect(queryGuard.getSnapshot()).toBe(true);
      const externalBeforeTerminal = chatStore
        .getEntries()
        .find((entry) => entry.type === "assistant_text" && entry.text.includes("external early"));
      if (externalBeforeTerminal?.type === "assistant_text") {
        expect(externalBeforeTerminal.streaming).toBe(true);
      }

      client.emit(sessionId, { type: "turn_complete" } as StreamEvent);
      expect(queryGuard.getSnapshot()).toBe(false);
      expect(
        chatStore
          .getEntries()
          .filter((entry) => entry.type === "assistant_text")
          .map((entry) => ({ text: entry.text, streaming: entry.streaming })),
      ).toEqual([
        { text: "local answer", streaming: false },
        { text: "external early", streaming: false },
      ]);
    } finally {
      harness.unmount();
    }
  });

  test("late events from a cancelled external turn stay hidden before the queued local run", async () => {
    const client = new FakeAgentClient();
    const queryGuard = new QueryGuard();
    const sessionId = "external-cancel-session";
    const harness = mount(
      <App
        client={client as unknown as AgentClient}
        model="test-model"
        effort="medium"
        maxTurns={4}
        cwd="/tmp"
        maxContextTokens={16_000}
        sessionId={sessionId}
        prefill="start queued local"
        queryGuard={queryGuard}
      />,
    );

    try {
      await flush();
      client.emit(sessionId, {
        type: "session_started",
        sessionId,
        promptTokens: 0,
      } as StreamEvent);
      await flush();
      expect(queryGuard.getSnapshot()).toBe(true);

      harness.stdin.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 75));
      await flush();
      expect(queryGuard.getSnapshot()).toBe(false);

      harness.stdin.write("\r");
      await flush();
      expect(client.hasPendingRun()).toBe(true);
      expect(queryGuard.getSnapshot()).toBe(true);

      client.emit(sessionId, {
        type: "text_delta",
        text: "cancelled external late text",
        tokens: 3,
      } as StreamEvent);
      client.emit(sessionId, {
        type: "error",
        error: "cancelled external late error",
      } as StreamEvent);
      client.emit(sessionId, { type: "turn_complete" } as StreamEvent);

      client.emit(sessionId, {
        type: "session_started",
        sessionId,
        promptTokens: 0,
      } as StreamEvent);
      client.emit(sessionId, {
        type: "text_delta",
        text: "queued local answer",
        tokens: 3,
      } as StreamEvent);
      client.finishLocal(sessionId);
      await flush();
      await flush();

      expect(queryGuard.getSnapshot()).toBe(false);
      const entries = chatStore.getEntries();
      expect(
        entries.some((entry) => JSON.stringify(entry).includes("cancelled external late")),
      ).toBe(false);
      expect(
        entries.some(
          (entry) =>
            entry.type === "assistant_text" &&
            entry.text === "queued local answer" &&
            entry.streaming === false,
        ),
      ).toBe(true);
    } finally {
      harness.unmount();
    }
  });
});
