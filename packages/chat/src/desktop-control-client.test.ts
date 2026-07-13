import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
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
