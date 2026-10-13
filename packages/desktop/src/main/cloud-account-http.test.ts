import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = String.raw`
import assert from "node:assert/strict";
import https, { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
const cert = await readFile(join(root, "cert.pem"));
const key = await readFile(join(root, "key.pem"));
const privateValue = "synthetic-upstream-private-value";
const generic = "云服务请求未完成，请检查服务地址和网络。";
const expired = "云账号授权已失效，请重新登录。";
const conflict = "账号或关联已存在冲突，请检查当前账号。";
let reply, origin, requests = 0, redirects = 0, hanging = false, lastRequest;
const server = createServer({ cert, key }, async (req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  for await (const _chunk of req) {}
  requests++;
  lastRequest = { method: req.method, url: req.url, token: req.headers.authorization };
  assert.equal(req.headers.origin, origin);
  if (req.url === "/api/v1/account/leak") redirects++;
  if (hanging) return;
  res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
  res.end(reply.raw ?? JSON.stringify(reply.body));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = "https://127.0.0.1:" + server.address().port;
const nativeRequest = https.request;
https.request = (url, ...args) => {
  assert.equal(new URL(url).origin, origin, "Fixture refuses requests outside its exact origin");
  return nativeRequest(url, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("Fixture refuses uncontrolled fetch"); };
const { CloudAccountHttpError, createCloudAccountTransport } = await import(
  pathToFileURL(join(root, "cloud-account-http.js"))
);
const transport = createCloudAccountTransport(cert);
async function rejected(send, status, message) {
  await assert.rejects(send, (error) => {
    assert.ok(error instanceof CloudAccountHttpError);
    assert.ok(error instanceof Error);
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    assert.ok(!String(error).includes(privateValue));
    assert.ok(!JSON.stringify(error).includes(privateValue));
    return true;
  });
}
try {
  const cases = [
    ["profile", 400, "invalid_display_name", "昵称需为 1–64 个字符，不能包含控制字符。"],
    ["profile", 400, "invalid_username", "用户名需为 3–64 位字母、数字、点、下划线或连字符，并以字母或数字开头。"],
    ["profile", 409, "username_unavailable", "此用户名已被使用，请换一个用户名。"],
    ["profile", 404, "account_endpoint_not_found", "此云服务尚未启用账号资料编辑。"],
    ["register", 409, "username_unavailable", "此用户名已被使用，请换一个用户名。"],
    ["login", 401, "invalid_credentials", "用户名或密码错误，请重新输入。"],
    ["register", 403, "registration_disabled", "此云服务暂未开放注册，请登录已有账号。"],
    ["github/poll", 403, "registration_disabled", "此云服务暂未开放注册，请登录已有账号。"],
    ["github/start", 503, "github_disabled", "此云服务尚未配置 GitHub 登录，请使用账号密码。"],
    ["github/poll", 409, "provider_already_linked", "GitHub 关联冲突：当前账号或此 GitHub 已有其他关联。"],
    ["register", 400, "invalid_username", "用户名需为 3–64 位字母、数字、点、下划线或连字符，并以字母或数字开头。"],
    ["login", 400, "invalid_password", "密码需为 12–1024 位字符。"],
    ["github/poll", 401, "github_login_denied", "GitHub 登录未获授权，请重新发起登录。"],
    ["github/poll", 401, "invalid_github_receipt", "GitHub 登录请求已过期，请重新发起登录。"],
    ["github/poll", 502, "github_login_failed", "GitHub 登录未完成，请重新发起登录。"],
    ["github/start", 503, "github_unavailable", "GitHub 登录暂时不可用，请稍后重试。"],
    ["login", 429, "too_many_attempts", "请求过于频繁，请稍后重试。"],
    ["session", 401, "authentication_required", expired],
    ["register", 401, "invalid_credentials", expired],
    ["login", 409, "username_unavailable", conflict],
    ["register", 500, "username_unavailable", generic],
    ["login", 403, "registration_disabled", expired],
    ["github/start", 409, "provider_already_linked", conflict],
    ["register", 409, privateValue, conflict],
    ["login", 401, { message: privateValue }, expired],
    ["unknown", 400, "invalid_username", generic],
    ["links", 503, "link_management_disabled", "此云服务尚未启用连接管理。"],
    ["links", 503, "link_management_view_too_large", "连接管理列表超过服务上限，请联系服务管理员。"],
    ["links/grants/10000000-0000-0000-0000-000000000001", 404, "link_item_not_found", "此连接或授权不可用，请重新加载列表。"],
    ["links", 502, "link_management_unavailable", "连接服务暂时不可用，请稍后重新加载。"],
  ];
  for (const [path, status, code, message] of cases) {
    reply = { status, body: { error: code, message: privateValue, accessToken: privateValue } };
    await rejected(() => transport({
      origin, path: "/api/v1/account/" + path, body: { password: privateValue }
    }), status, message);
  }
  for (const raw of [privateValue, JSON.stringify([{ error: "username_unavailable" }])]) {
    reply = { status: 409, raw };
    await rejected(() => transport({ origin, path: "/api/v1/account/register", body: {} }), 409, conflict);
  }
  reply = {
    status: 307,
    headers: { Location: origin + "/api/v1/account/leak" },
    body: { error: "username_unavailable", message: privateValue },
  };
  await rejected(() => transport({ origin, path: "/api/v1/account/register", body: {} }), 307, generic);
  assert.equal(redirects, 0, "Error mapping must never follow a redirect");
  const beforeTls = requests;
  await rejected(() => createCloudAccountTransport()({
    origin, path: "/api/v1/account/register", body: { password: privateValue }
  }), 0, generic);
  assert.equal(requests, beforeTls, "Untrusted TLS cannot deliver credentials");
  for (const status of [200, 409]) {
    reply = { status, body: { error: "username_unavailable", message: privateValue.repeat(1024) } };
    await rejected(() => transport({ origin, path: "/api/v1/account/register", body: {} }), 0, generic);
  }
  const cancelled = new AbortController();
  const revokePath = "/api/v1/account/links/grants/10000000-0000-0000-0000-000000000001";
  reply = { status: 200, body: { revoked: true } };
  await transport({ origin, path: revokePath, method: "DELETE", token: "fixture-root-token" });
  assert.deepEqual(lastRequest, { method: "DELETE", url: revokePath, token: "Bearer fixture-root-token" });
  const beforeInvalidDelete = requests;
  for (const input of [
    { path: "/api/v1/account/logout" }, { path: revokePath + "?all=true" },
    { path: revokePath, body: { id: "other" } }, { path: "/api/v1/account/links/clients/10000000-0000-0000-0000-000000000001" },
  ]) await assert.rejects(() => transport({ origin, method: "DELETE", ...input }));
  assert.equal(requests, beforeInvalidDelete);
  const profilePath = "/api/v1/account/profile";
  reply = { status: 200, body: { account: { displayName: "Fixture nickname" } } };
  await transport({ origin, path: profilePath, method: "PATCH", token: "fixture-root-token", body: { displayName: "Fixture nickname" } });
  assert.deepEqual(lastRequest, { method: "PATCH", url: profilePath, token: "Bearer fixture-root-token" });
  const beforeInvalidPatch = requests;
  for (const path of ["/api/v1/account/logout", profilePath + "?all=true", profilePath + "/other"]) {
    await assert.rejects(() => transport({ origin, method: "PATCH", path, body: {} }));
  }
  assert.equal(requests, beforeInvalidPatch);
  reply = { status: 200, body: { data: "x".repeat(20_000) } };
  assert.equal((await transport({ origin, path: "/api/v1/account/links", method: "GET" })).data.length, 20_000);
  await rejected(() => transport({ origin, path: "/api/v1/account/links", method: "POST" }), 0, generic);
  reply = { status: 200, body: { data: "x".repeat(1_048_576) } };
  await rejected(() => transport({ origin, path: "/api/v1/account/links", method: "GET" }), 0, generic);
  cancelled.abort(new Error(privateValue));
  await rejected(() => transport({
    origin, path: "/api/v1/account/register", signal: cancelled.signal, body: {}
  }), 0, generic);
  const realTimeout = globalThis.setTimeout;
  hanging = true;
  // Exercise the production deadline in an isolated native process without a 15-second delay.
  globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 15000 ? 25 : ms, ...args);
  try {
    await rejected(() => transport({ origin, path: "/api/v1/account/register", body: {} }), 0, generic);
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  const legacy = new CloudAccountHttpError(401);
  assert.equal(legacy.status, 401);
  assert.equal(legacy.message, expired);
  console.log("PASS native account error messages: fixed mappings, private bodies, bounded HTTPS and safe fallbacks");
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
`;

test("native account HTTPS maps known endpoint errors without exposing upstream details", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-account-http-"));
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
        "packages/desktop/src/main/cloud-account-http.ts",
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
      expect(stdout).toContain("PASS native account error messages");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
