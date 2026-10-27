import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";

const network = installFixtureNetworkGuard();
const { startHeadlessServer } = await import("./headless-server.js");
const { HubAuthStore } = await import("../hub/auth-store.js");
const { HubUploads } = await import("../hub/uploads.js");
const linkHttp = await import("../links/http.js");
type HeadlessServer = Awaited<ReturnType<typeof startHeadlessServer>>;

const fixtures: Array<{ server: HeadlessServer; dir: string; release: string }> = [];
const sockets: Socket[] = [];
const expectedShutdownFailures = new Set<HeadlessServer>();
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const { server, dir, release } of fixtures.splice(0)) {
    writeFileSync(release, "exit");
    await server.close().catch((error) => {
      if (!expectedShutdownFailures.delete(server)) throw error;
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
afterAll(() => network.restore());

async function fixture(hub = false) {
  const dir = mkdtempSync(join(tmpdir(), "cs-headless-shutdown-"));
  const release = join(dir, "allow-exit");
  const entry = join(dir, "worker.cjs");
  mkdirSync(join(dir, "workspace"));
  writeFileSync(
    entry,
    `const { existsSync } = require("node:fs");
const send = method => process.stdout.write(JSON.stringify({jsonrpc:"2.0",method})+"\\n");
process.stdin.resume();
process.on("SIGTERM",()=>{
  send("test/stopping");
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0);}},5);
});
send("test/ready");
`,
  );
  const server = await startHeadlessServer({
    host: "127.0.0.1",
    port: 0,
    cwd: join(dir, "workspace"),
    dataDir: join(dir, "data"),
    workerEntryPath: entry,
    execPath: process.execPath,
    ...(hub
      ? { authMode: "hub" as const, authRecheckMs: 60_000 }
      : { passcode: "shutdown-fixture-passcode" }),
  });
  fixtures.push({ server, dir, release });
  network.allowOrigin(server.url);
  const ready = workerMessage(server, "test/ready");
  server.bridge.ensureWorker();
  await ready;
  let cookie: string;
  if (hub) {
    const response = await fetch(server.url + "/api/v1/auth/setup", {
      method: "POST",
      headers: { origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({
        token: server.bootstrapToken,
        username: "fixture",
        password: "shutdown-fixture-password",
      }),
      redirect: "error",
    });
    expect(response.status).toBe(200);
    cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    await response.arrayBuffer();
  } else {
    const response = await http(server.url + "/?passcode=shutdown-fixture-passcode");
    expect(response.status).toBe(303);
    cookie = response.cookie!.split(";", 1)[0]!;
  }
  return { server, release, cookie };
}

function workerMessage(server: HeadlessServer, method: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Worker did not emit ${method}`));
    }, 5000);
    const unsubscribe = server.bridge.subscribeLines((line) => {
      if (JSON.parse(line).method !== method) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function http(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status?: number; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { accept: "text/html", ...headers } }, (response) => {
      response.resume();
      resolve({ status: response.statusCode, cookie: response.headers["set-cookie"]?.[0] });
    });
    request.on("error", reject);
  });
}

async function socket(server: HeadlessServer): Promise<Socket> {
  const connected = createConnection({ host: server.host, port: server.port });
  sockets.push(connected);
  connected.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    connected.once("connect", resolve);
    connected.once("error", reject);
  });
  return connected;
}

async function upgrade(
  server: HeadlessServer,
  cookie: string,
  retain = false,
): Promise<number | undefined> {
  try {
    const connected = await socket(server);
    return await new Promise<number | undefined>((resolve, reject) => {
      let response = "";
      const timer = setTimeout(() => reject(new Error("Upgrade did not settle")), 2000);
      connected.on("data", (part) => {
        response += part.toString();
        if (!response.includes("\r\n\r\n")) return;
        clearTimeout(timer);
        if (!retain) connected.destroy();
        resolve(Number(response.split(" ")[1]));
      });
      connected.on("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      connected.write(
        `GET /ws HTTP/1.1\r\nHost: ${server.host}:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c2h1dGRvd24tZml4dHVyZQ==\r\nCookie: ${cookie}\r\n\r\n`,
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") return undefined;
    throw error;
  }
}

test("shutdown rejects late WebSocket upgrades while retaining the stopping worker", async () => {
  const { server, release, cookie } = await fixture();
  const stopping = workerMessage(server, "test/stopping");
  const closed = server.close();
  await stopping;
  expect(server.bridge.hasChild()).toBe(true);
  expect(await upgrade(server, cookie)).not.toBe(101);
  writeFileSync(release, "exit");
  await closed;
  expect(server.bridge.hasChild()).toBe(false);
});

test("a prepared WebSocket run cannot restart the worker after shutdown completes", async () => {
  const { server, release, cookie } = await fixture(true);
  expect(await upgrade(server, cookie, true)).toBe(101);
  const peer = sockets.at(-1)!;
  const authenticate = HubAuthStore.prototype.authenticate;
  let entered!: () => void;
  const authenticating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  let checks = 0;
  const paused = spyOn(HubAuthStore.prototype, "authenticate").mockImplementation(function (token) {
    const session = authenticate.call(this, token);
    if (++checks !== 2) return session;
    const result = new Promise<typeof session>((resolve) => {
      finish = () => resolve(session);
    });
    entered();
    return result as unknown as typeof session;
  });
  try {
    const payload = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "late-run",
        method: "agent/run",
        params: { task: "fixture" },
      }),
    );
    const header = Buffer.from([0x81, 0x80 | payload.length, 0, 0, 0, 0]);
    peer.write(Buffer.concat([header, payload]));
    await authenticating;
    const generation = server.bridge.workerGeneration();
    const stopping = workerMessage(server, "test/stopping");
    const closed = server.close();
    await stopping;
    writeFileSync(release, "exit");
    await closed;
    finish();
    // Drain the resumed handler and its chained completion microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.bridge.workerGeneration()).toBe(generation);
    expect(server.bridge.hasChild()).toBe(false);
    expect(server.pendingResponseCount()).toBe(0);
  } finally {
    finish?.();
    paused.mockRestore();
  }
});

test("shutdown immediately retires existing HTTP sockets and stops reporting healthy", async () => {
  const { server, release } = await fixture();
  const connected = await socket(server);
  const disconnected = new Promise<void>((resolve) => connected.once("close", resolve));
  const stopping = workerMessage(server, "test/stopping");
  const closed = server.close();
  await stopping;
  const status = await http(server.url + "/health").then(
    (response) => response.status,
    () => undefined,
  );
  expect(status).not.toBe(200);
  await Promise.race([
    disconnected,
    new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP socket still open")), 500)),
  ]);
  writeFileSync(release, "exit");
  await closed;
});

test("concurrent shutdown callers share completion and wait for the actual worker exit", async () => {
  const { server, release } = await fixture();
  const stopping = workerMessage(server, "test/stopping");
  const first = server.close();
  const second = server.close();
  expect(second).toBe(first);
  await stopping;
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  writeFileSync(release, "exit");
  await first;
  expect(server.close()).toBe(first);
});

test.each(["upgrade", "http"])(
  "%s awaiting authentication cannot be admitted after shutdown starts",
  async (kind) => {
    const { server, release, cookie } = await fixture(true);
    const authenticate = HubAuthStore.prototype.authenticate;
    let entered!: () => void;
    const authenticating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const paused = spyOn(HubAuthStore.prototype, "authenticate").mockImplementation(
      function (token) {
        const session = authenticate.call(this, token);
        const result = new Promise<typeof session>((resolve) => {
          finish = () => resolve(session);
        });
        entered();
        return result as unknown as typeof session;
      },
    );
    try {
      const requesting =
        kind === "upgrade"
          ? upgrade(server, cookie)
          : http(server.url + "/api/v1/environment", { cookie, origin: server.url }).then(
              (response) => response.status,
              (error) => {
                if (["ECONNRESET", "ECONNREFUSED"].includes(error.code)) return undefined;
                throw error;
              },
            );
      await authenticating;
      const stopping = workerMessage(server, "test/stopping");
      const closed = server.close();
      await stopping;
      finish();
      expect(await requesting).toBeUndefined();
      expect(server.tabCount()).toBe(0);
      writeFileSync(release, "exit");
      await closed;
    } finally {
      finish?.();
      paused.mockRestore();
    }
  },
);

test("a resource cleanup failure still closes the worker and reports the error to every caller", async () => {
  const { server, release } = await fixture(true);
  const cleanupError = new Error("fixture upload cleanup failure");
  const closeUploads = HubUploads.prototype.close;
  const failing = spyOn(HubUploads.prototype, "close").mockImplementation(async function () {
    await closeUploads.call(this);
    throw cleanupError;
  });
  try {
    const stopping = workerMessage(server, "test/stopping");
    expectedShutdownFailures.add(server);
    const closed = server.close();
    const outcome = closed.catch((error) => error);
    await stopping;
    writeFileSync(release, "exit");
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(cleanupError);
    expect(server.bridge.hasChild()).toBe(false);
    expect(server.close()).toBe(closed);
    expect(await server.close().catch((error) => error)).toBe(error);
  } finally {
    failing.mockRestore();
  }
});

test("shutdown awaits delayed Link cleanup and includes its rejection", async () => {
  const createLinkHttp = linkHttp.createLinkHttp;
  const cleanupError = new Error("fixture delayed Link cleanup failure");
  let entered!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const delayed = spyOn(linkHttp, "createLinkHttp").mockImplementation((options) => {
    const link = createLinkHttp(options);
    return {
      ...link,
      async close() {
        await link.close();
        entered();
        await finished;
        throw cleanupError;
      },
    };
  });
  try {
    const { server, release } = await fixture(true);
    expectedShutdownFailures.add(server);
    const closed = server.close();
    let settled = false;
    const outcome = closed.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await cleaning;
    writeFileSync(release, "exit");
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(cleanupError);
    expect(server.bridge.hasChild()).toBe(false);
  } finally {
    finish();
    delayed.mockRestore();
  }
});
