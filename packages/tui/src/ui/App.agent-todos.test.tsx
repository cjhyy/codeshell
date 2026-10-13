import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentClient, StreamEvent } from "@cjhyy/code-shell-core";
import { asyncAgentRegistry, type TaskInfo } from "@cjhyy/code-shell-core/internal";
import React, { act } from "react";
import { flush, mount, plainText, type TestHarness } from "../../../../tests/render-fixtures.js";
import { forceRedraw } from "../render/index.js";
import { App } from "./App.js";
import { chatStore } from "./store.js";

class FakeAgentClient {
  private handlers = new Set<(envelope: { sessionId?: string; event: StreamEvent }) => void>();

  onStreamEvent(handler: (envelope: { sessionId?: string; event: StreamEvent }) => void) {
    this.handlers.add(handler);
  }
  offStreamEvent(handler: (envelope: { sessionId?: string; event: StreamEvent }) => void) {
    this.handlers.delete(handler);
  }
  onApprovalRequest() {}
  offApprovalRequest() {}
  onApprovalResolved() {}
  offApprovalResolved() {}
  async goalGetState() {
    return null;
  }
  async query(kind: string) {
    return { data: kind === "sessions" ? [{ sessionId: "new-session" }] : { transcript: [] } };
  }
  emit(event: StreamEvent, sessionId = "session") {
    for (const handler of this.handlers) handler({ sessionId, event });
  }
  todos(subject: string | null, agentId?: string, sessionId = "session") {
    const tasks: TaskInfo[] = subject ? [{ id: "1", subject, status: "pending" }] : [];
    this.emit({ type: "task_update", tasks, agentId }, sessionId);
  }
}

async function settle(update?: () => void | Promise<void>) {
  // Macrotasks alone do not guarantee a concurrent React commit. Keep each
  // input/event batch inside act before reading a freshly redrawn frame.
  await act(async () => {
    await update?.();
    await flush();
    await flush();
  });
}

async function key(h: TestHarness, value: string) {
  await settle(async () => {
    h.stdin.write(value);
    if (value === "\x1b") await new Promise((resolve) => setTimeout(resolve, 75));
  });
}

function screen(h: TestHarness) {
  // Read a complete current frame, so assertions never match old scrollback
  // or miss text that Ink's incremental renderer did not need to rewrite.
  h.frames.length = 0;
  forceRedraw({ stdout: h.stdout as unknown as NodeJS.WriteStream });
  return plainText(h);
}

function register(agentId: string, startedAt: number) {
  asyncAgentRegistry.register({
    agentId,
    sessionId: "session",
    description: agentId,
    status: "running",
    startedAt,
    abort: () => {},
  });
}

async function mountApp(client: FakeAgentClient) {
  let h!: TestHarness;
  await settle(() => {
    h = mount(
      <App
        client={client as unknown as AgentClient}
        model="test-model"
        effort="medium"
        maxTurns={4}
        cwd="/tmp"
        maxContextTokens={16_000}
        sessionId="session"
      />,
      { rows: 80 },
    );
  });
  return h;
}

