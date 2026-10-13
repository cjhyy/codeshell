import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { setApiProject, setApiWorkspace } from "./api-context.js";
import { useHubController } from "./useHubController.js";

const projectA = "12345678-1234-1234-1234-1234567890ab";
const projectB = "12345678-1234-1234-1234-1234567890cd";
const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
const cleanups: Array<() => Promise<void> | void> = [];
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  static respond?: (message: {
    id: number;
    method: string;
    params: Record<string, unknown>;
  }) => unknown;
  readyState = 0;
  onclose?: (event: { code: number }) => void;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  send(raw: string) {
    const response = Socket.respond?.(JSON.parse(raw));
    if (response !== undefined)
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) }));
  }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
  setApiProject(null);
  setApiWorkspace(undefined);
});

function environment() {
  ensureMiniDom();
  Socket.instances = [];
  Socket.respond = undefined;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  let location = new URL("http://localhost/");
  for (const [target, name, descriptor] of [
    [window, "location", { get: () => location }],
    [globalThis, "location", { get: () => location }],
    [
      window,
      "history",
      {
        value: {
          state: null,
          replaceState(_state: unknown, _unused: string, url: string | URL) {
            location = new URL(String(url), location);
          },
        },
      },
    ],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
    cleanups.push(() => {
      if (previous) Object.defineProperty(target, name, previous);
      else delete (target as any)[name];
    });
  }
}

test("foreground on one healthy socket restores missed approvals/leases and selected history without repeating a Run", async () => {
  environment();
  const session = {
    sessionId: "saved",
    cwd: "/fixture",
    startedAt: 1,
    model: "fixture",
    status: "completed",
    turnCount: 1,
  };
  globalThis.fetch = (async () => Response.json({ sessions: [session] })) as typeof fetch;
  let resumed = false;
  const methods: string[] = [];
  const approval = {
    requestId: "pending-one",
    sessionId: "saved",
    request: { toolName: "Write", args: {} },
  };
  const lease = {
    requestId: "pending-one",
    holderId: "another-tab",
    expiresAt: Date.now() + 30_000,
  };
  Socket.respond = ({ id, method, params }) => {
    methods.push(method);
    if (method === "serve/approval.snapshot")
      return { id, result: { approvals: [approval], leases: [lease] } };
    if (params.type === "sessions") return { id, result: { type: "sessions", data: [session] } };
    if (params.type === "output_journal")
      return { id, error: { code: -32602, message: "Unknown query type: output_journal" } };
    if (params.type === "session_detail")
      return {
        id,
        result: {
          type: "session_detail",
          data: {
            state: session,
            transcript: [
              { message: { role: "assistant", content: resumed ? "restored tail" : "old prefix" } },
            ],
            running: false,
          },
        },
      };
  };
  const hook = await renderHook(() => useHubController({ hub: true }));
  cleanups.push(() => hook.unmount());
  const socket = Socket.instances[0];
  await act(async () => {
    socket.readyState = 1;
    socket.onopen?.();
    await flushMicrotasks();
    await hook.result.current.selectSession("saved");
  });
  expect(hook.result.current.approvals).toHaveLength(0);
  await act(async () => {
    resumed = true;
    window.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
  expect(hook.result.current.approvals).toHaveLength(1);
  expect(hook.result.current.approvals[0]).toEqual({ id: "pending-one", sessionId: "saved" });
  const card = (hook.result.current.approvalContent as any[])[0];
  expect(card.props.payload).toEqual(approval);
  expect(card.props.busy).toBe(true);
  expect(
    hook.result.current.chat.items.some(
      (item) => item.kind === "assistant" && item.text === "restored tail",
    ),
  ).toBe(true);
  expect(methods.filter((method) => method === "serve/approval.snapshot")).toHaveLength(1);
  expect(methods.filter((method) => method === "agent/run" || method === "agent/approve")).toEqual(
    [],
  );
  expect(Socket.instances).toHaveLength(1);
});

test.each([-32601, -32009, -32602])(
  "only explicit unsupported snapshot %i uses one upgrade fallback",
  async (code) => {
    environment();
    globalThis.fetch = (async () => Response.json({ sessions: [] })) as typeof fetch;
    const methods: string[] = [];
    Socket.respond = ({ id, method }) => {
      methods.push(method);
      return method === "serve/approval.snapshot"
        ? { id, error: { code, message: "synthetic control response" } }
        : { id, result: { type: "sessions", data: [] } };
    };
    const hook = await renderHook(() => useHubController({ hub: true }));
    cleanups.push(() => hook.unmount());
    await act(async () => {
      Socket.instances[0].readyState = 1;
      Socket.instances[0].onopen?.();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      await flushMicrotasks();
    });
    await act(async () => {
      await Bun.sleep(850);
      await flushMicrotasks();
    });
    expect(Socket.instances).toHaveLength(code === -32601 ? 2 : 1);
    expect(methods.filter((method) => method === "serve/approval.snapshot")).toHaveLength(1);
    expect(
      methods.filter((method) => method === "agent/run" || method === "agent/approve"),
    ).toEqual([]);
  },
);

test.each(["resolved", "snapshot", "submit"])(
  "delayed foreground snapshot cannot undo a newer %s on the same connection",
  async (change) => {
    environment();
    globalThis.fetch = (async () => Response.json({ sessions: [] })) as typeof fetch;
    let pendingSnapshot: string | number | undefined;
    let writes = 0;
    Socket.respond = ({ id, method }) => {
      if (method === "serve/approval.snapshot") {
        pendingSnapshot = id;
        return;
      }
      if (method === "agent/approve") {
        writes++;
        return { id, result: { accepted: true } };
      }
      return { id, result: { type: "sessions", data: [] } };
    };
    const hook = await renderHook(() => useHubController({ hub: true }));
    cleanups.push(() => hook.unmount());
    const socket = Socket.instances[0];
    const approval = { requestId: "one", request: { toolName: "Write", args: {} } };
    await act(async () => {
      socket.readyState = 1;
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({ method: "agent/approvalRequest", params: approval }),
      });
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(pendingSnapshot).toBeDefined();
    await act(async () => {
      if (change === "submit")
        (hook.result.current.approvalContent as any[])[0].props.onDecide(approval, true);
      else
        socket.onmessage?.({
          data: JSON.stringify(
            change === "resolved"
              ? { method: "agent/approvalResolved", params: { requestId: "one" } }
              : { method: "serve/approvalSnapshot", params: { approvals: [] } },
          ),
        });
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          id: pendingSnapshot,
          result: { approvals: [approval], leases: [] },
        }),
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);
    expect(writes).toBe(change === "submit" ? 1 : 0);
    expect(Socket.instances).toHaveLength(1);
  },
);

test.each([1000, 4401])(
  "a resolved foreground snapshot cannot adopt after socket retirement %i before its microtask",
  async (code) => {
    environment();
    globalThis.fetch = (async () => Response.json({ sessions: [] })) as typeof fetch;
    let pendingSnapshot: string | number | undefined;
    Socket.respond = ({ id, method }) => {
      if (method === "serve/approval.snapshot") {
        pendingSnapshot = id;
        return;
      }
      return { id, result: { type: "sessions", data: [] } };
    };
    const hook = await renderHook(() => useHubController({ hub: true }));
    cleanups.push(() => hook.unmount());
    const socket = Socket.instances[0];
    await act(async () => {
      socket.readyState = 1;
      socket.onopen?.();
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(pendingSnapshot).toBeDefined();
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          id: pendingSnapshot,
          result: {
            approvals: [{ requestId: "retired-one", request: { toolName: "Write", args: {} } }],
            leases: [],
          },
        }),
      });
      // The promise is already resolved, but its adopter has not run yet.
      socket.onclose?.({ code });
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);
    expect(Socket.instances).toHaveLength(1);
  },
);

