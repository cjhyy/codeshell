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
