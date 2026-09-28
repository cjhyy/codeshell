import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = process.argv[2],
  mode = process.argv[3];
const cwd = join(root, "workspace"),
  dataDir = join(root, "desktop"),
  sessionRootDir = join(root, "sessions");
for (const directory of [cwd, dataDir, sessionRootDir]) await fsPromises.mkdir(directory);
await fsPromises.writeFile(join(cwd, "small.txt"), "another phone still reads");
const filename = join(cwd, "large.bin"),
  total = 96 * 1024 * 1024;
const file = await fsPromises.open(filename, "w+");
await file.truncate(total);
const sentinel = Buffer.alloc(1024, 0x79);

// Observe real FileHandles without replacing filesystem I/O. This verifies the
// source and retained parent descriptors close, rather than merely hiding bytes.
const held = new Set();
const nativeOpen = fsPromises.open;
fsPromises.open = async (...args) => {
  const handle = await nativeOpen(...args);
  held.add(handle);
  return handle;
};
syncBuiltinESMExports();
const { createDesktopWebApi } = await import(`${root}/http-api.js`);
const { RemoteHostManager } = await import(`${root}/remote-host-manager.js`);
const { TrustedDeviceStore } = await import(`${root}/trusted-device-store.js`);
const { startHeadlessServer } = await import(`${root}/headless-server.js`);
let host,
  api,
  devices,
  url,
  stopped = false;
