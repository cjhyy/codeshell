import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { withOwnedAccountDiscovery } from "./owned-account-discovery.cjs";

const origin = "https://115.159.45.55";
const url = `${origin}/api/v1/account/status`;
const options = () => ({ method: "GET", headers: { Origin: origin, Accept: "application/json" } });
function fixture() {
  const denied = [];
  return {
    denied,
    request: withOwnedAccountDiscovery((...args) => {
      denied.push(args);
      throw new Error("fixture denied network");
    }),
  };
}
function read(request, input = new URL(url), init = options()) {
  return new Promise((resolve, reject) => {
    const req = request(input, init, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks)),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("fixed default anonymous status is a static in-memory response with all features disabled", async () => {
  expect(
    readFileSync(new URL("../../server/src/account/types.ts", import.meta.url), "utf8"),
  ).toContain(`DEFAULT_CLOUD_ACCOUNT_ORIGIN = "${origin}"`);
  const f = fixture();
  const result = await read(f.request);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    registrationAllowed: false,
    githubEnabled: false,
    githubLinkEnabled: false,
    linkManagementEnabled: false,
    relay: { enabled: false },
    features: {},
  });
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(f.denied).toHaveLength(0);
});

test("all other targets, request methods and credentials still invoke the original denial counter", () => {
  const f = fixture();
  const probes = [
    [url + "?next=/", options()],
    [url + "#fragment", options()],
    [url.replace("https:", "http:"), options()],
    [url.replace("115.159.45.55", "127.0.0.1"), options()],
    [url.replace("115.159.45.55", "115.159.45.55.example.invalid"), options()],
    [url.replace("/status", "/login"), options()],
    [url.replace("/status", "/overview"), options()],
    [url.replace("https://", "https://user:pass@"), options()],
    [url, { ...options(), method: "POST" }],
    [url, { ...options(), method: "HEAD" }],
    [url, { headers: options().headers }],
    [url, { ...options(), path: "/other" }],
    [url, { ...options(), host: "untrusted.invalid" }],
    [url, { ...options(), ca: "other" }],
    [{ hostname: "115.159.45.55", path: "/api/v1/account/status" }, options()],
    ...["Authorization", "authorization", "Cookie", "Proxy-Authorization"].map((name) => [
      url,
      { ...options(), headers: { ...options().headers, [name]: "private" } },
    ]),
    [url, { ...options(), headers: { ...options().headers, Origin: "https://other.invalid" } }],
  ];
  for (const [input, init] of probes)
    expect(() => f.request(input, init)).toThrow("fixture denied network");
  expect(f.denied).toHaveLength(probes.length);
});

test("the permitted GET cannot send a body and an abort closes without a response", async () => {
  const f = fixture();
  expect(() => f.request(url, options()).end("body")).toThrow("fixture denied network");
  expect(() => f.request(url, options()).write("body")).toThrow("fixture denied network");
  const controller = new AbortController();
  const reason = new Error("owned abort");
  const req = f.request(url, { ...options(), signal: controller.signal });
  const events = [];
  req.on("response", () => events.push("response"));
  req.on("error", (error) => events.push(error));
  const closed = new Promise((resolve) => req.on("close", resolve));
  controller.abort(reason);
  req.end();
  await closed;
  expect(events).toEqual([reason]);
  expect(f.denied).toHaveLength(2);
});

test("the real Node Account transport uses the mock with every socket blocked first", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-account-transport-"));
  try {
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL("../../server/src/account/http.ts", import.meta.url))],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
    });
    const module = join(directory, "transport.mjs");
    writeFileSync(module, bundled.outputFiles[0].text, { mode: 0o600 });
    const bootstrap = join(directory, "bootstrap.mjs");
    writeFileSync(
      bootstrap,
      `
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {syncBuiltinESMExports} from "node:module";
let transportCalls = 0, socketCalls = 0, denied = 0;
const denySocket = () => { socketCalls++; throw Error("Socket forbidden"); };
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = denySocket;
const denyTransport = () => { transportCalls++; throw Error("Original transport forbidden"); };
http.request = http.get = https.request = https.get = globalThis.fetch = denyTransport;
syncBuiltinESMExports();
const {withOwnedAccountDiscovery} = (await import(${JSON.stringify(new URL("./owned-account-discovery.cjs", import.meta.url).href)})).default;
https.request = withOwnedAccountDiscovery(() => { denied++; throw Error("owned deny"); });
syncBuiltinESMExports();
const {createCloudAccountTransport} = await import(${JSON.stringify(pathToFileURL(module).href)});
const request = createCloudAccountTransport();
assert.deepEqual((await request({origin:${JSON.stringify(origin)},path:"/api/v1/account/status",method:"GET"})).features, {});
await assert.rejects(request({origin:${JSON.stringify(origin)},path:"/api/v1/account/status",method:"GET",token:"synthetic-private"}), /owned deny/);
assert.equal(denied, 1);
assert.equal(transportCalls, 0);
assert.equal(socketCalls, 0);
console.log("owned Account transport passed: 0 original transports, 0 sockets");
`,
      { mode: 0o600 },
    );
    expect(execFileSync("node", [bootstrap], { encoding: "utf8" })).toContain(
      "0 original transports, 0 sockets",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
