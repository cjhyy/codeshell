import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ChromeNativeBridgeServer } from "./chrome-native-server.js";
import {
  CODESHELL_CHROME_EXTENSION_ORIGIN,
  JsonLineDecoder,
  runChromeNativeMessagingHost,
  type ChromeNativeServerState,
} from "./chrome-native-protocol.js";

const temporaryDirectories: string[] = [];
const servers: ChromeNativeBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChromeNativeBridgeServer", () => {
  test("authenticates the exact extension and correlates requests in both directions", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codeshell-chrome-native-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "state.json");
    const server = new ChromeNativeBridgeServer({
      statePath,
      onMessage: async (message) => ({ echoed: message.value }),
    });
    servers.push(server);
    await server.start();
    const state = JSON.parse(readFileSync(statePath, "utf8")) as ChromeNativeServerState;
    const socket = createConnection({ host: "127.0.0.1", port: state.port });
    const decoder = new JsonLineDecoder();
    const received: Array<Record<string, unknown>> = [];
    socket.on("data", (chunk) => {
      received.push(...(decoder.push(chunk) as Array<Record<string, unknown>>));
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      `${JSON.stringify({
        type: "auth",
        token: state.token,
        origin: CODESHELL_CHROME_EXTENSION_ORIGIN,
      })}\n`,
    );
    await waitFor(() => received.some((message) => message.type === "auth.result"));
    expect(server.status().connected).toBe(true);

    socket.write(`${JSON.stringify({ id: "ext-1", type: "echo", value: "你好" })}\n`);
    await waitFor(() => received.some((message) => message.replyTo === "ext-1"));
    expect(received.find((message) => message.replyTo === "ext-1")).toEqual({
      replyTo: "ext-1",
      ok: true,
      result: { echoed: "你好" },
    });

    const requestPromise = server.request("tab.get", { tabId: 9 });
    await waitFor(() => received.some((message) => message.type === "tab.get"));
    const request = received.find((message) => message.type === "tab.get")!;
    socket.write(
      `${JSON.stringify({ replyTo: request.id, ok: true, result: { id: 9 } })}\n`,
    );
    expect(await requestPromise).toEqual({ id: 9 });
    socket.destroy();
  });

  test("refuses linked state, rolls back the listener, and never reads the target token", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codeshell-chrome-native-link-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "state.json");
    const outside = path.join(directory, "outside.json");
    writeFileSync(
      outside,
      JSON.stringify({ version: 1, port: 1234, token: "a".repeat(64), pid: process.pid }),
    );
    symlinkSync(outside, statePath);
    const server = new ChromeNativeBridgeServer({ statePath });
    servers.push(server);

    await expect(server.start()).rejects.toThrow(/target/);
    expect(server.status()).toMatchObject({ listening: false, connected: false });
    await expect(
      runChromeNativeMessagingHost(CODESHELL_CHROME_EXTENSION_ORIGIN, statePath),
    ).rejects.toThrow(/state is invalid/);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toMatchObject({ port: 1234 });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