test("a known durable recovery failure preserves visible history and fences unverified live output", async () => {
  environment();
  let damaged = false;
  const session = {
    sessionId: "saved",
    cwd: "/fixture",
    startedAt: 1,
    model: "fixture",
    status: "completed",
    turnCount: 1,
  };
  Socket.respond = ({ id, params }) => {
    if (params.type === "sessions") return { id, result: { type: "sessions", data: [session] } };
    if (params.type === "output_journal")
      return { id, error: { code: -32602, message: "Unknown query type: output_journal" } };
    if (params.type === "session_detail")
      return {
        id,
        result: {
          type: "session_detail",
          data: {
            state: session,
            transcript: damaged
              ? []
              : [
                  { message: { role: "user", content: "question" } },
                  { message: { role: "assistant", content: "kept visible" } },
                ],
            running: false,
            ...(damaged
              ? {
                  outputJournal: { version: 1, status: "incomplete", frames: [], complete: false },
                  legacyBaseComplete: false,
                }
              : {}),
          },
        },
      };
  };
  const hook = await renderHook(() => useHubController({ hub: false }));
  cleanups.push(() => hook.unmount());
  const socket = Socket.instances[0]!;
  await act(async () => {
    socket.readyState = 1;
    socket.onopen?.();
    await flushMicrotasks();
  });
  await act(async () => {
    await hook.result.current.selectSession("saved");
  });
  expect(
    hook.result.current.chat.items.some(
      (item) => item.kind === "assistant" && item.text === "kept visible",
    ),
  ).toBe(true);
  await act(async () => {
    damaged = true;
    socket.onopen?.();
    for (let index = 0; index < 5; index++) await flushMicrotasks();
  });
  expect(hook.result.current.replayNote).toContain("已保留当前可见内容");
  await act(async () => {
    socket.onmessage?.({
      data: JSON.stringify({
        method: "agent/streamEvent",
        params: {
          sessionId: "saved",
          hubEpoch: "new",
          hubSequence: 9,
          event: { type: "stream_request_start", turnNumber: 2 },
        },
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        method: "agent/streamEvent",
        params: {
          sessionId: "saved",
          hubEpoch: "new",
          hubSequence: 10,
          event: { type: "text_delta", text: "unverified tail" },
        },
      }),
    });
  });
  expect(
    hook.result.current.chat.items
      .filter((item) => item.kind === "assistant")
      .map((item) => item.text),
  ).toEqual(["kept visible"]);
});

