import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import type { CloudAccountPrincipal } from "../../server/src/project-runtime/control-authority.js";
import { installChooserGuard } from "./cloud-chooser-guard.mjs";

// Actual Server/Registry, synthetic Account authority/runtime/static HTML.
// This does not claim Services interoperability or the complete remote Web UI.
installChooserGuard();
type ControlModule = typeof import("../../server/src/project-runtime/control-server.js");
type Listener = ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>;
const home = process.env.CODESHELL_CLOUD_CHOOSER_HOME!;
const token = () => randomBytes(32).toString("base64url");
const accessToken = token(),
  refreshToken = token(),
  accountId = randomUUID(),
  rootId = randomUUID();
const tickets = new Map<string, number>(),
  running = new Set<string>();
const listeners = new Set<Listener>();
const socketClosures = new Map<Socket, Promise<void>>();
const upstreams = new Map<ClientRequest, Promise<void>>();
const pending = new Set<Promise<void>>();
const failures: unknown[] = [];
const requests: Array<{ target: string; path: string; root: boolean; cookie: boolean }> = [];
let backend: Awaited<ReturnType<ControlModule["startProjectControlServer"]>> | undefined;
let backendClosed = false;
let accountOrigin: string, cloudOrigin: string, installationId: string;
let started = 0,
  stopped = 0,
  redeemed = 0,
  active = true,
  closing = false;