let finishBackground, background;
function call(path, cookie, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, url),
      {
        method,
        headers: {
          Origin: url,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            cookie: res.headers["set-cookie"]?.[0].split(";")[0],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function loginDesktop(name) {
  const device = devices.addDevice({ name, secretHash: `${name}-secret` });
  const result = await call("/api/v1/desktop/session", undefined, "POST", {
    deviceId: device.id,
    secretHash: `${name}-secret`,
  });
  assert.equal(result.status, 200);
  return { device, cookie: result.cookie, session: JSON.parse(result.body).session };
}
async function pausedDownload(cookie) {
  let incoming, settle;
  const closed = new Promise((resolve) => {
    settle = resolve;
  });
  let bytes = 0,
    tail = Buffer.alloc(0),
    timedOut = false;
  await new Promise((resolve, reject) => {
    const req = request(
      new URL("/api/v1/files/content?path=large.bin", url),
      { headers: { Origin: url, Cookie: cookie } },
      (res) => {
        incoming = res;
        assert.equal(res.statusCode, 200);
        res.on("data", (chunk) => {
          bytes += chunk.length;
          tail = Buffer.concat([tail, chunk]).subarray(-sentinel.length);
        });
        res.on("error", () => {});
        res.pause();
        res.once("close", () => settle({ bytes, tail, complete: res.complete, timedOut }));
        resolve();
      },
    );
    req.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("download deadline"));
    }, 10_000);
    req.once("close", () => clearTimeout(timer));
    req.end();
  });
  return {
    async resume() {
      incoming.resume();
      return closed;
    },
    stop() {
      incoming.destroy();
    },
  };
}
async function closedHandles(handles) {
  for (let i = 0; i < 200; i++) {
    if ([...handles].every((handle) => handle.fd === -1)) return;
    await delay(5);
  }
  assert.fail("revoked download retained open FileHandles");
}
try {
  let first, other;
  if (mode === "desktop") {
    devices = new TrustedDeviceStore(join(root, "devices.json"));
    api = createDesktopWebApi({
      devices,
      dataDir,
      sessionRootDir,
      resolveWorkspace: () => cwd,
      withConfigurationMutation: (_cwd, write) => write(),
      isRunning: () => false,
      handleExtra(req, res) {
        if (req.url !== "/api/v1/accepted-task") return false;
        background = new Promise((resolve) => {
          finishBackground = resolve;
        });
        res.writeHead(202);
        res.end("accepted");
        return true;
      },
    });
    host = new RemoteHostManager({ devices, webApi: api, onClientEvent() {} });
    url = (await host.start({ host: "127.0.0.1", port: 0 })).url;
    first = await loginDesktop("first");
    other = await loginDesktop("other");
  } else {
    const worker = join(root, "worker.cjs");
    await fsPromises.writeFile(worker, "process.stdin.resume();\n");
    host = await startHeadlessServer({
      host: "127.0.0.1",
      port: 0,
      cwd,
      dataDir,
      sessionRootDir,
      authMode: "hub",
      workerEntryPath: worker,
      execPath: process.execPath,
    });
    url = host.url;
    const setup = await call("/api/v1/auth/setup", undefined, "POST", {
      username: "owner",
      password: "a-long-fixture-password",
      deviceName: "first",
      token: host.bootstrapToken,
    });
    assert.equal(setup.status, 200);
    first = { cookie: setup.cookie, session: JSON.parse(setup.body).session };
    const signedIn = await call("/api/v1/auth/login", undefined, "POST", {
      username: "owner",
      password: "a-long-fixture-password",
      deviceName: "other",
    });
    assert.equal(signedIn.status, 200);
    other = { cookie: signedIn.cookie };
  }
  if (mode === "desktop")
    assert.equal((await call("/api/v1/accepted-task", first.cookie, "POST", {})).status, 202);
  for (const action of ["revoke", "logout"]) {
    if (action === "logout") {
      if (mode === "desktop") first = await loginDesktop("logout");
      else {
        const signedIn = await call("/api/v1/auth/login", undefined, "POST", {
          username: "owner",
          password: "a-long-fixture-password",
          deviceName: "logout",
        });
        first = { cookie: signedIn.cookie, session: JSON.parse(signedIn.body).session };
      }
    }
    await file.write(Buffer.alloc(sentinel.length), 0, sentinel.length, total - sentinel.length);
    const download = await pausedDownload(first.cookie);
    const revokedHandles = new Set(held);
    const otherDownload = await pausedDownload(other.cookie);
    assert.ok(
      [...held].some((handle) => handle.fd >= 0),
      "test must see the real opened source",
    );
    try {
      if (action === "logout")
        assert.equal((await call("/api/v1/auth/logout", first.cookie, "POST", {})).status, 200);
      else if (mode === "desktop") {
        devices.revoke(first.device.id);
        host.revokeDevice(first.device.id);
      } else
        assert.equal(
          (await call(`/api/v1/auth/sessions/${first.session.id}`, other.cookie, "DELETE")).status,
          200,
        );
      await file.write(sentinel, 0, sentinel.length, total - sentinel.length);
      const result = await download.resume();
      console.log(
        JSON.stringify({
          mode,
          action,
          bytes: result.bytes,
          complete: result.complete,
          postRevokeTail: result.tail.equals(sentinel),
          timedOut: result.timedOut,
        }),
      );
      assert.equal(result.timedOut, false, "the probe deadline must not masquerade as revocation");
      assert.ok(
        !result.complete && result.bytes < total && !result.tail.equals(sentinel),
        "revoked session continued reading source file after revocation",
      );
      await closedHandles(revokedHandles);
      const otherResult = await otherDownload.resume();
      assert.equal(otherResult.timedOut, false);
      assert.equal(otherResult.complete, true, "another session's active download was cancelled");
      assert.equal(otherResult.bytes, total);
      await closedHandles(held);
      assert.equal(
        (await call("/api/v1/files/content?path=small.txt", other.cookie)).body,
        "another phone still reads",
      );
      assert.equal((await call("/api/v1/files/content?path=small.txt", first.cookie)).status, 401);
    } finally {
      download.stop();
      otherDownload.stop();
    }
  }
  if (background) {
    finishBackground("completed");
    assert.equal(await background, "completed");
  }
  console.log(
    `PASS ${mode} file revocation; logout, descriptor cleanup, other session and accepted task isolation`,
  );
} finally {
  if (host) {
    await (mode === "desktop" ? host.stop() : host.close());
    stopped = true;
  }
  await file.close();
  fsPromises.open = nativeOpen;
  syncBuiltinESMExports();
  assert.ok(stopped);
}
