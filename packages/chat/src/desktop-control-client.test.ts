import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopGatewayConfig } from "./config.js";
import {
  DesktopControlClient,
  DesktopControlOperationError,
  DesktopControlUnavailableError,
  parseDescriptor,
} from "./desktop-control-client.js";

const descriptor = JSON.stringify({
  version: 1,
  pid: 123,
  baseUrl: "http://127.0.0.1:3456",
  token: "a".repeat(64),
  startedAt: 100,
});

describe("DesktopControlClient", () => {
  test("rejects a descriptor that could redirect bearer auth away from loopback", () => {
    expect(() =>
      parseDescriptor(
        JSON.stringify({
          version: 1,
          pid: 1,
          baseUrl: "https://attacker.example",
          token: "a".repeat(64),
          startedAt: 1,
        }),
      ),
    ).toThrow(DesktopControlUnavailableError);
  });

  test("auto-launches desktop and waits for control readiness before opening", async () => {
    let ready = false;
    let launches = 0;
    const methods: string[] = [];
    const client = new DesktopControlClient(baseConfig(), {
      readDescriptor: async () => {
        if (!ready) throw new Error("ENOENT");
        return descriptor;
      },
      spawn: () => {
        launches++;
        return Object.assign(new EventEmitter(), { unref: () => undefined }) as ChildProcess;
      },
      sleep: async () => {
        ready = true;
      },
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "POST") {
          return Response.json({
            url: "https://demo.trycloudflare.com",
            pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=x",
            expiresAt: 123,
            mode: "tunnel",
          });
        }
        return Response.json({
          running: false,
          tunnelRunning: false,
          tunnelConnected: false,
          passcodeSet: true,
          onlineDeviceCount: 0,
        });
      },
    });

    const opened = await client.open();
    expect(launches).toBe(1);
    expect(methods).toEqual(["GET", "POST"]);
    expect(opened.mode).toBe("tunnel");
  });

  test("surfaces a desktop operation error separately from offline state", async () => {
    const client = new DesktopControlClient(baseConfig(), {
      readDescriptor: async () => descriptor,
      fetch: async () => Response.json({ message: "请先设置访问口令" }, { status: 500 }),
    });
    expect(client.open()).rejects.toBeInstanceOf(DesktopControlOperationError);
  });

  test("posts Mimi Pet turns and attachment bytes through authenticated loopback JSON", async () => {
    let observed: { url: string; init?: RequestInit } | undefined;
    const client = new DesktopControlClient(baseConfig(), {
      readDescriptor: async () => descriptor,
      fetch: async (url, init) => {
        observed = { url: String(url), init };
        if (String(url).endsWith("/v1/status")) {
          return Response.json({
            running: false,
            tunnelRunning: false,
            tunnelConnected: false,
            passcodeSet: true,
            onlineDeviceCount: 0,
          });
        }
        return Response.json({ text: "pet reply", petSessionId: "pet-1" });
      },
    });
    const result = await client.petChat({
      message: "inspect",
      attachments: [{ id: "a", kind: "file", name: "a.txt", size: 2, dataBase64: "aGk=" }],
    });
    expect(result.text).toBe("pet reply");
    expect(observed?.url).toEndWith("/v1/pet/chat");
    expect(JSON.parse(String(observed?.init?.body))).toMatchObject({
      message: "inspect",
      attachments: [{ name: "a.txt", dataBase64: "aGk=" }],
    });
  });

  test("retries a failed event handler and checkpoints only after success", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-event-checkpoint-"));
    const checkpointPath = join(root, "nested", "events.json");
    const abort = new AbortController();
    let handled = 0;
    let errors = 0;
    let recoveries = 0;
    const client = new DesktopControlClient(baseConfig(), {
      readDescriptor: async () => descriptor,
      sleep: async () => undefined,
      fetch: async () =>
        Response.json({
          streamId: "a".repeat(32),
          cursor: 1,
          events: [{ id: 1, createdAt: 1, type: "tunnel.connected", text: "ready" }],
        }),
    });
    try {
      await client.watchEvents(
        abort.signal,
        async () => {
          handled++;
          if (handled === 1) throw new Error("temporary adapter error");
          abort.abort();
        },
        {
          checkpointPath,
          retryBaseMs: 1,
          retryMaxMs: 1,
          onError: () => errors++,
          onRecovered: () => recoveries++,
        },
      );
      expect(handled).toBe(2);
      expect({ errors, recoveries }).toEqual({ errors: 1, recoveries: 1 });
      expect(JSON.parse(readFileSync(checkpointPath, "utf-8"))).toEqual({
        version: 1,
        streamId: "a".repeat(32),
        cursor: 1,
      });
      if (process.platform !== "win32") expect(statSync(checkpointPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resets a persisted cursor when the Desktop event stream changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-event-stream-"));
    const checkpointPath = join(root, "events.json");
    writeFileSync(
      checkpointPath,
      JSON.stringify({ version: 1, streamId: "a".repeat(32), cursor: 99 }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(checkpointPath, 0o600);
    const abort = new AbortController();
    const after: number[] = [];
    const client = new DesktopControlClient(baseConfig(), {
      readDescriptor: async () => descriptor,
      fetch: async (url) => {
        const cursor = Number(new URL(String(url)).searchParams.get("after"));
        after.push(cursor);
        if (cursor === 99) {
          return Response.json({ streamId: "b".repeat(32), cursor: 99, events: [] });
        }
        return Response.json({
          streamId: "b".repeat(32),
          cursor: 1,
          events: [{ id: 1, createdAt: 1, type: "tunnel.connected", text: "new" }],
        });
      },
    });
    try {
      await client.watchEvents(abort.signal, async () => abort.abort(), { checkpointPath });
      expect(after).toEqual([99, 0]);
      expect(JSON.parse(readFileSync(checkpointPath, "utf-8"))).toMatchObject({
        streamId: "b".repeat(32),
        cursor: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborts an in-flight Desktop event long poll when the watcher stops", async () => {
    const abort = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestAborted = false;
    const client = new DesktopControlClient(baseConfig(), {
      readDescriptor: async () => descriptor,
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          started();
          const signal = init?.signal;
          const rejectAbort = (): void => {
            requestAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          };
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        }),
    });

    const watcher = client.watchEvents(abort.signal, async () => undefined);
    await requestStarted;
    abort.abort();
    await watcher;

    expect(requestAborted).toBe(true);
  });
});

function baseConfig(): DesktopGatewayConfig {
  return {
    descriptorPath: "/tmp/desktop-control.json",
    autoLaunch: true,
    command: "code-shell",
    args: [],
    startupTimeoutMs: 1_000,
  };
}
