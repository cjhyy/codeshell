/** Real Docker project Link flow. Docker Desktop host.docker.internal is required.
 * Usage: node scripts/smoke-docker-link.mjs /absolute/link-server/http.mjs [built-runtime-image]
 * Real TLS to Link uses an ephemeral CA trusted only by a disposable test image.
 * The browser ignores that fixture certificate; GitHub responses are controlled.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { startProjectControlServer } from "../packages/server/dist/project-runtime/control-server.js";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);
assert.ok(process.argv[2], "Pass the independent Link service entry");
const { startLinkServer } = await import(pathToFileURL(resolve(process.argv[2])).href);
const baseImage = process.argv[3] ?? "codeshell-project-runtime:local";
assert.match(baseImage, /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/);
const scratch = await mkdtemp(join(tmpdir(), "codeshell-docker-link-"));
const image = `codeshell-link-fixture:${randomUUID()}`;
const label = "io.codeshell.project-runtime.installation";
const password = "long-private-fixture-password";
const run = async (command, args, options = {}) =>
  (
    await promisify(execFile)(command, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
      ...options,
    })
  ).stdout.trim();
const docker = (args) => run("docker", args);
let link,
  control,
  tls,
  browser,
  installation,
  builtImage = false;
let cookie, issuer, origin, csrf;
let actions = 0;
const errors = [];
const listen = (server) =>
  new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done(server.address().port));
  });
const controlRequest = (path, method = "GET", body) =>
  fetch(origin + path, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
async function controlJson(path, method = "GET", body, status = 200) {
  const res = await controlRequest(path, method, body);
  const text = await res.text();
  assert.equal(res.status, status, `${path}: ${text}`);
  return JSON.parse(text);
}
try {
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=CodeShell disposable Link fixture",
    "-addext",
    "subjectAltName=DNS:host.docker.internal",
    "-keyout",
    join(scratch, "key.pem"),
    "-out",
    join(scratch, "fixture.pem"),
  ]);
  const ca = await readFile(join(scratch, "fixture.pem"));
  tls = httpsServer({ key: await readFile(join(scratch, "key.pem")), cert: ca }, (req, res) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: link.address.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  issuer = `https://host.docker.internal:${await listen(tls)}`;
  link = await startLinkServer({
    port: 0,
    publicOrigin: issuer,
    ownerPassword: password,
    databasePath: join(scratch, "link.sqlite"),
    masterKey: randomBytes(32),
    provider: {
      async begin(state) {
        return {
          url: `https://github.com/login/oauth/authorize?state=${state}`,
          verifier: "fixture",
        };
      },
      async exchange() {
        return {
          account: { id: "1", login: "alice" },
          credential: { access_token: "UPSTREAM-ONLY-IN-LINK" },
        };
      },
      async action(action, input, credential, resources) {
        assert.equal(credential.access_token, "UPSTREAM-ONLY-IN-LINK");
        assert.deepEqual(resources, ["owner/repo"]);
        actions++;
        return action === "get_issue"
          ? { number: input.number, title: "Docker project Link result" }
          : [{ id: 1, full_name: "owner/repo" }];
      },
    },
  });
  // Fixture administrator requests retain TLS validation, but resolve the Desktop-only hostname locally.
  const linkRequest = (path, method = "GET", body, headers = {}) =>
    new Promise((done, fail) => {
      const req = httpsRequest(
        issuer + path,
        {
          ca,
          method,
          headers: { origin: issuer, ...headers },
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [{ address: "127.0.0.1", family: 4 }])
              : callback(null, "127.0.0.1", 4),
        },
        (res) => {
          const parts = [];
          res.on("data", (p) => parts.push(p));
          res.on("end", () => {
            const h = new Headers();
            for (const [key, values] of Object.entries(res.headers))
              for (const value of Array.isArray(values) ? values : [values])
                if (value) h.append(key, value);
            done(new Response(Buffer.concat(parts), { status: res.statusCode, headers: h }));
          });
        },
      );
      req.on("error", fail);
      req.end(body);
    });
  const form = (path, data, session) =>
    linkRequest(path, "POST", new URLSearchParams(data).toString(), {
      "content-type": "application/x-www-form-urlencoded",
      ...(session ? { cookie: session } : {}),
    });
  const login = await form("/login", { password });
  assert.equal(login.status, 303);
  const linkCookie = login.headers.get("set-cookie").split(";")[0];
  const snapshot = async () =>
    (await linkRequest("/api/v1/links", "GET", undefined, { cookie: linkCookie })).json();
  csrf = (await snapshot()).csrf;
  const upstream = await form("/api/v1/links/providers/github/authorize", { csrf }, linkCookie);
  const state = new URL(upstream.headers.get("location")).searchParams.get("state");
  assert.equal(
    (
      await linkRequest(
        `/oauth/upstream/github/callback?code=fixture&state=${state}`,
        "GET",
        undefined,
        { cookie: linkCookie },
      )
    ).status,
    303,
  );
  const probe = httpServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  origin = `http://127.0.0.1:${port}`;
  const clientResponse = await linkRequest(
    "/api/v1/links/clients",
    "POST",
    JSON.stringify({
      name: "Docker project fixture",
      redirectUris: [origin + "/link/callback"],
      confidential: true,
    }),
    { cookie: linkCookie, "x-csrf-token": csrf, "content-type": "application/json" },
  );
  assert.equal(clientResponse.status, 201);
  const client = await clientResponse.json();
  assert.equal(typeof client.clientSecret, "string");
  await writeFile(join(scratch, ".dockerignore"), "**\n!Dockerfile\n!fixture.pem\n");
  await writeFile(
    join(scratch, "Dockerfile"),
    `FROM ${baseImage}\nCOPY fixture.pem /opt/codeshell-fixture-ca.pem\nENV NODE_EXTRA_CA_CERTS=/opt/codeshell-fixture-ca.pem\n`,
  );
  await docker(["build", "-t", image, scratch]);
  builtImage = true;
  control = await startProjectControlServer({
    host: "127.0.0.1",
    port,
    publicOrigin: origin,
    dataDir: join(scratch, "control"),
    runtimeImage: image,
    staticRootDir: resolve("packages/web/dist-app"),
    remoteLink: {
      issuer,
      clientId: client.id,
      clientSecret: client.clientSecret,
      redirectUri: origin + "/link/callback",
    },
  });
  installation = JSON.parse(
    await readFile(join(scratch, "control/project-control/registry.json"), "utf8"),
  ).installationId;
  const setup = await controlRequest("/api/v1/auth/setup", "POST", {
    token: control.bootstrapToken,
    username: "admin",
    password,
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie").split(";")[0];
  const projects = [];
  for (const name of ["Link cloud A", "Link cloud B"]) {
    const { project } = await controlJson("/api/v1/projects", "POST", { name }, 201);
    await controlJson(`/api/v1/projects/${project.id}/start`, "POST", {});
    projects.push(project);
  }
  const [a, b] = projects;
  const prefix = `/p/${a.id}/api/v1/links`;
  const otherPrefix = `/p/${b.id}/api/v1/links`;
  assert.equal((await controlJson(prefix)).capabilities.remoteAuth, true);
  assert.equal((await controlJson(otherPrefix)).connections.length, 0);
  browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP host.docker.internal 127.0.0.1"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  assert.equal(
    (
      await context.request.post(origin + "/api/v1/auth/login", {
        headers: { origin },
        data: { username: "admin", password },
      })
    ).status(),
    200,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  let pendingJob;
  await page.route(/\/authorizations\/remote$/, async (route) => {
    const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
    pendingJob = await response.json();
    await route.fulfill({ response });
  });
  await page.goto(`${origin}/?project=${a.id}&view=links`);
  await page.getByRole("button", { name: "通过 Link 添加账号", exact: true }).click();
  await page.getByRole("button", { name: "前往 Link 授权", exact: true }).click();
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  assert.equal(
    (
      await context.request.post(
        origin + `${otherPrefix}/authorizations/${pendingJob.id}/complete`,
        {
          headers: { origin },
          data: { callbackUrl: origin + "/link/callback?state=wrong&code=unused" },
        },
      )
    ).status(),
    404,
  );
  await page.locator('textarea[name="repositories"]').fill("owner/repo");
  await page.getByRole("button", { name: "允许只读访问", exact: true }).click();
  await page.getByText("已连接 alice，授权已保存到原项目。", { exact: true }).waitFor();
  await page.getByRole("link", { name: "返回原项目", exact: true }).click();
  await page.getByText("GitHub · alice", { exact: true }).waitFor();
  assert.equal(await page.locator(".topbar-project").innerText(), "Link cloud A");
  assert.equal(new URL(page.url()).searchParams.get("project"), a.id);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(scratch, "cloud-link-390.png"), fullPage: true });
  const saved = (await controlJson(prefix)).connections[0];
  assert.equal((await controlJson(otherPrefix)).connections.length, 0);
  const container = `codeshell-${installation}-${a.id}`;
  const untrusted = await docker([
    "exec",
    "--env",
    "NODE_EXTRA_CA_CERTS=",
    container,
    "node",
    "-e",
    `fetch(${JSON.stringify(issuer + "/health")}).then(
      () => console.log("unexpectedly-trusted"), error => console.log(error.cause?.code));`,
  ]);
  assert.ok(
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(untrusted),
    "Without the fixture CA, the runtime must reject the TLS certificate",
  );
  const action = async (target = container) =>
    JSON.parse(
      await docker([
        "exec",
        target,
        "node",
        "--input-type=module",
        "-e",
        `
    import { linkActionTool } from '/opt/codeshell/packages/core/dist/index.js';
    const result = await linkActionTool({provider:'github', action:'get_issue', connectionId:${JSON.stringify(saved.id)},
      params:{owner:'owner',repo:'repo',issue_number:7}}, {cwd:'/workspace',settingsScope:'full'});
    console.log(result);
  `,
      ]),
    );
  assert.deepEqual((await action()).data, { number: 7, title: "Docker project Link result" });
  assert.equal((await action(`codeshell-${installation}-${b.id}`)).kind, "error");
  assert.equal(actions, 1, "Project B must not reach the provider using project A's connection");
  await page.goto(`${origin}/?project=${b.id}&view=links`);
  await page.getByRole("button", { name: "通过 Link 添加账号", exact: true }).waitFor();
  assert.equal(await page.locator(".topbar-project").innerText(), "Link cloud B");
  assert.equal(await page.getByText("GitHub · alice", { exact: true }).count(), 0);
  const raw = await docker(["exec", container, "cat", "/data/home/.code-shell/credentials.json"]);
  assert.ok(!raw.includes("UPSTREAM-ONLY-IN-LINK"));
  assert.ok(!JSON.stringify(await controlJson(prefix)).includes(client.clientSecret));
  await controlJson(`/api/v1/projects/${a.id}/stop`, "POST", {});
  await controlJson(`/api/v1/projects/${a.id}/start`, "POST", {});
  assert.equal((await controlJson(prefix)).connections[0].id, saved.id);
  assert.deepEqual((await action()).data, { number: 7, title: "Docker project Link result" });
  const current = (await controlJson(prefix)).connections[0];
  await controlJson(`${prefix}/connections/${saved.id}`, "DELETE", {
    expectedRevision: current.revision,
  });
  assert.equal((await controlJson(prefix)).connections.length, 0);
  assert.ok((await snapshot()).grants.every((grant) => grant.revoked));
  assert.equal(actions, 2);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      realDockerProjects: 2,
      independentLink: true,
      verifiedRuntimeTLS: true,
      width: 390,
      originalProjectCallback: true,
      wrongProjectRejected: true,
      projectIsolation: true,
      linkAction: true,
      restartPersistence: true,
      disconnectRevoked: true,
      upstream: "controlled fixture",
      evidence: scratch,
    }),
  );
} finally {
  await browser?.close();
  await control?.close();
  if (installation) {
    assert.match(installation, /^[a-f0-9-]{36}$/);
    for (const kind of ["container", "network", "volume"]) {
      const ids = (
        await docker([
          kind,
          "ls",
          "-q",
          ...(kind === "container" ? ["-a"] : []),
          "--filter",
          `label=${label}=${installation}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) {
        const [resource] = JSON.parse(await docker([kind, "inspect", id]));
        assert.equal((resource.Config?.Labels ?? resource.Labels)?.[label], installation);
        await docker([kind, "rm", ...(kind === "container" ? ["-f"] : []), id]);
      }
    }
  }
  if (tls) {
    tls.closeAllConnections();
    await new Promise((done) => tls.close(done));
  }
  await link?.close();
  if (builtImage) await docker(["image", "rm", image]);
  // Keep non-secret browser evidence, remove keys, grants, private runtime configuration and CA context.
  for (const name of [
    "key.pem",
    "fixture.pem",
    "Dockerfile",
    ".dockerignore",
    "link.sqlite",
    "link.sqlite-shm",
    "link.sqlite-wal",
    "control",
  ])
    await rm(join(scratch, name), { recursive: true, force: true });
}
