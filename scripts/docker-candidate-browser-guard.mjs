// Test-only Playwright request boundary. This is not OS/process confinement.
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { WebSocket } = createRequire(new URL("../packages/server/package.json", import.meta.url))(
  "ws",
);
const guards = new WeakSet();
const refused = () =>
  new Error("Docker candidate browser guard refused unowned authority or transport");
const require = (condition) => {
  if (!condition) throw refused();
};
const within = (root, path) => {
  const value = relative(root, path);
  return value && !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
};

function pinnedRead(path, limit, privateFile, append = false) {
  require(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
  const entry = lstatSync(path);
  require(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1);
  require(realpathSync(path) === path);
  require(process.getuid === undefined || entry.uid === process.getuid());
  require(privateFile ? (entry.mode & 0o777) === 0o600 : !(entry.mode & 0o022));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    require(before.dev === BigInt(entry.dev) && before.ino === BigInt(entry.ino));
    require(before.size > 0n && before.size <= BigInt(limit));
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length; ) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      require(count > 0);
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    require(after.dev === current.dev && after.ino === current.ino && current.nlink === 1n);
    require(realpathSync(path) === path);
    require(current.isFile() && !current.isSymbolicLink());
    require(process.getuid === undefined || current.uid === BigInt(process.getuid()));
    require(privateFile ? (current.mode & 0o777n) === 0o600n : !(current.mode & 0o022n));
    require(after.size <= BigInt(limit) && after.size >= before.size);
    require(
      append ||
        (before.size === after.size &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs),
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function verifiedAuthority({ child, origin, policyPath, policyHash }) {
  require(child instanceof ChildProcess && Number.isSafeInteger(child.pid) && child.pid > 0);
  require(child.exitCode === null && child.signalCode === null && !child.killed);
  require(typeof policyHash === "string" && /^[a-f0-9]{64}$/.test(policyHash));
  const bytes = pinnedRead(policyPath, 64 * 1024, true);
  require(digest(bytes) === policyHash);
  const policy = JSON.parse(bytes.toString("utf8"));
  require(policy.version === 1 && policy.role === "controller");
  require(typeof policy.home === "string" && isAbsolute(policy.home));
  const home = lstatSync(policy.home);
  require(
    home.isDirectory() && !home.isSymbolicLink() && realpathSync(policy.home) === policy.home,
  );
  require(
    (home.mode & 0o777) === 0o700 &&
      (process.getuid === undefined || home.uid === process.getuid()),
  );
  require(within(policy.home, policyPath) && within(policy.home, policy.receipt));
  require(/^[a-f0-9]{64}$/.test(policy.preloadHash) && /^[a-f0-9]{64}$/.test(policy.guardHash));
  require(digest(pinnedRead(policy.preload, 1024 * 1024, false)) === policy.preloadHash);
  const url = new URL(origin);
  require(url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port);
  require(origin === url.origin && !url.username && !url.password && !url.search && !url.hash);
  const receipt = pinnedRead(policy.receipt, 4 * 1024 * 1024, true, true).toString("utf8");
  // The writer may be appending a final line. Every complete line remains strict.
  const rows = receipt
    .slice(0, receipt.lastIndexOf("\n") + 1)
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
  const owns = (row) =>
    row.pid === child.pid &&
    row.ppid === process.pid &&
    row.role === "controller" &&
    row.policyHash === policyHash &&
    row.homeHash === digest(policy.home) &&
    row.preloadHash === policy.preloadHash;
  const preCore = rows.findIndex(
    (row) => owns(row) && row.event === "pre-core" && row.negativeProbes === 6,
  );
  require(preCore >= 0);
  require(
    rows.some(
      (row) =>
        owns(row) &&
        row.event === "listener" &&
        row.host === "127.0.0.1" &&
        row.port === Number(url.port),
    ),
  );
  require(
    rows.findIndex(
      (row) =>
        owns(row) &&
        row.event === "listener" &&
        row.host === "127.0.0.1" &&
        row.port === Number(url.port),
    ) > preCore,
  );
  return { child, origin, wsOrigin: origin.replace(/^http:/, "ws:") };
}

function exactOrigin(value, origin) {
  try {
    const url = new URL(value);
    return (
      url.protocol === new URL(origin).protocol &&
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function assertDockerBrowserGuard(guard) {
  require(guards.has(guard));
}

// Pure-test seam for the request transport, not an authority factory. Production
// callers always use the pinned ws implementation from createDockerBrowserGuard.
export async function bridgeDockerCandidateWebSocket({ route, context, origin, live, WebSocket }) {
  live();
  require(exactOrigin(route.url(), origin.replace(/^http:/, "ws:")));
  const protocols = route.protocols();
  // Playwright's mocked socket selects the first offered subprotocol. Preserve
  // that selection or refuse; never report a different upstream negotiation.
  require(Array.isArray(protocols) && protocols.every((value) => typeof value === "string"));
  const cookies = await context.cookies(route.url().replace(/^ws:/, "http:"));
  live();
  const headers = { Origin: origin };
  if (cookies.length)
    headers.Cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const socket = new WebSocket(route.url(), protocols, {
    headers,
    followRedirects: false,
    handshakeTimeout: 10_000,
  });
  let settled = false;
  let opened = false;
  let resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  const stop = () => {
    if (!settled) socket.terminate();
  };
  const ready = new Promise((resolve, reject) => {
    socket.once("open", () => {
      try {
        live();
        require(socket.protocol === (protocols[0] ?? ""));
        opened = true;
        resolve();
      } catch (error) {
        reject(error);
        stop();
      }
    });
    socket.on("error", () => {
      reject(refused());
      void route.close({ code: 1011, reason: "Candidate request refused" });
      stop();
    });
    socket.once("close", (code, reason) => {
      settled = true;
      resolveClosed();
      if (!opened) reject(refused());
      // Upstream reason text is not a test diagnostic and may contain secrets.
      void route.close({ code, reason: reason.toString() });
    });
  });
  socket.on("message", (bytes, binary) => {
    try {
      live();
      route.send(binary ? Buffer.from(bytes) : bytes.toString());
    } catch {
      stop();
    }
  });
  route.onMessage((message) => {
    try {
      live();
      require(opened && !settled);
      socket.send(message, { binary: typeof message !== "string" });
    } catch {
      stop();
    }
  });
  route.onClose((code, reason) => {
    if (opened && !settled) {
      if (code === 1000 || (code >= 3000 && code <= 4999)) socket.close(code, reason);
      else socket.close();
    } else stop();
  });
  return { ready, closed, stop };
}

export async function releaseDockerCandidateSockets(sockets) {
  const pending = [...sockets];
  const errors = [];
  for (const socket of pending) {
    try {
      socket.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  let timer;
  try {
    const results = await Promise.race([
      Promise.allSettled(pending.map((socket) => socket.closed)),
      new Promise((_, reject) => (timer = setTimeout(() => reject(refused()), 5000))),
    ]);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
  }
  if (errors.length)
    throw new AggregateError(errors, "Candidate socket cleanup failed", { cause: errors[0] });
}

export async function createDockerBrowserGuard(input) {
  const authority = {
    child: input.child,
    origin: input.origin,
    policyPath: input.policyPath,
    policyHash: input.policyHash,
  };
  const owned = verifiedAuthority(authority);
  const browsers = new WeakMap();
  const live = () =>
    require(
      owned.child.exitCode === null && owned.child.signalCode === null && !owned.child.killed,
    );
  const guard = {
    async createContext(browser, options = {}) {
      verifiedAuthority(authority);
      require(browser?.browserType?.().name() === "chromium" && browser.isConnected());
      require(
        Object.keys(options).every((key) =>
          ["viewport", "hasTouch", "acceptDownloads", "permissions", "serviceWorkers"].includes(
            key,
          ),
        ),
      );
      require(options.serviceWorkers === undefined || options.serviceWorkers === "block");
      let state = browsers.get(browser);
      if (!state) {
        require(browser.contexts().length === 0); // No CDP/default or pre-existing context.
        state = {
          create: browser.newContext.bind(browser),
          contexts: new Set(),
          sockets: new Set(),
          closing: false,
        };
        browsers.set(browser, state);
        browser.newContext = browser.newPage = () => {
          throw refused();
        };
        const close = browser.close.bind(browser);
        browser.close = async (...args) => {
          state.closing = true;
          const results = await Promise.allSettled([
            releaseDockerCandidateSockets(state.sockets),
            close(...args),
          ]);
          const errors = results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (errors.length) throw new AggregateError(errors, "Candidate browser cleanup failed");
        };
      }
      require(browser.contexts().every((context) => state.contexts.has(context)));
      require(!state.closing);
      const context = await state.create({ ...options, serviceWorkers: "block" });
      const sockets = new Set();
      let accepting = true;
      const contextLive = () => {
        live();
        require(accepting && !state.closing);
      };
      const stop = () => {
        for (const socket of sockets) socket.stop();
      };
      owned.child.on("exit", stop);
      context.once("close", () => {
        accepting = false;
        stop();
        owned.child.off("exit", stop);
      });
      const close = context.close.bind(context);
      context.close = async (...args) => {
        accepting = false;
        const results = await Promise.allSettled([
          releaseDockerCandidateSockets(sockets),
          close(...args),
        ]);
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Candidate context cleanup failed");
      };
      try {
        contextLive();
        require(context.browser() === browser && context.pages().length === 0);
        require(
          typeof context.route === "function" && typeof context.routeWebSocket === "function",
        );
        await context.route("**/*", async (route) => {
          try {
            contextLive();
            const request = route.request();
            if (!exactOrigin(request.url(), owned.origin))
              return await route.abort("blockedbyclient");
            if (/text\/event-stream/i.test(request.headers()["accept"] ?? ""))
              return await route.abort("blockedbyclient");
            // Playwright only routes the first redirect hop. Never let its HTTP
            // client or Chromium follow a redirect outside this callback.
            const response = await route.fetch({ maxRedirects: 0, timeout: 150000 });
            try {
              contextLive();
              if (
                (response.status() >= 300 &&
                  response.status() < 400 &&
                  response.status() !== 304) ||
                /text\/event-stream/i.test(response.headers()["content-type"] ?? "")
              )
                return await route.abort("blockedbyclient");
              await route.fulfill({ response }); // Preserve status, headers and finite body bytes/Range.
            } finally {
              await response.dispose();
            }
          } catch {
            await route.abort("blockedbyclient");
          }
        });
        await context.routeWebSocket("**/*", async (route) => {
          if (
            owned.child.exitCode !== null ||
            owned.child.signalCode !== null ||
            owned.child.killed ||
            !exactOrigin(route.url(), owned.wsOrigin)
          )
            return await route.close({ code: 1008, reason: "Candidate request refused" });
          try {
            const bridge = await bridgeDockerCandidateWebSocket({
              route,
              context,
              origin: owned.origin,
              live: contextLive,
              WebSocket,
            });
            sockets.add(bridge);
            state.sockets.add(bridge);
            void bridge.closed.then(() => {
              sockets.delete(bridge);
              state.sockets.delete(bridge);
            });
            await bridge.ready;
          } catch {
            await route.close({ code: 1008, reason: "Candidate request refused" });
          }
        });
        await context.addInitScript(() => {
          for (const name of [
            "WebTransport",
            "RTCPeerConnection",
            "webkitRTCPeerConnection",
            "EventSource",
            "Worker",
            "SharedWorker",
          ])
            Object.defineProperty(globalThis, name, {
              configurable: false,
              writable: false,
              value: class {
                constructor() {
                  throw new Error("Candidate browser transport refused");
                }
              },
            });
        });
        const newPage = context.newPage.bind(context);
        context.newPage = (...args) => {
          contextLive();
          require(browser.contexts().every((entry) => state.contexts.has(entry)));
          return newPage(...args);
        };
        state.contexts.add(context);
        return context;
      } catch (error) {
        let cleanupFailure;
        let cleanupFailed = false;
        try {
          await context.close();
        } catch (cleanup) {
          cleanupFailed = true;
          cleanupFailure = cleanup;
        }
        if (cleanupFailed)
          throw new AggregateError([error, cleanupFailure], "Candidate context setup failed", {
            cause: error,
          });
        throw error;
      }
    },
  };
  guards.add(guard);
  return guard;
}
