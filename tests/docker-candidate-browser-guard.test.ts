import { expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import {
  assertDockerBrowserGuard,
  bridgeDockerCandidateHttp,
  bridgeDockerCandidateWebSocket,
  createDockerBrowserGuard,
  releaseDockerCandidateSockets,
} from "../scripts/docker-candidate-browser-guard.mjs";

import { createTestStockWebSocketPackage } from "./fixtures/docker-candidate-stock-ws-package.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const origin = "http://127.0.0.1:32123";

// No process, socket or browser is started. The ChildProcess instance is a
// synthetic receipt subject; actual capture/driver integration belongs to CI.
function fixture(sourceAnchor = new URL("../packages/server/package.json", import.meta.url)) {
  const ws = createTestStockWebSocketPackage(fileURLToPath(sourceAnchor));
  const root = ws.root;
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const preload = join(root, "preload.mjs");
  writeFileSync(preload, "// inert fixture\n", { mode: 0o644 });
  const receipt = join(home, "controller.jsonl");
  const policyPath = join(home, "controller-policy.json");
  const policy = {
    version: 1,
    role: "controller",
    stockWebSocket: ws.pin,
    home,
    preload,
    preloadHash: hash(readFileSync(preload)),
    guardHash: hash("guard"),
    receipt,
  };
  const child = new ChildProcess();
  child.pid = process.pid + 100000;
  const savePolicy = () => {
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
    return hash(readFileSync(policyPath));
  };
  const input = { child, origin, policyPath, policyHash: savePolicy() };
  const common = () => ({
    pid: child.pid,
    ppid: process.pid,
    role: "controller",
    policyHash: input.policyHash,
    homeHash: hash(home),
    preloadHash: policy.preloadHash,
  });
  const rows = () => [
    { ...common(), event: "pre-core", negativeProbes: 6, dnsNegativeProbes: 4 },
    { ...common(), event: "listener", host: "127.0.0.1", port: 32123 },
  ];
  const saveRows = (value = rows(), suffix = "") =>
    writeFileSync(receipt, value.map((row) => JSON.stringify(row)).join("\n") + "\n" + suffix, {
      mode: 0o600,
    });
  saveRows();
  return {
    root,
    home,
    preload,
    policy,
    input,
    rows,
    saveRows,
    savePolicy,
    dispose: ws.dispose,
  };
}

test("real ws resolution and guard pinning work with a Unicode and space-containing source anchor", async () => {
  const root = mkdtempSync(join(tmpdir(), "中文 source anchor with spaces-"));
  let f: ReturnType<typeof fixture> | undefined;
  try {
    writeFileSync(join(root, "package.json"), '{"private":true}');
    symlinkSync(
      fileURLToPath(new URL("../packages/server/node_modules", import.meta.url)),
      join(root, "node_modules"),
      "dir",
    );
    f = fixture(pathToFileURL(join(root, "package.json")));
    const guard = await createDockerBrowserGuard(f.input);
    expect(() => assertDockerBrowserGuard(guard)).not.toThrow();
    await guard.createContext(fakeBrowser().browser);
  } finally {
    f?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeBrowser({ preexisting = false, setupFailure = false, closeFailure = false } = {}) {
  const contexts = [];
  const calls = [];
  const browser = {
    browserType: () => ({ name: () => "chromium" }),
    isConnected: () => true,
    contexts: () => contexts,
    async newContext(options) {
      calls.push(["context", options]);
      const context = new EventEmitter();
      Object.assign(context, {
        browser: () => browser,
        pages: () => [],
        async route(pattern, handler) {
          calls.push(["http", pattern]);
          context.http = handler;
        },
        async routeWebSocket(pattern, handler) {
          calls.push(["ws", pattern]);
          context.ws = handler;
        },
        async addInitScript(handler) {
          calls.push(["init"]);
          if (setupFailure) throw null;
          context.init = handler;
        },
        async newPage() {
          calls.push(["page"]);
          return {};
        },
        async close() {
          calls.push(["close-context"]);
          context.emit("close");
          const index = contexts.indexOf(context);
          if (index >= 0) contexts.splice(index, 1);
          if (closeFailure) throw undefined;
        },
      });
      contexts.push(context);
      return context;
    },
    async close() {
      calls.push(["close-browser"]);
      for (const context of [...contexts]) await context.close();
    },
  };
  if (preexisting) contexts.push({});
  return { browser, calls };
}

test("authority pins private bytes, captured subject and pre-Core/listener order", async () => {
  const f = fixture();
  try {
    f.saveRows(f.rows(), '{"inflight":');
    const guard = await createDockerBrowserGuard(f.input);
    expect(() => assertDockerBrowserGuard(guard)).not.toThrow();
    expect(() => assertDockerBrowserGuard({ createContext() {} })).toThrow();
    // Normal receipt append is accepted, while malformed complete rows are not.
    f.saveRows([...f.rows(), { event: "other" }]);
    await guard.createContext(fakeBrowser().browser);
    f.saveRows(f.rows(), "broken\n");
    await expect(createDockerBrowserGuard(f.input)).rejects.toThrow();
  } finally {
    f.dispose();
  }
});

const invalidAuthority = [
  [
    "wrong policy digest",
    (f) => {
      f.input.policyHash = "0".repeat(64);
    },
  ],
  [
    "env-shaped fake child",
    (f) => {
      f.input.child = { pid: f.input.child.pid, exitCode: null, signalCode: null };
    },
  ],
  [
    "exited child",
    (f) => {
      f.input.child.exitCode = 0;
    },
  ],
  [
    "signalled child",
    (f) => {
      f.input.child.signalCode = "SIGTERM";
    },
  ],
  [
    "killed child",
    (f) => {
      f.input.child.killed = true;
    },
  ],
  [
    "wrong pid",
    (f) => {
      const rows = f.rows();
      rows[1].pid++;
      f.saveRows(rows);
    },
  ],
  [
    "wrong parent",
    (f) => {
      const rows = f.rows();
      rows[0].ppid++;
      f.saveRows(rows);
    },
  ],
  [
    "wrong home proof",
    (f) => {
      const rows = f.rows();
      rows[0].homeHash = "0".repeat(64);
      f.saveRows(rows);
    },
  ],
  [
    "wrong preload proof",
    (f) => {
      const rows = f.rows();
      rows[0].preloadHash = "0".repeat(64);
      f.saveRows(rows);
    },
  ],
  [
    "wrong receipt policy",
    (f) => {
      const rows = f.rows();
      rows[0].policyHash = "0".repeat(64);
      f.saveRows(rows);
    },
  ],
  [
    "wrong role",
    (f) => {
      const rows = f.rows();
      rows[1].role = "runtime";
      f.saveRows(rows);
    },
  ],
  ["listener before pre-Core", (f) => f.saveRows(f.rows().reverse())],
  [
    "incomplete negative probes",
    (f) => {
      const rows = f.rows();
      rows[0].negativeProbes = 5;
      f.saveRows(rows);
    },
  ],
  [
    "missing DNS negative probes",
    (f) => {
      const rows = f.rows();
      delete rows[0].dnsNegativeProbes;
      f.saveRows(rows);
    },
  ],
  [
    "wrong DNS negative probe count",
    (f) => {
      const rows = f.rows();
      rows[0].dnsNegativeProbes = 5;
      f.saveRows(rows);
    },
  ],
  [
    "wrong listener port",
    (f) => {
      const rows = f.rows();
      rows[1].port++;
      f.saveRows(rows);
    },
  ],
  [
    "hostname alias",
    (f) => {
      f.input.origin = "http://localhost:32123";
    },
  ],
  [
    "origin path",
    (f) => {
      f.input.origin += "/";
    },
  ],
  [
    "origin userinfo",
    (f) => {
      f.input.origin = "http://secret@127.0.0.1:32123";
    },
  ],
  [
    "origin query",
    (f) => {
      f.input.origin += "?token=secret";
    },
  ],
  ["public home", (f) => chmodSync(f.home, 0o755)],
  ["public policy", (f) => chmodSync(f.input.policyPath, 0o644)],
  ["public receipt", (f) => chmodSync(f.policy.receipt, 0o644)],
  ["mutable preload", (f) => chmodSync(f.preload, 0o666)],
  ["changed preload", (f) => writeFileSync(f.preload, "changed")],
  ["hardlinked receipt", (f) => linkSync(f.policy.receipt, join(f.home, "alias"))],
  [
    "symlink receipt",
    (f) => {
      const path = f.policy.receipt;
      const bytes = readFileSync(path);
      rmSync(path);
      writeFileSync(join(f.home, "real"), bytes, { mode: 0o600 });
      symlinkSync(join(f.home, "real"), path);
    },
  ],
  [
    "receipt outside home",
    (f) => {
      f.policy.receipt = join(f.root, "outside");
      f.input.policyHash = f.savePolicy();
      f.saveRows();
    },
  ],
  ["oversized receipt", (f) => f.saveRows(f.rows(), "x".repeat(4 * 1024 * 1024))],
];
for (const [label, mutate] of invalidAuthority)
  test(`authority rejects ${label}`, async () => {
    const f = fixture();
    try {
      mutate(f);
      await expect(createDockerBrowserGuard(f.input)).rejects.toThrow();
    } finally {
      f.dispose();
    }
  });

test("all context boundaries install before any page; defaults and arbitrary options fail closed", async () => {
  const f = fixture();
  try {
    const guard = await createDockerBrowserGuard(f.input);
    await expect(guard.createContext(fakeBrowser({ preexisting: true }).browser)).rejects.toThrow();
    for (const options of [
      { serviceWorkers: "allow" },
      { ignoreHTTPSErrors: true },
      { proxy: {} },
      { baseURL: origin },
    ])
      await expect(guard.createContext(fakeBrowser().browser, options)).rejects.toThrow();
    const { browser, calls } = fakeBrowser();
    const context = await guard.createContext(browser, {
      viewport: { width: 390, height: 844 },
      permissions: ["microphone"],
      acceptDownloads: true,
    });
    expect(calls.map(([name]) => name)).toEqual(["context", "http", "ws", "init"]);
    expect(calls[0][1]).toEqual({
      viewport: { width: 390, height: 844 },
      permissions: ["microphone"],
      acceptDownloads: true,
      serviceWorkers: "block",
    });
    expect(() => browser.newContext({})).toThrow();
    expect(() => browser.newPage()).toThrow();
    const sandbox = {};
    runInNewContext(`(${context.init.toString()})()`, sandbox);
    for (const name of [
      "Worker",
      "SharedWorker",
      "WebTransport",
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "EventSource",
    ])
      expect(() => new sandbox[name]()).toThrow();
    await context.newPage();
    expect(calls.at(-1)[0]).toBe("page");
    // Caller mutation cannot switch the factory's captured subject.
    f.input.origin = "http://127.0.0.1:40000";
    await guard.createContext(browser);
    f.input.child.exitCode = 0;
    expect(() => context.newPage()).toThrow();
    await expect(guard.createContext(browser)).rejects.toThrow();
    await browser.close();
    expect(f.input.child.listenerCount("exit")).toBe(0);
  } finally {
    f.dispose();
  }
});

test("setup rejection keeps original non-Error failure and closes its context", async () => {
  const f = fixture();
  try {
    const guard = await createDockerBrowserGuard(f.input);
    const { browser, calls } = fakeBrowser({ setupFailure: true });
    await expect(guard.createContext(browser)).rejects.toBe(null);
    expect(calls.at(-1)).toEqual(["close-context"]);
    expect(f.input.child.listenerCount("exit")).toBe(0);
  } finally {
    f.dispose();
  }
});

test("setup and cleanup failures both survive; each owned socket receives release independently", async () => {
  const f = fixture();
  try {
    const guard = await createDockerBrowserGuard(f.input);
    const { browser } = fakeBrowser({ setupFailure: true, closeFailure: true });
    const result = await guard.createContext(browser).then(
      () => null,
      (error) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.cause).toBe(null);
    expect(result.errors[0]).toBe(null);
    expect(result.errors[1].errors).toEqual([undefined]);
    const calls = [];
    const release = await releaseDockerCandidateSockets(
      new Set([
        {
          stop() {
            calls.push("first");
            throw null;
          },
          closed: Promise.resolve(),
        },
        {
          stop() {
            calls.push("second");
          },
          closed: Promise.reject(undefined),
        },
      ]),
    ).then(
      () => null,
      (error) => error,
    );
    expect(calls).toEqual(["first", "second"]);
    expect(release.errors).toEqual([null, undefined]);
    expect(release.cause).toBe(null);
    let stopped = false;
    await releaseDockerCandidateSockets(
      new Set([
        {
          stop() {
            stopped = true;
          },
          closed: Promise.resolve(),
        },
      ]),
    );
    expect(stopped).toBe(true);
  } finally {
    f.dispose();
  }
});

test("HTTP cleanup attempts every resource and preserves non-Error destroy failures", async () => {
  const original = http.request;
  const destroyed = [];
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  http.request = (_url, _options, callback) => {
    const client = new EventEmitter();
    client.end = () => {
      const message = new EventEmitter();
      Object.assign(message, {
        statusCode: 200,
        headers: {},
        rawHeaders: [],
        destroy() {
          destroyed.push("response");
          throw false;
        },
      });
      callback(message);
      started();
    };
    client.destroy = () => {
      destroyed.push("request");
      throw undefined;
    };
    return client;
  };
  try {
    const operation = bridgeDockerCandidateHttp({
      request: {
        url: () => origin,
        method: () => "GET",
        allHeaders: async () => ({}),
        postDataBuffer: () => null,
      },
      origin,
      live() {},
    });
    await ready;
    operation.stop();
    await expect(operation.response).rejects.toThrow();
    const failure = await operation.closed.catch((error) => error);
    expect(destroyed).toEqual(["request", "response"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([undefined, false]);
    expect(failure.cause).toBeUndefined();
  } finally {
    http.request = original;
  }
});

function httpRoute(
  url,
  { status = 200, contentType = "application/octet-stream", accept = "", failFetch = false } = {},
) {
  const calls = [];
  const response = {
    status: () => status,
    headers: () => ({ "content-type": contentType, "content-range": "bytes 0-7/8" }),
    async dispose() {
      calls.push(["dispose"]);
    },
  };
  const route = {
    request: () => ({
      url: () => url,
      method: () => "GET",
      headers: () => ({ accept }),
      allHeaders: async () => ({ accept }),
      postDataBuffer: () => null,
    }),
    async fulfill(value) {
      calls.push(["fulfill", value]);
    },
    async abort(reason) {
      calls.push(["abort", reason]);
    },
  };
  const native = (target, options, onResponse) => {
    calls.push(["native", target.href, options]);
    const client = new EventEmitter();
    client.destroy = () => client.emit("close");
    client.end = () =>
      queueMicrotask(() => {
        if (failFetch) return client.emit("error", new Error("private response"));
        const message = new PassThrough();
        message.statusCode = status;
        message.headers = { "content-type": contentType, "content-range": "bytes 0-7/8" };
        message.rawHeaders = Object.entries(message.headers).flat();
        onResponse(message);
        if (!message.destroyed)
          message.end(status === 304 ? Buffer.alloc(0) : Buffer.from("finite"));
      });
    return client;
  };
  return { route, response, calls, native };
}

test("HTTP permits exact finite responses and 304, blocks every redirect without following", async () => {
  const f = fixture();
  const originalRequest = http.request;
  try {
    const guard = await createDockerBrowserGuard(f.input);
    const { browser } = fakeBrowser();
    const context = await guard.createContext(browser);
    for (const status of [200, 206, 304, 401, 500]) {
      const r = httpRoute(`${origin}/p/test/media?range=owned`, { status });
      http.request = r.native;
      await context.http(r.route);
      expect(r.calls).toEqual([
        [
          "native",
          `${origin}/p/test/media?range=owned`,
          { method: "GET", headers: { accept: "" }, agent: false },
        ],
        [
          "fulfill",
          {
            status,
            headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-7/8" },
            body: status === 304 ? Buffer.alloc(0) : Buffer.from("finite"),
          },
        ],
      ]);
    }
    for (const status of [300, 301, 302, 303, 305, 307, 308, 399]) {
      const r = httpRoute(`${origin}/redirect`, { status });
      http.request = r.native;
      await context.http(r.route);
      expect(r.calls.map(([name]) => name)).toEqual(["native", "abort"]);
    }
    for (const url of [
      "https://evil.invalid/",
      "http://127.0.0.1:32124/",
      "http://localhost:32123/",
      "file:///etc/passwd",
      "data:text/plain,x",
      "blob:http://127.0.0.1:32123/x",
      "ftp://127.0.0.1:32123/a",
      `${origin}/x#fragment`,
      "http://secret@127.0.0.1:32123/",
    ]) {
      const r = httpRoute(url);
      await context.http(r.route);
      expect(r.calls).toEqual([["abort", "blockedbyclient"]]);
    }
    for (const options of [
      { accept: "text/event-stream" },
      { contentType: "text/event-stream" },
      { failFetch: true },
    ]) {
      const r = httpRoute(`${origin}/events`, options);
      http.request = r.native;
      await context.http(r.route);
      expect(r.calls.some(([name]) => name === "abort")).toBe(true);
      expect(r.calls.some(([name]) => name === "fulfill")).toBe(false);
    }
    f.input.child.signalCode = "SIGTERM";
    const r = httpRoute(`${origin}/after-exit`);
    await context.http(r.route);
    expect(r.calls).toEqual([["abort", "blockedbyclient"]]);
    await browser.close();
  } finally {
    http.request = originalRequest;
    f.dispose();
  }
});

function fakeSocketFixture(protocols = []) {
  const calls = [];
  const sockets = [];
  class Socket extends EventEmitter {
    protocol = protocols[0] ?? "";
    constructor(url, offered, options) {
      super();
      sockets.push(this);
      calls.push(["connect", url, offered, options]);
    }
    send(bytes, options) {
      calls.push(["upstream", bytes, options]);
    }
    close(code, reason) {
      calls.push(["close-upstream", code, reason]);
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }
    terminate() {
      calls.push(["terminate"]);
      this.emit("close", 1006, Buffer.alloc(0));
    }
  }
  const route = {
    url: () => "ws://127.0.0.1:32123/p/owned/socket?project=fixture",
    protocols: () => protocols,
    onMessage(handler) {
      route.message = handler;
    },
    onClose(handler) {
      route.closed = handler;
    },
    send(bytes) {
      calls.push(["downstream", bytes]);
    },
    async close(options) {
      calls.push(["close-page", options]);
    },
  };
  const context = {
    async cookies(url) {
      calls.push(["cookies", url]);
      return [{ name: "hub_session", value: "owned-private-cookie" }];
    },
  };
  return { route, context, calls, WebSocket: Socket, socket: () => sockets.at(-1) };
}

test("WS transport never follows redirects and preserves scoped cookie, origin, protocol and bytes", async () => {
  const f = fakeSocketFixture(["owned-protocol"]);
  const bridge = await bridgeDockerCandidateWebSocket({ ...f, origin, live() {} });
  expect(f.calls[0]).toEqual(["cookies", `${origin}/p/owned/socket?project=fixture`]);
  expect(f.calls[1]).toEqual([
    "connect",
    f.route.url(),
    ["owned-protocol"],
    {
      headers: { Origin: origin, Cookie: "hub_session=owned-private-cookie" },
      followRedirects: false,
      handshakeTimeout: 10000,
    },
  ]);
  f.socket().emit("open");
  await bridge.ready;
  f.route.message("outbound text");
  const binary = Buffer.from([0, 128, 255]);
  f.route.message(binary);
  f.socket().emit("message", Buffer.from("inbound text"), false);
  f.socket().emit("message", binary, true);
  expect(f.calls.slice(2)).toEqual([
    ["upstream", "outbound text", { binary: false }],
    ["upstream", binary, { binary: true }],
    ["downstream", "inbound text"],
    ["downstream", binary],
  ]);
  f.route.closed(3001, "normal close");
  await bridge.closed;
  expect(f.calls.slice(-2)).toEqual([
    ["close-upstream", 3001, "normal close"],
    ["close-page", { code: 3001, reason: "normal close" }],
  ]);
});

test("WS foreign targets refuse before cookie lookup; handshake errors and changed protocol close", async () => {
  for (const value of [
    "ws://evil.invalid/x",
    "wss://127.0.0.1:32123/x",
    "ws://secret@127.0.0.1:32123/x",
    "ws://127.0.0.1:32124/x",
  ]) {
    const f = fakeSocketFixture();
    f.route.url = () => value;
    await expect(bridgeDockerCandidateWebSocket({ ...f, origin, live() {} })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
  for (const mode of ["error", "protocol"]) {
    const f = fakeSocketFixture(["owned"]);
    const bridge = await bridgeDockerCandidateWebSocket({ ...f, origin, live() {} });
    const rejected = bridge.ready.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    );
    if (mode === "error") f.socket().emit("error", new Error("HTTP 302 private credential"));
    else {
      f.socket().protocol = "foreign";
      f.socket().emit("open");
    }
    expect((await rejected).error).toBeInstanceOf(Error);
    await bridge.closed;
    expect(f.calls.some(([name]) => name === "terminate")).toBe(true);
    expect(JSON.stringify(f.calls)).not.toContain("private credential");
  }
});

test("WS dead authority after cookie read never connects and termination confirms close", async () => {
  const f = fakeSocketFixture();
  let active = true;
  f.context.cookies = async () => {
    active = false;
    return [];
  };
  await expect(
    bridgeDockerCandidateWebSocket({
      ...f,
      origin,
      live() {
        if (!active) throw null;
      },
    }),
  ).rejects.toBe(null);
  expect(f.socket()).toBeUndefined();
  const g = fakeSocketFixture();
  const bridge = await bridgeDockerCandidateWebSocket({ ...g, origin, live() {} });
  g.socket().emit("open");
  await bridge.ready;
  bridge.stop();
  await bridge.closed;
  expect(g.calls.at(-2)).toEqual(["terminate"]);
  expect(g.calls.at(-1)).toEqual(["close-page", { code: 1006, reason: "" }]);
});
