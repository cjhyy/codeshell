/** Actual negative CLI/custody paths; run in a fresh real private HOME. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [configuration, evidence] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configuration, "utf8"));
const home = realpathSync(process.env.HOME);
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(home, ".code-shell"));
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const dockerConfig = join(home, "empty-docker-config");
mkdirSync(dockerConfig, { mode: 0o700 });
const docker = (...args) => {
  const result = spawnSync(
    config.executable,
    ["--host", config.endpoint, "--config", dockerConfig, ...args],
    {
      env: { PATH: "/usr/bin:/bin", HOME: home, DOCKER_CONFIG: dockerConfig },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
// A test-only Host transport forwards to exactly this explicit local Unix
// daemon. It holds create before forwarding to exercise real Docker CLI timeout;
// it cannot route to a provider, account or Internet endpoint.
const nativeRequest = http.request;
const nativeConnect = net.createConnection;
const daemonSocket = config.endpoint.slice("unix://".length);
assert.ok(config.endpoint.startsWith("unix://") && daemonSocket.startsWith("/"));
const daemonAgent = new http.Agent({ keepAlive: false });
// http.request otherwise resolves the patched net.createConnection at request time.
// This private agent retains only the one explicit local daemon transport.
daemonAgent.createConnection = () => nativeConnect({ path: daemonSocket });

const deny = () => {
  throw new Error("Cleanup fixture refused network");
};
globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://example.invalid"),
  () => http.request("http://127.0.0.1:1"),
  () => https.get("https://example.invalid"),
  () => net.connect({ port: 1 }),
])
  assert.throws(probe, /Cleanup fixture refused/);
const { createConstrainedDockerProcessHost } =
  await import("../packages/core/dist/runtime/constrained-process/docker.js");
const results = [];
const previousTmp = process.env.TMPDIR;
async function failedCase(
  name,
  { runtime = config, created, resources, expectUnproven = false, comma = false } = {},
) {
  const directory = join(home, `${name}${comma ? ",csv" : ""}`);
  mkdirSync(directory, { mode: 0o700 });
  process.env.TMPDIR = directory;
  const lifecycle = [];
  const host = createConstrainedDockerProcessHost(runtime, {
    onLifecycle(event) {
      lifecycle.push(event);
      if (event.stage === "created") created?.(event);
    },
  });
  const { scope, issue } = host.createScope({
    signal: new AbortController().signal,
    assertAuthorized() {},
  });
  const scratchBefore = readdirSync(directory);
  let runError, closeError, disposeError;
  try {
    await scope.run(
      issue({ command: ":", timeoutMs: 5000, event: "pre_tool_use", resources: resources?.(host) }),
      "{}",
    );
  } catch (error) {
    runError = String(error);
  }
  try {
    await scope.terminateAndWait();
  } catch (error) {
    closeError = String(error);
  }
  try {
    await host.dispose();
  } catch (error) {
    disposeError = String(error);
  }
  assert.ok(runError, "negative execution must never be accepted");
  if (expectUnproven) {
    assert.match(closeError, /cleanup unproven/);
    assert.match(disposeError, /cleanup unproven/);
  } else {
    assert.equal(closeError, undefined);
    assert.equal(disposeError, undefined);
    assert.deepEqual(readdirSync(directory), []);
  }
  const result = {
    name,
    runError,
    closeError,
    disposeError,
    scratchBefore,
    scratchAfter: readdirSync(directory),
    lifecycle,
  };
  results.push(result);
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}
let proxy, proxyRoot;
const sockets = new Set();
try {
  const rejected = await failedCase("create-rejected-no-container", { comma: true });
  assert.match(rejected.runError, /create failed/);
  assert.deepEqual(rejected.lifecycle, []);
  await failedCase("image-unavailable-before-create", {
    runtime: { ...config, image: `sha256:${"0".repeat(64)}` },
  });
  const input = join(home, "synthetic-resource.txt");
  writeFileSync(input, "fixture", { mode: 0o600 });
  await failedCase("materialization-failure-before-create", {
    resources: (host) =>
      host.capture([
        { path: input, name: "a", assertReadable() {} },
        { path: input, name: "a/b", assertReadable() {} },
      ]),
  });
  let removed;
  const lost = await failedCase("known-container-id-absence-not-cleanup", {
    expectUnproven: true,
    created(event) {
      removed = {
        id: event.containerId,
        remove: docker("container", "rm", event.containerId),
        inspect: docker("container", "inspect", event.containerId),
      };
      assert.equal(removed.remove.code, 0);
      assert.notEqual(removed.inspect.code, 0);
    },
  });
  assert.equal(lost.lifecycle.length, 1);
  results.push({ name: "fixture-owned-container-removal", ...removed });
  const requests = [];
  // Keep the owned Unix socket below macOS sun_path limits regardless of HOME depth.
  proxyRoot = realpathSync(mkdtempSync("/tmp/codeshell-hook-proxy-"));
  const socket = join(proxyRoot, "daemon.sock");

  proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const record = { method: request.method, path: request.url };
    requests.push(record);
    if (request.method === "POST" && request.url.includes("/containers/create")) {
      record.heldWithoutForwarding = true;
      record.name = new URL(request.url, "http://private").searchParams.get("name");
      const value = JSON.parse(body);
      assert.ok(value.Labels["codeshell.process.scope"]);
      assert.ok(value.Labels["codeshell.process.invocation"]);
      return;
    }
    assert.ok(["GET", "HEAD"].includes(request.method));
    const upstream = nativeRequest(
      {
        socketPath: daemonSocket,
        path: request.url,
        method: request.method,
        headers: request.headers,
        agent: daemonAgent,
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("error", (error) => response.destroy(error));
    upstream.end(body);
  });
  proxy.on("connection", (client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
  });
  await new Promise((done, reject) => {
    proxy.once("error", reject);
    proxy.listen(socket, done);
  });
  const uncertain = await failedCase("create-timeout-absence-not-cleanup", {
    runtime: { ...config, endpoint: `unix://${socket}` },
    expectUnproven: true,
  });
  const held = requests.find((row) => row.heldWithoutForwarding);
  assert.ok(held);
  assert.match(uncertain.runError, /custody unavailable/);
  const absence = docker("container", "inspect", held.name);
  assert.notEqual(absence.code, 0);
  assert.match(absence.stderr, /No such container/);
  results.push({ name: "actual-cli-create-held-timeout", requests, absence });
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        success: true,
        node: process.version,
        home,
        beforeCoreImport: true,
        exactNativeTransport: config.endpoint,
        results,
        limitation:
          "Fault proxy controls one owned local Docker API request; no provider/internet transport. Unproven scopes intentionally retain private scratch until this isolated fixture exits.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Constrained Hook cleanup negatives passed: ${evidence}`);
} finally {
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  daemonAgent.destroy();

  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((done) => proxy.close(done));
  if (proxyRoot) rmSync(proxyRoot, { recursive: true, force: true });
}
