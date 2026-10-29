import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackgroundWorkInfo } from "../../preload/types";
import type { Message, ToolMessage } from "../types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import {
  DriveAgentJobsLoader,
  useDriveAgentJobs,
  type DriveAgentJob,
} from "./DriveAgentJobsContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function message(jobId = "cc-job"): ToolMessage {
  return {
    kind: "tool",
    id: "tool-1",
    toolName: "DriveAgent",
    args: "{}",
    result: `已在后台启动 Codex（jobId ${jobId}）。`,
    status: "succeeded",
    startedAt: 0,
  };
}

function job(sessionId: string, status: DriveAgentJob["status"] = "completed"): DriveAgentJob {
  return {
    kind: "job",
    jobId: "cc-job",
    description: "DriveAgent(codex): delegate",
    status,
    startedAt: 1,
    jobKind: "drive-agent",
    externalSessionId: `thread-${sessionId}`,
    cli: "codex",
    cwd: "/repo",
    sourceSession: { sessionId, shortId: sessionId, current: true },
  };
}

let root: Root | null = null;
let observedJobs: readonly DriveAgentJob[] = [];

function Observer(): null {
  observedJobs = useDriveAgentJobs();
  return null;
}

async function render(sessionId: string, messages: readonly Message[] = [message()]) {
  const container = document.createElement("div");
  root ??= createRoot(container);
  await act(async () => {
    root?.render(
      <DriveAgentJobsLoader sessionId={sessionId} messages={messages}>
        <Observer />
      </DriveAgentJobsLoader>,
    );
    await flushMicrotasks();
  });
}