describe("App sub-agent TodoWrite snapshots", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  let previousActEnvironment: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousActEnvironment = Object.getOwnPropertyDescriptor(
      actEnvironment,
      "IS_REACT_ACT_ENVIRONMENT",
    );
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    try {
      await settle(() => {
        asyncAgentRegistry.reset();
        chatStore.clear();
      });
    } finally {
      if (previousActEnvironment) {
        Object.defineProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      } else {
        delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      }
    }
  });

  test("routes live replacements and empty snapshots to only the selected owner", async () => {
    register("first-agent", 1);
    register("second-agent", 2);
    const client = new FakeAgentClient();
    const h = await mountApp(client);
    try {
      await settle();
      await settle(() => {
        client.todos("MAIN_TODO");
        client.todos("FIRST_TODO", "first-agent");
        client.todos("SECOND_TODO", "second-agent");
      });
      expect(screen(h)).toContain("MAIN_TODO");
      expect(screen(h)).not.toContain("FIRST_TODO");
      expect(screen(h)).not.toContain("SECOND_TODO");

      await key(h, "\x1b[B"); // Input → main dock row.
      await key(h, "\x1b[B"); // First child.
      await key(h, "\r");
      expect(screen(h)).toContain("FIRST_TODO");
      expect(screen(h)).not.toContain("MAIN_TODO");
      expect(screen(h)).not.toContain("SECOND_TODO");

      await settle(() => {
        client.todos("FIRST_REPLACEMENT", "first-agent");
        client.todos("SECOND_REPLACEMENT", "second-agent");
        // An unrelated session must not overwrite a child's snapshot either.
        client.todos("FOREIGN_TODO", "first-agent", "foreign-session");
        client.emit({ type: "turn_complete", reason: "completed", agentId: "first-agent" });
        // A new parent turn in the same session must retain each child's plan.
        client.emit({ type: "session_started", sessionId: "session", promptTokens: 0 });
        client.emit({ type: "turn_complete", reason: "completed" });
      });
      expect(screen(h)).toContain("FIRST_REPLACEMENT");
      expect(screen(h)).not.toContain("FIRST_TODO");
      expect(screen(h)).not.toContain("SECOND_REPLACEMENT");
      expect(screen(h)).not.toContain("FOREIGN_TODO");

      await key(h, "\x1b[B");
      await key(h, "\r");
      expect(screen(h)).toContain("SECOND_REPLACEMENT");
      expect(screen(h)).not.toContain("FIRST_REPLACEMENT");

      await settle(() => {
        client.todos(null, "first-agent");
        client.todos(null); // Clearing main cannot clear the displayed child.
      });
      expect(screen(h)).toContain("SECOND_REPLACEMENT");
      await key(h, "\x1b[A");
      await key(h, "\r");
      expect(screen(h)).not.toContain("FIRST_REPLACEMENT");
      expect(screen(h)).not.toContain("SECOND_REPLACEMENT");
      expect(screen(h)).not.toContain("MAIN_TODO");

      await settle(() => client.todos("MAIN_AFTER_CLEAR"));
      expect(screen(h)).not.toContain("MAIN_AFTER_CLEAR");
      await settle(() => asyncAgentRegistry.markCompleted("first-agent"));
      expect(screen(h)).toContain("MAIN_AFTER_CLEAR");

      // The other child's snapshot survives its sibling's completion.
      await key(h, "\x1b[B");
      await key(h, "\r");
      expect(screen(h)).toContain("SECOND_REPLACEMENT");
      await settle(() => client.todos(null, "second-agent"));
      expect(screen(h)).not.toContain("SECOND_REPLACEMENT");
    } finally {
      await settle(() => h.unmount());
    }
  });

  test("clearing and resuming discard old snapshots, including reused child ids", async () => {
    register("first-agent", 1);
    const client = new FakeAgentClient();
    const h = await mountApp(client);
    try {
      await settle();
      await settle(() => {
        client.todos("OLD_MAIN");
        client.todos("OLD_CHILD", "first-agent");
      });
      await key(h, "/clear");
      await key(h, "\r");
      expect(screen(h)).not.toContain("OLD_MAIN");

      await key(h, "\x1b[B");
      await key(h, "\x1b[B");
      await key(h, "\r");
      expect(screen(h)).not.toContain("OLD_CHILD");

      await settle(() => client.todos("BEFORE_RESUME", "first-agent"));
      expect(screen(h)).toContain("BEFORE_RESUME");
      await key(h, "\x1b"); // Release dock focus.
      await key(h, "\x1b"); // Return to main.
      await key(h, "/resume new-session");
      await key(h, "\r");

      // The old stream is ignored immediately after selecting a session.
      await settle(() => {
        client.todos("LATE_OLD_CHILD", "first-agent");
        client.todos("NEW_MAIN", undefined, "new-session");
      });
      expect(screen(h)).toContain("NEW_MAIN");
      await key(h, "\x1b[B");
      await key(h, "\x1b[B");
      await key(h, "\r");
      expect(screen(h)).not.toContain("BEFORE_RESUME");
      expect(screen(h)).not.toContain("LATE_OLD_CHILD");
      expect(screen(h)).not.toContain("NEW_MAIN");

      await settle(() => client.todos("NEW_CHILD", "first-agent", "new-session"));
      expect(screen(h)).toContain("NEW_CHILD");
    } finally {
      await settle(() => h.unmount());
    }
  });
});
