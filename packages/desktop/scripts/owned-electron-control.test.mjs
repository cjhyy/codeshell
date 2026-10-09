import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { test } from "node:test";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";
import { ownedControlRequest } from "./owned-electron-control.mjs";

const target = "http://127.0.0.1:34567/01234567-89ab-cdef-0123-456789abcdef";
function fixture() {
  const calls = [];
  const owner = { active: true };
  const request = ownedControlRequest(
    (...args) => {
      calls.push(args);
      return "direct owned control";
    },
    () => {
      throw new Error("guard denied");
    },
    new Map([[target, owner]]),
  );
  return { calls, owner, request };
}
test("an exact owned GET upgrade rebuilds native transport and cannot use custom routing", () => {
  const { calls, request } = fixture();
  strictEqual(
    request(target, {
      headers: { Upgrade: "websocket", host: "outside.invalid" },
      agent: {},
      lookup() {
        throw new Error("must not be called");
      },
      createConnection() {
        throw new Error("must not be called");
      },
    }),
    "direct owned control",
  );
  strictEqual(calls[0][0].href, target);
  deepStrictEqual(calls[0][1], {
    method: "GET",
    headers: { Upgrade: "websocket", Host: "127.0.0.1:34567" },
    agent: false,
  });
});
test("other loopback paths, ports, external targets, methods and non-upgrades stay denied", () => {
  const { calls, request } = fixture();
  for (const url of [
    target.replace("34567", "34568"),
    `${target}/other`,
    "http://outside.invalid/",
  ])
    throws(() => request(url, { headers: { upgrade: "websocket" } }), /guard denied/);
  throws(
    () => request(target, { method: "POST", headers: { upgrade: "websocket" } }),
    /guard denied/,
  );
  throws(() => request(target), /guard denied/);
  throws(
    () => request(target, { socketPath: "/tmp/other", headers: { upgrade: "websocket" } }),
    /guard denied/,
  );
  strictEqual(calls.length, 0);
});
test("an exited owner cannot authorize another request to its former endpoint", () => {
  const { calls, owner, request } = fixture();
  owner.active = false;
  throws(() => request(target, { headers: { upgrade: "websocket" } }), /guard denied/);
  strictEqual(calls.length, 0);
});

test("actual HTTP upgrade reaches only the observed endpoint through native loopback TCP", async () => {
  // Playwright controls Electron from actual Node. Bun's node:http client uses
  // its fetch shim, which rejects this 101 upgrade; exercise the real consumer
  // under Node rather than dropping the transport assertion from Bun's shard.
  if (process.versions.bun) {
    strictEqual(
      process.env.CODESHELL_NATIVE_CONTROL_TEST,
      undefined,
      "Native control needs real Node",
    );
    const child = spawn("node", [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CODESHELL_NATIVE_CONTROL_TEST: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      spawnError,
      timedOut = false,
      oversized = false,
      observedBytes = 0;
    const collect = (stream, append) =>
      stream.on("data", (chunk) => {
        observedBytes += chunk.length;
        append(chunk.toString());
        if (observedBytes > 256 * 1_024) {
          oversized = true;
          child.kill("SIGKILL");
        }
      });
    collect(child.stdout, (text) => {
      stdout = `${stdout}${text}`.slice(-256 * 1_024);
    });
    collect(child.stderr, (text) => {
      stderr = `${stderr}${text}`.slice(-256 * 1_024);
    });
    const completion = new Promise((done) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (status, signal) => done({ status, signal }));
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 10_000);
    const killDeadline = setTimeout(() => child.kill("SIGKILL"), 10_500);
    let result;
    try {
      result = await completion;
    } finally {
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill("SIGKILL");
        await completion;
      }
    }
    strictEqual(spawnError, undefined, spawnError?.message);
    strictEqual(timedOut, false, "Native control child exceeded its 10s deadline");
    strictEqual(oversized, false, "Native control child output exceeded its bound");
    strictEqual(result.signal, null, `${stdout}\n${stderr}`);
    strictEqual(result.status, 0, `${stdout}\n${stderr}`);
    const line = stdout.split("\n").find((entry) => entry.startsWith("native-control-receipt "));
    const receipt = JSON.parse(line?.slice("native-control-receipt ".length) ?? "null");
    strictEqual(receipt?.homeHash, createHash("sha256").update(process.env.HOME).digest("hex"));
    strictEqual(receipt.ppid, process.pid);
    strictEqual(receipt.pid, child.pid);
    strictEqual(receipt.executable, realpathSync(receipt.executable));
    strictEqual(
      receipt.executableHash,
      createHash("sha256").update(readFileSync(receipt.executable)).digest("hex"),
    );
    strictEqual(receipt.upgrades, 1);
    console.log(`native-control-receipt ${JSON.stringify(receipt)}`);
    return;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  strictEqual(
    major > 22 || (major === 22 && minor >= 16),
    true,
    "Native control requires Node >=22.16",
  );
  const direct = http.request;
  const marker = Symbol.for("codeshell.cost-smoke.network-guard");
  const previous = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    marker: globalThis[marker],
  };
  let upgrades = 0;
  let customTransportCalled = false;
  const control = http.createServer();
  control.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  const provider = http.createServer((_request, response) => response.end("synthetic"));
  control.listen(0, "127.0.0.1");
  provider.listen(0, "127.0.0.1");
  await Promise.all([once(control, "listening"), once(provider, "listening")]);
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const observed = `http://127.0.0.1:${control.address().port}/01234567-89ab-cdef-0123-456789abcdef`;
  try {
    installLocalNetworkGuard(origin);
    const request = ownedControlRequest(
      direct,
      http.request,
      new Map([[observed, { active: true }]]),
    );
    await new Promise((done, reject) => {
      const req = request(observed, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
        agent: {},
        createConnection() {
          customTransportCalled = true;
          throw new Error("custom transport");
        },
      });
      req.once("error", reject);
      req.once("upgrade", (_response, socket) => {
        socket.destroy();
        done();
      });
      req.end();
    });
    throws(
      () => request(`${observed}/not-owned`, { headers: { Upgrade: "websocket" } }),
      /Cost smoke refused/,
    );
    throws(() => request(observed), /Cost smoke refused/);
    throws(
      () => request("https://not-a-provider.invalid/", { headers: { Upgrade: "websocket" } }),
      /Cost smoke refused/,
    );
    strictEqual(customTransportCalled, false);
    strictEqual(upgrades, 1);
    if (process.env.CODESHELL_NATIVE_CONTROL_TEST === "1")
      console.log(
        `native-control-receipt ${JSON.stringify({
          node: process.version,
          executable: realpathSync(process.execPath),
          executableHash: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
          pid: process.pid,
          ppid: process.ppid,
          homeHash: createHash("sha256").update(process.env.HOME).digest("hex"),
          upgrades,
        })}`,
      );
  } finally {
    globalThis.fetch = previous.fetch;
    http.request = previous.httpRequest;
    http.get = previous.httpGet;
    https.request = previous.httpsRequest;
    https.get = previous.httpsGet;
    if (previous.marker === undefined) delete globalThis[marker];
    else globalThis[marker] = previous.marker;
    syncBuiltinESMExports();
    await Promise.all([
      new Promise((done) => control.close(done)),
      new Promise((done) => provider.close(done)),
    ]);
  }
});