beforeEach(() => {
  ensureMiniDom();
  class DetailEvent<T> extends Event {
    readonly detail: T | undefined;
    constructor(type: string, init?: { detail?: T }) {
      super(type);
      this.detail = init?.detail;
    }
  }
  Object.assign(globalThis, { CustomEvent: DetailEvent });
  observedJobs = [];
  Object.assign(window, {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("DriveAgentJobsLoader request lifecycle", () => {
  test("ignores an older session response that resolves after the new session", async () => {
    const requests = {
      a: deferred<{ items: BackgroundWorkInfo[] }>(),
      b: deferred<{ items: BackgroundWorkInfo[] }>(),
    };
    Object.assign(window, {
      codeshell: {
        listBackgroundWork: (sessionId: string) => requests[sessionId as "a" | "b"].promise,
      },
    });

    await render("a");
    await render("b");
    await act(async () => {
      requests.b.resolve({ items: [job("b")] });
      await flushMicrotasks();
    });
    expect(observedJobs[0]?.sourceSession.sessionId).toBe("b");

    await act(async () => {
      requests.a.resolve({ items: [job("a")] });
      await flushMicrotasks();
    });
    expect(observedJobs[0]?.sourceSession.sessionId).toBe("b");
  });

  test("rejects a matching jobId owned by another source session", async () => {
    Object.assign(window, {
      codeshell: {
        listBackgroundWork: async () => ({ items: [job("other-session")] }),
      },
    });

    await render("current-session");
    expect(observedJobs).toEqual([]);
  });

  test("retries an initial IPC failure and recovers without a running job", async () => {
    let calls = 0;
    Object.assign(window, {
      codeshell: {
        listBackgroundWork: async () => {
          calls += 1;
          if (calls === 1) throw new Error("bridge warming up");
          return { items: [job("retry-session")] };
        },
      },
    });

    await render("retry-session");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(observedJobs[0]?.sourceSession.sessionId).toBe("retry-session");
  });

  test("cleans up running-job polling when the session changes", async () => {
    const cleared: unknown[] = [];
    Object.assign(window, {
      setInterval: () => 77,
      clearInterval: (id: unknown) => cleared.push(id),
      codeshell: {
        listBackgroundWork: async (sessionId: string) => ({
          items: [job(sessionId, sessionId === "a" ? "running" : "completed")],
        }),
      },
    });

    await render("a");
    await render("b");
    expect(cleared).toContain(77);
  });

  test("loads new live tasks and their progress without opening the panel", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    let items = [
      { ...job("live", "running"), externalSessionId: undefined },
      { ...job("live", "running"), jobId: "cc-second" },
    ];
    Object.assign(window, {
      codeshell: { listBackgroundWork: async () => ({ items }) },
    });
    try {
      await render("live", []);
      await render("live", [
        { ...message(), startedAt: Date.now(), status: "running", result: undefined },
      ]);
      // The second launch starts and completes between two renderer updates.
      const messages = [
        message(),
        { ...message("cc-second"), id: "tool-2", startedAt: Date.now() },
      ];
      await render("live", messages);
      expect(observedJobs).toHaveLength(2);
      expect(details).toEqual([]);

      items = items.map((item) => ({
        ...item,
        externalSessionId: `thread-${item.jobId}`,
        progress: {
          lastActivityAt: Date.now(),
          eventCount: 1,
          summary: "Read README.md",
        },
      }));
      await act(async () => {
        window.dispatchEvent(new Event("codeshell:files-changed"));
        await flushMicrotasks();
      });
      expect(observedJobs[0]?.progress?.summary).toBe("Read README.md");
      expect(details).toEqual([]);

      items = items.map((item) => ({ ...item, status: "completed" }));
      await act(async () => {
        window.dispatchEvent(new Event("codeshell:files-changed"));
        await flushMicrotasks();
      });
      expect(observedJobs.every((item) => item.status === "completed")).toBe(true);
      expect(details).toEqual([]);
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("does not navigate for restored history or a replayed running tool", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    Object.assign(window, {
      codeshell: {
        listBackgroundWork: async (sessionId: string) => ({
          items: [job(sessionId, "running")],
        }),
      },
    });
    try {
      await render("history", [message()]);
      expect(observedJobs[0]?.sourceSession.sessionId).toBe("history");
      await render("other", [{ ...message(), status: "running", result: undefined }]);
      await render("other", [message()]);
      expect(observedJobs[0]?.sourceSession.sessionId).toBe("other");
      await render("late-history", []);
      await render("late-history", [{ ...message(), status: "running", result: undefined }]);
      await render("late-history", [message()]);
      expect(observedJobs[0]?.sourceSession.sessionId).toBe("late-history");
      expect(details).toEqual([]);
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("a delayed registry response does not open the panel after the launch finishes", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    const response = deferred<{ items: BackgroundWorkInfo[] }>();
    Object.assign(window, {
      codeshell: { listBackgroundWork: () => response.promise },
    });
    try {
      await render("delayed", []);
      await render("delayed", [
        { ...message(), startedAt: Date.now(), status: "running", result: undefined },
      ]);
      await render("delayed", [message()]);
      expect(details).toEqual([]);
      await act(async () => {
        response.resolve({ items: [job("delayed", "completed")] });
        await flushMicrotasks();
      });
      expect(observedJobs[0]?.status).toBe("completed");
      expect(details).toEqual([]);
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("retries an initially missing registry row", async () => {
    let calls = 0;
    Object.assign(window, {
      codeshell: {
        listBackgroundWork: async () => ({ items: ++calls === 1 ? [] : [job("race")] }),
      },
    });
    await render("race");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(observedJobs[0]?.jobId).toBe("cc-job");
  });

  test("keeps polling a task while cancellation is pending", async () => {
    const intervals: number[] = [];
    Object.assign(window, {
      setInterval: (_handler: () => void, delay: number) => {
        intervals.push(delay);
        return 88;
      },
      clearInterval: () => undefined,
      codeshell: { listBackgroundWork: async () => ({ items: [job("stopping", "cancelling")] }) },
    });
    await render("stopping");
    expect(intervals).toEqual([3_000]);
  });
});