test("unmount aborts an upload and never starts the next file in another project", async () => {
  environment();
  setApiProject(projectA);
  const requests: Array<{ path: string; signal: AbortSignal | null | undefined }> = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (path, init) => {
    requests.push({ path: String(path), signal: init?.signal });
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch;
  const hook = await renderHook(() => useHubController({ hub: true }));
  cleanups.push(() => hook.unmount());
  expect(Socket.instances[0].url).toBe(`ws://localhost/p/${projectA}/ws`);
  const files = [new File(["one"], "one.txt"), new File(["two"], "two.txt")];
  let uploading!: Promise<void>;
  await act(async () => {
    uploading = hook.result.current.addFiles(files as unknown as FileList);
    await flushMicrotasks();
  });
  expect(requests).toHaveLength(1);
  await hook.unmount();
  setApiProject(projectB);
  await act(async () => {
    finish(
      Response.json({
        id: "fixture-id",
        name: "one.txt",
        mimeType: "text/plain",
        size: 3,
        path: "/workspace/one.txt",
      }),
    );
    await uploading;
  });
  expect(requests[0].signal?.aborted).toBe(true);
  expect(requests[0].path).toStartWith(`/p/${projectA}/api/v1/uploads/`);
  expect(requests).toHaveLength(1);
  expect(Socket.instances[0].readyState).toBe(3);
});

test("all files in one pending upload retain its initial project scope", async () => {
  environment();
  setApiProject(projectA);
  const requests: string[] = [];
  globalThis.fetch = (async (path) => {
    requests.push(String(path));
    setApiProject(projectB);
    return Response.json({
      id: `file-${requests.length}`,
      name: "fixture.txt",
      mimeType: "text/plain",
      size: 3,
      path: "/workspace/fixture.txt",
    });
  }) as typeof fetch;
  const hook = await renderHook(() => useHubController({ hub: true }));
  cleanups.push(() => hook.unmount());
  await act(async () => {
    await hook.result.current.addFiles([
      new File(["a"], "one.txt"),
      new File(["b"], "two.txt"),
    ] as unknown as FileList);
  });
  expect(requests).toHaveLength(2);
  for (const path of requests) expect(path).toStartWith(`/p/${projectA}/api/v1/uploads/`);
  expect(hook.result.current.files).toHaveLength(2);
});