let closingResult: Promise<void> | undefined;
let account: Listener | undefined, front: Listener | undefined, inner: Listener | undefined;
let startupDone!: () => void;
const startupSettled = new Promise<void>((done) => {
  startupDone = done;
});
const cancelled = Symbol("Cloud chooser startup cancelled");
const checkpoint = () => {
  if (closing) throw cancelled;
};
const bounded = async <T>(operation: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not close.`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const ownSocket = (socket: Socket) => {
  if (socketClosures.has(socket)) return;
  const closed = new Promise<void>((done) => socket.once("close", () => done()));
  socketClosures.set(socket, closed);
  void closed.then(() => socketClosures.delete(socket));
};
const own = <T extends Listener>(server: T): T => {
  listeners.add(server);
  server.on("connection", ownSocket);
  server.on("error", (error) => {
    if (!closing) fail(error);
  });
  return server;
};
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    assert.ok(size < 16_384, "Synthetic Account request exceeds its limit.");
    chunks.push(chunk);
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
};
const handle =
  (
    work: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    duringShutdown = false,
  ) =>
  (req: IncomingMessage, res: ServerResponse) => {
    if (closing && !duringShutdown) return json(res, 503, { error: "fixture_closing" });
    const operation = Promise.resolve()
      .then(() => work(req, res))
      .catch((error) => {
        if (closing) return;
        if (!res.headersSent && !res.destroyed) json(res, 500, { error: "fixture_contract" });
        else res.destroy();
        fail(error);
      });
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
  };
const safeMessage = (error: unknown) => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [accessToken, refreshToken, ...tickets.keys()])
    message = message.replaceAll(secret, "[fixture credential]");
  return message;
};
function fail(error: unknown) {
  failures.push(error);
  process.exitCode = 1;
  void close();
}
async function closeListener(listener: Listener) {
  // Capture completion before destroying connections; the callback alone does
  // not prove that every socket's asynchronous close event has fired.
  const closed = new Promise<void>((done, reject) => {
    listener.close((error?: NodeJS.ErrnoException) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else done();
    });
  });
  listener.closeAllConnections();
  await bounded(closed, "Owned listener");
  listeners.delete(listener);
}
function close(): Promise<void> {
  if (closingResult) return closingResult;
  closing = true;
  closingResult = (async () => {
    // A shutdown received before ready must also close a backend whose async
    // initialization finishes late. Startup checks cancellation after awaits.
    await startupSettled;
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    // Stop ingress first. Keep the inner runtime alive until the real backend
    // has revoked sessions and completed runtime termination.
    const ingress = [front, account].filter((value): value is Listener => !!value);
    const ingressClosed = ingress.map((listener) => attempt(() => closeListener(listener)));
    for (const upstream of upstreams.keys()) upstream.destroy();
    await Promise.all(ingressClosed);
    if (backend)
      await attempt(async () => {
        await bounded(backend!.close(), "ProjectControlServer");
        backendClosed = true;
      });
    // Continue all remaining cleanup even after primary/backend close failure.
    await Promise.all([...listeners].map((listener) => attempt(() => closeListener(listener))));
    for (const socket of socketClosures.keys()) socket.destroy();
    await attempt(() => bounded(Promise.all([...socketClosures.values()]), "Owned sockets"));
    await attempt(() => bounded(Promise.all([...upstreams.values()]), "Owned upstreams"));
    await attempt(() => bounded(Promise.all([...pending]), "Owned handlers"));
    await attempt(async () => {
      assert.equal(listeners.size, 0);
      assert.equal(socketClosures.size, 0);
      assert.equal(upstreams.size, 0);
      assert.equal(pending.size, 0);
      assert.equal(running.size, 0);
      assert.ok(!backend || backendClosed);
    });
    const passed = failures.length === 0;
    const receipt = {
      passed,
      pid: process.pid,
      started,
      stopped,
      redeemed,
      listeners: listeners.size + (backend && !backendClosed ? 1 : 0),
      sockets: socketClosures.size,
      upstreams: upstreams.size,
      handlers: pending.size,
      running: running.size,
      requests,
      fixture: "actual Server; synthetic Account authority/runtime/static HTML",
      ...(passed ? {} : { errors: failures.map(safeMessage) }),
    };
    try {
      await writeFile(join(home, "chooser-server-receipt.json"), JSON.stringify(receipt), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      process.exitCode = 1;
      console.error(new AggregateError(failures.map(safeMessage), "Cloud chooser server failed."));
    }
    if (process.connected) process.disconnect!();
  })();
  return closingResult;
}
// Install lifecycle handlers before the first dynamic production import.
process.on("message", (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "close" ||
    (value as { close?: unknown }).close !== true
  ) {
    fail(new Error("Unexpected Cloud chooser IPC message."));
    return;
  }
  void close();
});
process.once("disconnect", () => {
  if (!closing) fail(new Error("Cloud chooser owner disconnected before cleanup."));
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => fail(new Error(`Cloud chooser owner sent ${signal}.`)));

try {
  const { ProjectRegistry } = await import("../../server/src/project-runtime/registry.js");
  checkpoint();
  const { startProjectControlServer } =
    await import("../../server/src/project-runtime/control-server.js");
  checkpoint();
  const tlsFor = async (name: string) => {
    const result = {
      key: await readFile(join(home, `${name}.key`)),
      cert: await readFile(join(home, `${name}.pem`)),
    };
    checkpoint();
    return result;
  };
  account = own(
    createHttpsServer(
      await tlsFor("account"),
      handle(async (req, res) => {
        requests.push({
          target: "account",
          path: req.url!,
          root: req.headers.authorization === `Bearer ${accessToken}`,
          cookie: !!req.headers.cookie,
        });
        assert.equal(req.headers.origin, accountOrigin);
        assert.equal(req.headers.cookie, undefined);
        if (req.method === "GET" && req.url === "/api/v1/account/status") {
          assert.equal(req.headers.authorization, undefined);
          return json(res, 200, {
            registrationAllowed: false,
            githubEnabled: false,
            linkManagementEnabled: false,
          });
        }
        const value = await body(req);
        if (req.method === "POST" && req.url === "/api/v1/account/login") {
          assert.equal(req.headers.authorization, undefined);
          assert.deepEqual(value, {
            username: "chooser-owner",
            password: "chooser-synthetic-password",
          });
          assert.ok(active);
          return json(res, 200, {
            accessToken,
            refreshToken,
            accessTokenExpiresAt: Date.now() + 3_600_000,
            refreshTokenExpiresAt: Date.now() + 7_200_000,
            sessionId: rootId,
            account: { id: accountId, username: "chooser-owner" },
            kind: "account",
            audience: accountOrigin,
          });
        }
        assert.equal(req.headers.authorization, `Bearer ${accessToken}`);
        if (req.method === "POST" && req.url === "/api/v1/account/cloud-management/tickets") {
          assert.ok(active);
          assert.deepEqual(value, { cloudOrigin, installationId });
          const ticket = token(),
            expiresAt = Date.now() + 60_000;
          tickets.set(ticket, expiresAt);
          // Exact Account Services v2 response contract: HTTP 201, five fields.
          return json(res, 201, { ticket, expiresAt, cloudOrigin, installationId, accountOrigin });
        }
        if (req.method === "POST" && req.url === "/api/v1/account/logout") {
          assert.deepEqual(value, {});
          active = false;
          return json(res, 200, { ok: true });
        }
        throw new Error("Unexpected synthetic Account request.");
      }),
    ),
  );
  front = own(
    createHttpsServer(
      await tlsFor("cloud"),
      handle((req, res) => {
        assert.notEqual(req.headers.authorization, `Bearer ${accessToken}`);
        assert.notEqual(req.headers.authorization, `Bearer ${refreshToken}`);
        assert.equal(req.url?.includes(accessToken), false);
        assert.equal(req.url?.includes(refreshToken), false);
        requests.push({
          target: "cloud",
          path: req.url!,
          root: false,
          cookie: !!req.headers.cookie,
        });
        assert.ok(backend);
        const target = new URL(req.url!, backend.url);
        // An absolute-form request may not turn this front into an arbitrary proxy.
        assert.equal(target.origin, backend.url);
        const upstream = request(
          target,
          { method: req.method, headers: req.headers, agent: false },
          (response) => {
            res.writeHead(response.statusCode!, response.headers);
            response.pipe(res);
          },
        );
        const closed = new Promise<void>((done) => upstream.once("close", () => done()));
        upstream.once("socket", ownSocket);
        upstreams.set(upstream, closed);
        void closed.then(() => upstreams.delete(upstream));
        upstream.on("error", () => {
          if (!res.headersSent && !res.destroyed) res.writeHead(503);
          res.end();
        });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      }),
    ),
  );
  inner = own(
    createServer(
      handle((req, res) => {
        if (req.url === "/api/v1/auth/login")
          res.setHeader("Set-Cookie", `cs_hub_session=${token()}; Path=/; HttpOnly`);
        json(res, 200, {});
      }, true),
    ),
  );
  for (const listener of [account, front, inner]) {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    checkpoint();
  }
  const url = (listener: Listener, scheme: string) =>
    `${scheme}://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  accountOrigin = url(account, "https");
  cloudOrigin = url(front, "https");
  const dataDir = join(home, "cloud-control"),
    staticRootDir = join(home, "cloud-static");
  await mkdir(dataDir, { mode: 0o700 });
  checkpoint();
  await mkdir(staticRootDir, { mode: 0o700 });
  checkpoint();
  await writeFile(
    join(staticRootDir, "index.html"),
    "<!doctype html><title>Managed Cloud fixture</title><h1>Cloud project window</h1>",
  );
  checkpoint();
  const registry = new ProjectRegistry(dataDir);
  try {
    const existing = registry.create("chooser-owner", "Existing Cloud project");
    installationId = registry.installationId;
    registry.bindAccount({
      version: 1,
      accountOrigin,
      accountId,
      ownerId: existing.ownerId,
      managementEpoch: randomUUID(),
      createdAt: Date.now(),
    });
  } finally {
    registry.close();
  }
  const principal: CloudAccountPrincipal = {
    accountOrigin,
    accountId,
    sessionId: rootId,
    rootSessionId: rootId,
    authorityEpoch: randomUUID(),
    expiresAt: Date.now() + 3_600_000,
  };
  backend = await startProjectControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    staticRootDir,
    publicOrigin: cloudOrigin,
    accountAuthority: {
      accountOrigin,
      async redeem(ticket, installation) {
        assert.equal(installation, installationId);
        const expiresAt = tickets.get(ticket);
        tickets.delete(ticket);
        assert.ok(active && expiresAt && expiresAt > Date.now());
        redeemed++;
        return { ...principal };
      },
      async validate(value, installation) {
        assert.equal(installation, installationId);
        assert.ok(active && principal.expiresAt > Date.now());
        assert.deepEqual(value, principal);
        return { ...principal };
      },
    },
    provider: {
      async availability() {
        return { available: true };
      },
      async ensure(project) {
        running.add(project.id);
        started++;
        return {
          url: url(inner!, "http"),
          username: project.runtimeUsername,
          password: project.runtimePassword,
          generation: project.generation,
        };
      },
      async stop(project) {
        running.delete(project.id);
        stopped++;
      },
      async status(project) {
        return running.has(project.id)
          ? { state: "running", url: url(inner!, "http") }
          : { state: "stopped" };
      },
      async close() {
        assert.equal(running.size, 0);
      },
    },
  });
  checkpoint();
  assert.ok(process.connected, "Cloud chooser server requires its owner's IPC channel.");
  await new Promise<void>((done, reject) =>
    process.send!(
      { ready: true, accountOrigin, cloudOrigin, installationId, accountId },
      (error) => (error ? reject(error) : done()),
    ),
  );
} catch (error) {
  if (error !== cancelled) {
    failures.push(error);
    process.exitCode = 1;
  }
  void close();
} finally {
  startupDone();
}
