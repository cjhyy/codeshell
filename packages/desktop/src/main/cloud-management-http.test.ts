import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = String.raw`
import assert from "node:assert/strict";
import http from "node:http";
import https, { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
const cert = await readFile(join(root, "cert.pem"));
const key = await readFile(join(root, "key.pem"));
let reply = { status: 200, body: { ok: true } }, requests = 0, redirects = 0, origin, last, hang = false;
const server = createServer({ cert, key }, async (req, res) => {
  req.on("error", () => {}); res.on("error", () => {});
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests++; if (req.url === "/leak") redirects++;
  assert.equal(req.headers.origin, req.url === "/api/v1/cloud-management/session" ? undefined : origin);
  assert.equal(req.headers.cookie, undefined);
  last = { path: req.url, method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
  if (hang) return;
  res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
  res.end(reply.raw ?? JSON.stringify(reply.body));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = "https://127.0.0.1:" + server.address().port;
const nativeRequest = https.request;
https.request = (url, ...args) => { assert.equal(new URL(url).origin, origin); return nativeRequest(url, ...args); };
const deny = () => { throw new Error("fixture denies uncontrolled networking"); };
http.request = http.get = https.get = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
assert.throws(() => https.request("https://other.invalid"));
assert.throws(() => http.request("http://127.0.0.1:9"));
const { createCloudManagementTransport, CloudManagementHttpError } = await import(pathToFileURL(join(root, "cloud-management-http.js")));
const send = createCloudManagementTransport(cert);
const token = "a".repeat(43), ticket = "b".repeat(43), privateValue = "synthetic-private-upstream-value";
const pid = "10000000-0000-0000-0000-000000000001";
const base = { origin, method: "POST", path: "/api/v1/cloud-management/session", body: { ticket } };
async function failed(input, status = 0) {
  await assert.rejects(() => send(input), (error) => {
    assert.ok(error instanceof CloudManagementHttpError); assert.equal(error.status, status);
    assert.ok(!String(error).includes(privateValue)); assert.ok(!JSON.stringify(error).includes(privateValue)); return true;
  });
}
try {
  await send({ origin, method: "GET", path: "/api/v1/cloud-management/capabilities" });
  assert.deepEqual(last, { path: "/api/v1/cloud-management/capabilities", method: "GET", authorization: undefined, body: "" });
  await send(base);
  assert.deepEqual(last, { path: base.path, method: "POST", authorization: undefined, body: JSON.stringify({ ticket }) });
  for (const input of [
    { method: "GET", path: "/api/v1/projects" },
    { method: "POST", path: "/api/v1/projects", body: { name: "Work" } },
    ...["start", "stop", "open"].map((action) => ({ method: "POST", path: "/api/v1/projects/"+pid+"/"+action, body: {} })),
    { method: "POST", path: "/api/v1/cloud-management/logout", body: {} },
  ]) {
    await send({ origin, token, ...input });
    assert.equal(last.authorization, "Bearer " + token); assert.equal(last.path, input.path);
    assert.equal(last.body, input.body === undefined ? "" : JSON.stringify(input.body));
  }
  const beforeInvalid = requests;
  for (const input of [
    { ...base, body: { accountToken: token } }, { ...base, body: { ticket, extra: true } },
    { ...base, token }, { ...base, path: "/api/v1/cloud-management/session?x=1" },
    { ...base, path: "/api/v1/cloud-management/logout", token, body: { all: true } },
    { origin, method: "GET", path: "/api/v1/projects", token, body: {} },
    { origin, method: "POST", path: "/api/v1/projects", token, body: { name: "Work", ownerId: "other" } },
    { origin, method: "POST", path: "/api/v1/projects/"+pid+"/open?x=1", token, body: {} },
    { origin, method: "GET", path: "/api/v1/cloud-management/capabilities", token },
  ]) await assert.rejects(() => send(input));
  assert.equal(requests, beforeInvalid);
  reply = { status: 307, headers: { Location: origin+"/leak" }, body: { message: privateValue } };
  await failed(base, 307); assert.equal(redirects, 0);
  const beforeTls = requests;
  await assert.rejects(() => createCloudManagementTransport()(base), (error) => error.status === 0);
  assert.equal(requests, beforeTls);
  reply = { status: 403, body: { accessToken: privateValue, error: privateValue } };
  await failed(base, 403);
  reply = { status: 200, body: { data: "x".repeat(20_000) } };
  await failed(base);
  assert.equal((await send({ origin, method: "GET", path: "/api/v1/projects", token })).data.length, 20_000);
  reply = { status: 200, body: { data: "x".repeat(1_048_576) } };
  await failed({ origin, method: "GET", path: "/api/v1/projects", token });
  reply = { status: 200, raw: "invalid JSON " + privateValue };
  await failed(base);
  const abort = new AbortController(); abort.abort(new Error(privateValue));
  await failed({ ...base, signal: abort.signal });
  hang = true;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 15000 ? 25 : ms, ...args);
  try { await failed(base); } finally { globalThis.setTimeout = realTimeout; }
  console.log("PASS native Cloud HTTPS");
} finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
`;

test("native Cloud HTTPS confines tickets, project requests, redirects and response sizes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-management-http-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=account-http-test",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    await symlink(resolve("packages/server/node_modules"), join(root, "node_modules"));
    const compiler = Bun.spawn(
      [
        process.execPath,
        "build",
        "packages/desktop/src/main/cloud-management-http.ts",
        "--outdir",
        root,
        "--entry-naming",
        "[name].js",
        "--target=node",
        "--external=ws",
        "--external=@cjhyy/code-shell-core/internal",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [buildOut, buildError, buildCode] = await Promise.all([
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
      compiler.exited,
    ]);
    expect(buildCode, `${buildOut}\n${buildError}`).toBe(0);
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const child = Bun.spawn(["node", "--input-type=module", "--eval", fixture, root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain("PASS native Cloud HTTPS");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
