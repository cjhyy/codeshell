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

async function render(
  sessionId: string,
  messages: readonly Message[] = [message()],
  autoOpen = false,
) {
  const container = document.createElement("div");
  root ??= createRoot(container);
  await act(async () => {
    root?.render(
      <DriveAgentJobsLoader sessionId={sessionId} messages={messages} autoOpen={autoOpen}>
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

  test("opens the first new live task before its external id arrives and leaves concurrent tasks unfocused", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    Object.assign(window, {
      codeshell: {
        listBackgroundWork: async () => ({
          items: [
            { ...job("live", "running"), externalSessionId: undefined },
            { ...job("live", "running"), jobId: "cc-second" },
          ],
        }),
      },
    });
    try {
      await render("live", [], true);
      await render(
        "live",
        [
          { ...message(), startedAt: Date.now(), status: "running", result: undefined },
          {
            ...message("cc-second"),
            startedAt: Date.now(),
            id: "tool-2",
            status: "running",
            result: undefined,
          },
        ],
        true,
      );
      await render("live", [message(), { ...message("cc-second"), id: "tool-2" }], true);
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        jobId: "cc-job",
        sourceSessionId: "live",
        autoOpen: true,
      });
      expect(details[0]).not.toHaveProperty("externalSessionId");
      await render("live", [message(), { ...message("cc-second"), id: "tool-2" }], true);
      expect(details).toHaveLength(1);
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("does not navigate for replayed history or a replayed running tool", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    Object.assign(window, {
      codeshell: { listBackgroundWork: async () => ({ items: [job("history", "running")] }) },
    });
    try {
      await render("history", [message()], true);
      await render("other", [{ ...message(), status: "running", result: undefined }], true);
      await render("other", [message()], true);
      await render("late-history", [], true);
      await render("late-history", [{ ...message(), status: "running", result: undefined }], true);
      await render("late-history", [message()], true);
      expect(details).toEqual([]);
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("opens a fast live tool even when its start and result render together", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    Object.assign(window, {
      codeshell: { listBackgroundWork: async () => ({ items: [job("fast", "running")] }) },
    });
    try {
      await render("fast", [], true);
      await render("fast", [{ ...message(), startedAt: Date.now() }], true);
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({ jobId: "cc-job", autoOpen: true });
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("retains a live launch across turn end until its result and registry response arrive", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    const response = deferred<{ items: BackgroundWorkInfo[] }>();
    Object.assign(window, {
      codeshell: { listBackgroundWork: () => response.promise },
    });
    try {
      await render("delayed", [], true);
      const running = {
        ...message(),
        startedAt: Date.now(),
        status: "running" as const,
        result: undefined,
      };
      await render("delayed", [running], true);
      await render("delayed", [running], false);
      await render("delayed", [message()], false);
      expect(details).toEqual([]);
      await act(async () => {
        response.resolve({ items: [job("delayed", "running")] });
        await flushMicrotasks();
      });
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        jobId: "cc-job",
        sourceSessionId: "delayed",
        autoOpen: true,
      });
    } finally {
      window.removeEventListener("codeshell:open-cli-session", listener);
    }
  });

  test("a delayed terminal batch opens only once after turn end and a later live batch can open again", async () => {
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);
    const response = deferred<{ items: BackgroundWorkInfo[] }>();
    const finished = [job("terminal-batch"), { ...job("terminal-batch"), jobId: "cc-second" }];
    Object.assign(window, {
      codeshell: { listBackgroundWork: () => response.promise },
    });
    try {
      await render("terminal-batch", [], true);
      const running = [
        { ...message(), startedAt: Date.now(), status: "running" as const, result: undefined },
        {
          ...message("cc-second"),
          id: "tool-2",
          startedAt: Date.now(),
          status: "running" as const,
          result: undefined,
        },
      ];
      await render("terminal-batch", running, true);
      const completed = [message(), { ...message("cc-second"), id: "tool-2" }];
      await render("terminal-batch", completed, true);
      await render("terminal-batch", completed, false);
      await act(async () => {
        response.resolve({ items: finished });
        await flushMicrotasks();
      });
      expect(details).toHaveLength(1);
      Object.assign(window.codeshell, {
        listBackgroundWork: async () => ({
          items: [...finished, { ...job("terminal-batch", "running"), jobId: "cc-third" }],
        }),
      });
      await render(
        "terminal-batch",
        [...completed, { ...message("cc-third"), id: "tool-3", startedAt: Date.now() }],
        true,
      );
      expect(details).toHaveLength(2);
      expect(details[1]).toMatchObject({ jobId: "cc-third" });
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
