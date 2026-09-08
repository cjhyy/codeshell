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
  readyState = 0;
  onclose?: (event: { code: number }) => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
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
