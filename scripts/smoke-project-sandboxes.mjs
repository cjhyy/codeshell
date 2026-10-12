/**
 * Real Docker project integration check, driven by native Node and the built CLI.
 * Build the server and codeshell-project-runtime:local image before running:
 *   node scripts/smoke-project-sandboxes.mjs [image] [--download-panel /absolute/package/path]
 * CODESHELL_SMOKE_ROOT may point to a separate freshly built checkout.
 * Models run on loopback inside the containers with synthetic credentials. No
 * user model settings are loaded. Cleanup only touches this installation's labels.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeContainerLogs,
  summarizeFailure,
  summarizeRpc,
  summarizeSmokeProgress,
  waitForRunApproval,
} from "./smoke-project-diagnostics.mjs";
import { nextProjectFixtureResponse } from "./smoke-project-model-fixture.mjs";
import { createDockerCandidateFixture } from "./docker-candidate-setup.mjs";
import { createDockerBrowserGuard } from "./docker-candidate-browser-guard.mjs";
import { downloadFixtureServerSource } from "./smoke-cloud-download.mjs";

const root = resolve(
  process.env.CODESHELL_SMOKE_ROOT ?? dirname(fileURLToPath(import.meta.url)) + "/..",
);
// Release verification can exercise a real npm installation instead of a workspace.
const installation = process.env.CODESHELL_SMOKE_INSTALLATION;
const serverRoot = installation
  ? join(resolve(installation), "node_modules/@cjhyy/code-shell-server")
  : join(root, "packages/server");
const entry = join(serverRoot, "dist/bin/code-shell-serve.js");
const containerCore = installation
  ? "/opt/codeshell/node_modules/@cjhyy/code-shell-core/dist/index.js"
  : "/opt/codeshell/packages/core/dist/index.js";
const image = process.argv[2] ?? "codeshell-project-runtime:local";
const seccompIndex = process.argv.indexOf("--runtime-seccomp-profile");
const seccompProfile = seccompIndex < 0 ? undefined : process.argv[seccompIndex + 1];
if (seccompIndex >= 0 && (!seccompProfile || !existsSync(seccompProfile)))
  throw new Error("Pass an existing administrator seccomp profile");
const candidatePanelsIndex = process.argv.indexOf("--candidate-panels");
const candidatePanels =
  candidatePanelsIndex >= 0 ? process.argv[candidatePanelsIndex + 1] : undefined;
if (candidatePanelsIndex >= 0 && !candidatePanels)
  throw new Error("Pass the staged candidate Panel root");
// Focus an individual business UI while retaining real package lifecycle checks.
// Release candidates omit this option and always run all business checks.
const businessIndex = process.argv.indexOf("--candidate-business");
const candidateBusiness = businessIndex < 0 ? "all" : process.argv[businessIndex + 1];
if (
  !["all", "packages", "job-hunt", "design", "video", "quant"].includes(candidateBusiness) ||
  (businessIndex >= 0 && !candidatePanels)
)
  throw new Error(
    "--candidate-business requires staged Panels and all, packages, job-hunt, design, video or quant",
  );
const speechIndex = process.argv.indexOf("--speech-bundle");
const speechBundle = speechIndex < 0 ? undefined : process.argv[speechIndex + 1];
if (speechIndex >= 0 && (!speechBundle || !candidatePanels))
  throw new Error("--speech-bundle requires a bundle path and staged candidate Panels");
const { loadSpeechFixture, installSpeechFixture } =
  await import("./smoke-cloud-speech-fixture.mjs");
const speechFixture = speechBundle ? await loadSpeechFixture(speechBundle) : undefined;
const downloadPanelIndex = process.argv.indexOf("--download-panel");
const downloadPanel = downloadPanelIndex >= 0 ? process.argv[downloadPanelIndex + 1] : undefined;
if (downloadPanelIndex >= 0 && !downloadPanel) throw new Error("Pass the Download package path");
const downloadFixtureIndex = process.argv.indexOf("--download-fixture");
const downloadFixture =
  downloadFixtureIndex < 0 ? undefined : process.argv[downloadFixtureIndex + 1];
if (downloadFixtureIndex >= 0 && (!downloadFixture || (!candidatePanels && !downloadPanel)))
  throw new Error("--download-fixture requires a fixture path and a Download package");
assert.ok(existsSync(entry), "Build the server first: bun run build:server");
assert.ok(/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image), "Invalid image name");
let WebSocket;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-project-smoke-")));
const dataDir = join(scratch, "data");
const isolatedHome = join(scratch, "home");
const label = "io.codeshell.project-runtime.installation";
const password = "synthetic-project-smoke-password-12345";
const proofPath = "/workspace/downloads/shared-proof.txt";
const processProof = "written by panel process\n";
const mainProof = "written by main agent after Read\n";
const taskProof = "written by independent panel task after Read\n";
const nativeProof = "written by reviewed panel tool in project A\n";
const nativeToolSource = `import { writeFileSync } from "node:fs";
let request = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (part) => { request += part; });
process.stdin.on("end", () => {
  const input = JSON.parse(request);
  writeFileSync("/workspace/downloads/native-job-proof.txt", ${JSON.stringify(nativeProof)});
  process.stdout.write(JSON.stringify({ type: "result", result: { project: "A", value: input.value } }) + "\\n");
});`;
const sockets = new Set();
let installationId;
let child;
let serverUrl;
let cookie;
let logs = "";
let success = false;
let primaryFailure;
let failed = false;
const cleanupFailures = [];
let guardedFixture;
let browserGuard;
let smokeStage = "initializing";
const rpcClients = new Map();

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitUntil(check, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${description}`);
}

const docker = (args, options) => {
  if (!guardedFixture) throw new Error("Docker candidate guards are not initialized");
  return guardedFixture.docker(args, options);
};

async function request(path, { method = "GET", body, anonymous = false, origin = serverUrl } = {}) {
  return fetch(serverUrl + path, {
    method,
    headers: {
      origin,
      ...(!anonymous && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
    redirect: "error",
  });
}
async function json(path, options, status = 200) {
  const response = await request(path, options);
  const text = await response.text();
  assert.equal(response.status, status, `${path}: ${text}`);
  assert.equal(
    response.headers.get("set-cookie"),
    null,
    "Private runtime cookies must stay private",
  );
  return JSON.parse(text);
}

class RpcClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Project socket closed"));
      }
      this.pending.clear();
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  text(sessionId) {
    return this.messages
      .filter(
        (m) =>
          m.method === "agent/streamEvent" &&
          m.params.sessionId === sessionId &&
          m.params.event.type === "text_delta",
      )
      .map((m) => m.params.event.text)
      .join("");
  }
}
async function connect(projectId, label) {
  const ws = new WebSocket(`${serverUrl.replace("http:", "ws:")}/p/${projectId}/ws`, {
    headers: { cookie, origin: serverUrl },
    handshakeTimeout: 20_000,
  });
  sockets.add(ws);
  const rpc = new RpcClient(ws);
  await once(ws, "open");
  rpcClients.set(label, rpc);
  return rpc;
}

// Serialized into the container. Its only credential and endpoint are synthetic.
async function fixtureModel(realSpeech, nextProjectFixtureResponse) {
  const { createServer } = await import("node:http");
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const assert = (await import("node:assert/strict")).default;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/v1/audio/transcriptions") {
        assert.equal(req.headers.authorization, "Bearer audio-smoke-only");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const form = await new Request("http://localhost/v1/audio/transcriptions", {
          method: "POST",
          headers: req.headers,
          body: Buffer.concat(chunks),
        }).formData();
        assert.deepEqual([...form.keys()].sort(), ["file", "language", "model", "response_format"]);
        const file = form.get("file");
        const bytes = Buffer.from(await file.arrayBuffer());
        assert.equal(file.type, "audio/webm");
        assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
        assert.equal(form.get("language"), "zh");
        assert.equal(form.get("response_format"), "json");
        assert.ok(
          [realSpeech ? "tiny.en" : "fixture-transcribe", "fixture-transcribe-slow"].includes(
            form.get("model"),
          ),
        );
        const { createHash } = await import("node:crypto");
        appendFileSync(
          "/workspace/audio-requests.jsonl",
          JSON.stringify({
            model: form.get("model"),
            bytes: bytes.length,
            assetId: `asset-${createHash("sha256").update(bytes).digest("hex")}`,
          }) + "\n",
        );
        if (form.get("model") === "fixture-transcribe-slow") return;
        let text = "这是受控服务返回的面试转写，用于验证保存和恢复。";
        if (realSpeech) {
          // Keep the synthetic credential at this validated gateway. Only the
          // recorded bytes and model fields reach the local real provider.
          const response = await fetch("http://127.0.0.1:18792/v1/audio/transcriptions", {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(90000),
          });
          assert.equal(response.status, 200);
          text = (await response.json()).text?.trim();
          assert.match(text.toLowerCase(), /ask not/);
          assert.match(text.toLowerCase(), /country/);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text }));
        return;
      }
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer project-smoke-only");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      appendFileSync("/workspace/model-requests.jsonl", JSON.stringify(body) + "\n");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "project-model-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      const step = nextProjectFixtureResponse(body);
      frame(step.delta);
      frame({}, step.finishReason);
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      appendFileSync("/workspace/model-errors.log", String(error.stack ?? error) + "\n");
      res.destroy(error);
    });
  });
  server.listen(18791, "127.0.0.1", () => writeFileSync("/workspace/model-ready", "ready"));
}

async function installFixture(container) {
  if (speechFixture) await installSpeechFixture(docker, container, speechFixture);
  const modelSource = fixtureModelSource();
  await docker(["exec", "-i", container, "node", "--input-type=module"], {
    input: `
    import { mkdirSync, writeFileSync, openSync } from "node:fs";
    import { spawn } from "node:child_process";
    import { previewLocalPanelApp, installReviewedLocalPanelApp } from ${JSON.stringify(containerCore)};
    const source = "/tmp/project-smoke-panel";
    for (const path of [source + "/.codeshell-panel", source + "/app", source + "/app/tools", "/workspace/.code-shell"])
      mkdirSync(path, { recursive: true });
    writeFileSync(source + "/app/tools/sample.mjs", ${JSON.stringify(nativeToolSource)});
    writeFileSync(source + "/.codeshell-panel/panel.json", JSON.stringify({
      schemaVersion: 2, id: "project-smoke-panel", version: "1.0.0",
      title: { default: "Project smoke panel" }, entry: "app/index.html", icon: "panel",
      singleton: true, placement: "right-dock",
      permissions: ["context.workspace", "context.session", "workspace.info", "workspace.read", "workspace.write", "process", "resources", "agent.task"],
      nativeEntries: { sample: { entry: "app/tools/sample.mjs", sha256: ${JSON.stringify(createHash("sha256").update(nativeToolSource).digest("hex"))} } },
      agent: { tools: [], skills: [] },
    }));
    writeFileSync(source + "/app/index.html", '<!doctype html><html><head><title>Smoke panel</title></head><body>Project smoke panel</body></html>');
    const review = await previewLocalPanelApp({ kind: "dir", path: source });
    await installReviewedLocalPanelApp({ kind: "dir", path: source }, review.reviewToken, new Date().toISOString());
    writeFileSync("/workspace/.code-shell/settings.local.json", JSON.stringify({
      credentials: [
        { id: "fixture-key", catalogId: "openai", apiKey: "project-smoke-only", baseUrl: "http://127.0.0.1:18791/v1" },
        { id: "audio-fixture-key", catalogId: "openai-transcribe", apiKey: "audio-smoke-only", baseUrl: "http://127.0.0.1:18791/v1" },
      ],
      modelConnections: [
        { id: "project-fixture", catalogId: "openai", tag: "text", model: "gpt-4o-mini", credentialId: "fixture-key" },
        { id: "audio-fixture", catalogId: "openai-transcribe", tag: "audio", model: ${JSON.stringify(speechFixture ? "tiny.en" : "fixture-transcribe")}, credentialId: "audio-fixture-key" },
        { id: "audio-fixture-slow", catalogId: "openai-transcribe", tag: "audio", model: "fixture-transcribe-slow", credentialId: "audio-fixture-key" },
      ],
      defaults: { text: "project-fixture" },
      permissions: { defaultMode: "default", rules: [{ tool: "Write", decision: "ask" }] },
      autoUpdates: false,
    }), { mode: 0o600 });
    writeFileSync("/workspace/model-fixture.mjs", ${JSON.stringify(modelSource)});
    const out = openSync("/workspace/model-output.log", "a");
    spawn(process.execPath, ["/workspace/model-fixture.mjs"], { detached: true, stdio: ["ignore", out, out] }).unref();
    console.log("Fixture installed");
  `,
  });
  await waitUntil(
    async () =>
      (await docker([
        "exec",
        container,
        "node",
        "-e",
        'process.stdout.write(String(require("node:fs").existsSync("/workspace/model-ready")))',
      ])) === "true",
    "container model fixture",
  );
}
function fixtureModelSource() {
  return `(${fixtureModel.toString()})(${!!speechFixture},(${nextProjectFixtureResponse.toString()})).catch(error => { console.error(error); process.exit(1); });`;
}

function panelHarness(projectId, grant) {
  const base = `/p/${projectId}/api/v1/panels/runtime/${grant.instanceId}`;
  const events = [];
  const approved = new Set();
  let cursor = 0;
  return {
    base,
    events,
    approved,
    call: (method, params) => json(base + "/call", { method: "POST", body: { method, params } }),
    async poll() {
      const batch = await json(base + `/events?after=${cursor}`);
      for (const event of batch.events) {
        events.push(event);
        if (event.event === "host.confirm") {
          const requestId = event.payload.requestId;
          assert.ok(!approved.has(requestId), "Confirmation must be consumed once");
          approved.add(requestId);
          await json(base + "/confirm", { method: "POST", body: { requestId, allowed: true } });
        }
      }
      cursor = batch.cursor;
    },
    async finish(promise) {
      let settled = false;
      const tracked = promise.finally(() => (settled = true));
      void tracked.catch(() => {});
      await waitUntil(async () => {
        await this.poll();
        return settled;
      }, "approved panel operation");
      return tracked;
    },
  };
}

async function stopControl() {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0, "Exited Control must have confirmed successful shutdown");
    assert.equal(child.signalCode, null);
    return;
  }
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  child.kill("SIGTERM");
  try {
    const [code, signal] = await exited;
    assert.equal(signal, null, "Control must finish cleanup before the shutdown deadline");
    assert.equal(code, 0, "Control must confirm project shutdown without errors");
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupDocker() {
  if (!installationId) return;
  assert.match(installationId, /^[a-f0-9-]{36}$/);
  const failures = [];
  for (const kind of ["container", "network", "volume"]) {
    let ids;
    try {
      ids = (
        await docker([
          kind,
          "ls",
          "-q",
          ...(kind === "container" ? ["-a"] : []),
          "--filter",
          `label=${label}=${installationId}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
    } catch (error) {
      failures.push(error);
      continue;
    }
    for (const id of ids) {
      try {
        const [resource] = JSON.parse(await docker([kind, "inspect", id]));
        assert.equal(
          (resource.Config?.Labels ?? resource.Labels)?.[label],
          installationId,
          "Cleanup requires the exact fresh installation label",
        );
        await docker([kind, "rm", ...(kind === "container" ? ["-f"] : []), id]);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Owned Docker resources did not all confirm cleanup");
}

try {
  const controllerArgs = [
    entry,
    "--auth",
    "hub",
    "--runtime",
    "docker",
    "--runtime-image",
    image,
    ...(seccompProfile ? ["--runtime-seccomp-profile", resolve(seccompProfile)] : []),
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--data-dir",
    dataDir,
  ];
  smokeStage = "create-fixture";
  guardedFixture = await createDockerCandidateFixture({
    scratch,
    home: isolatedHome,
    dataDir,
    root,
    entry,
    controllerArgs,
    image,
    containerCore,
    stockWebSocketAnchor: join(serverRoot, "package.json"),
    seccompPath: seccompProfile ? resolve(seccompProfile) : undefined,
    panelRoot: candidatePanels ?? downloadPanel,
    fixtureHashes: [nativeToolSource, fixtureModelSource(), downloadFixtureServerSource].map(
      (source) => createHash("sha256").update(source).digest("hex"),
    ),
    inlinePrograms: [
      `require("node:fs").writeFileSync("shared-proof.txt", ${JSON.stringify(processProof)}); process.stdout.write("panel process finished")`,
    ],
    speechFixture,
    downloadFixture,
    browserRequired: !!(candidatePanels || downloadPanel),
    videoRequired: !!candidatePanels && ["all", "video"].includes(candidateBusiness),
  });
  WebSocket = guardedFixture.WebSocket;
  smokeStage = "spawn-controller";
  child = guardedFixture.spawnController();
  child.on("error", (error) => (logs += String(error)));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => (logs = (logs + data).slice(-60_000)));
  smokeStage = "wait-controller";
  await waitUntil(
    () => {
      if (child.exitCode !== null)
        throw new Error(`Control CLI exited (${child.exitCode}): ${logs}`);
      serverUrl = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      return serverUrl && /#setup=[A-Za-z0-9_-]+/.test(logs);
    },
    "Docker control CLI startup",
    25_000,
  );
  smokeStage = "verify-browser-authority";
  browserGuard = await createDockerBrowserGuard({
    child,
    origin: serverUrl,
    policyPath: guardedFixture.policyPath,
    policyHash: guardedFixture.policyHash,
  });
  smokeStage = "authorize-controller-origin";
  guardedFixture.allowControllerOrigin(serverUrl);
  smokeStage = "read-installation";
  installationId = JSON.parse(
    readFileSync(join(dataDir, "project-control/registry.json"), "utf8"),
  ).installationId;
  smokeStage = "setup-admin";
  const login = await request("/api/v1/auth/setup", {
    method: "POST",
    anonymous: true,
    body: { token: /#setup=([A-Za-z0-9_-]+)/.exec(logs)[1], username: "smoke-admin", password },
  });
  assert.equal(login.status, 200, await login.text());
  cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("cs_hub_session="));
  smokeStage = "verify-health";
  assert.deepEqual(await json("/health"), {
    status: "ok",
    mode: "project-sandbox",
    runtime: "docker",
  });
  const create = async (name) =>
    (await json("/api/v1/projects", { method: "POST", body: { name } }, 201)).project;
  smokeStage = "create-project-a";
  const a = await create("Sandbox smoke A");
  smokeStage = "create-project-b";
  const b = await create("Sandbox smoke B");
  const start = async (id) =>
    (await json(`/api/v1/projects/${id}/start`, { method: "POST", body: {} })).project;
  smokeStage = "start-project-a";
  const runningA = await start(a.id);
  smokeStage = "start-project-b";
  await start(b.id);
  const containerA = `codeshell-${installationId}-${a.id}`;
  const containerB = `codeshell-${installationId}-${b.id}`;
  if (seccompProfile) {
    smokeStage = "verify-seccomp";
    const configured = JSON.parse(readFileSync(seccompProfile, "utf8"));
    for (const container of [containerA, containerB]) {
      const [inspection] = JSON.parse(await docker(["container", "inspect", container]));
      const security = inspection.HostConfig.SecurityOpt;
      const applied = security.find((value) => value.startsWith("seccomp="));
      assert.ok(applied, "The explicit operator seccomp profile must reach Docker");
      assert.deepEqual(JSON.parse(applied.slice(8)), configured);
      assert.ok(security.includes("no-new-privileges:true"));
      assert.equal(inspection.Config.User, "1000:1000");
      assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspection.HostConfig.Privileged, false);
      assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
      assert.notEqual(inspection.HostConfig.IpcMode, "host");
    }
    console.log(
      "PASS: explicit seccomp bytes applied to both non-root, read-only, capability-dropped project runtimes",
    );
  }
  smokeStage = "install-fixture";
  for (const container of [containerA, containerB]) await installFixture(container);
  console.log(
    "PASS: native control CLI, administrator setup, two real Docker runtimes, isolated loopback models",
  );

  smokeStage = "verify-panel-binding";
  const prefixA = `/p/${a.id}`;
  const snapshot = await json(prefixA + "/api/v1/panels");
  const panel = snapshot.panels.find((item) => item.id === "project-smoke-panel");
  assert.ok(panel?.compatibility.supported);
  const bound = await json(prefixA + `/api/v1/panels/${panel.id}/binding`, {
    method: "PATCH",
    body: { bound: true, expectedRevision: panel.revision },
  });
  const revision = bound.panels.find((item) => item.id === panel.id).revision;
  const grant = await json(prefixA + "/api/v1/panels/runtime/prepare", {
    method: "POST",
    body: { appId: panel.id, revision, sessionId: "smoke-project-main" },
  });
  assert.ok(grant.context.availableMethods.includes("agent.task.start"));
  assert.ok(grant.context.availableMethods.includes("tasks.start"));
  const asset = await request(prefixA + grant.src, { anonymous: true, origin: "null" });
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).includes("Project smoke panel"));
  assert.ok(
    [404, 410].includes(
      (await request(`/p/${b.id}` + grant.src, { anonymous: true, origin: "null" })).status,
    ),
  );
  const host = panelHarness(a.id, grant);
  const executable = await host.call("process.find", { name: "node" });
  assert.equal(executable.available, true);
  const directory = await host.call("filesystem.getKnownDirectory", { name: "downloads" });
  assert.equal(directory.path, "/workspace/downloads");
  smokeStage = "verify-panel-process";
  const processTask = await host.finish(
    host.call("process.spawn", {
      executableHandle: executable.handle,
      directoryHandle: directory.handle,
      args: [
        "-e",
        `require("node:fs").writeFileSync("shared-proof.txt", ${JSON.stringify(processProof)}); process.stdout.write("panel process finished")`,
      ],
    }),
  );
  await waitUntil(async () => {
    await host.poll();
    return host.events.some(
      (event) =>
        event.event === "process.exit" &&
        event.payload.processId === processTask.processId &&
        event.payload.code === 0,
    );
  }, "panel process exit");
  assert.ok(
    host.events.some(
      (event) =>
        event.event === "process.output" && event.payload.text.includes("panel process finished"),
    ),
  );
  const download = () =>
    request(prefixA + "/api/v1/files/content?path=downloads%2Fshared-proof.txt");
  assert.equal(await (await download()).text(), processProof);
  console.log(
    "PASS: opaque panel asset capability and approved panel process write the project volume",
  );

  smokeStage = "verify-native-task";
  const nativeJob = await host.finish(
    host.call("tasks.start", {
      entry: "sample",
      input: { request: { value: "project-volume" } },
      recovery: "manual",
      requestKey: "sandbox-smoke-tool",
    }),
  );
  const completedNativeJob = await waitUntil(async () => {
    await host.poll();
    const job = await host.call("tasks.get", { id: nativeJob.id });
    if (["failed", "cancelled", "interrupted"].includes(job.status))
      throw new Error(`Native panel task failed: ${job.error?.message ?? job.status}`);
    return job.status === "succeeded" ? job : null;
  }, "reviewed native panel task in project container");
  assert.deepEqual(completedNativeJob.result, { project: "A", value: "project-volume" });
  assert.equal(
    await (
      await request(prefixA + "/api/v1/files/content?path=downloads%2Fnative-job-proof.txt")
    ).text(),
    nativeProof,
  );
  assert.ok(
    host.events.some(
      (event) => event.event === "tasks.changed" && event.payload.id === nativeJob.id,
    ),
  );
  console.log("PASS: approved reviewed panel task executes and persists inside project A");

  smokeStage = "connect-project-a";
  const rpcA = await connect(a.id, "A");
  smokeStage = "connect-project-b";
  const rpcB = await connect(b.id, "B");
  smokeStage = "main-agent-approval";
  const main = rpcA.request("agent/run", {
    sessionId: "smoke-project-main",
    task: "SMOKE_MAIN_RW: read and update the shared proof file.",
  });
  const approval = await waitForRunApproval(rpcA.messages, main, "smoke-project-main");
  assert.equal(await (await download()).text(), processProof, "Write must wait for approval");
  await rpcA.request("serve/approval.claim", { requestId: approval.params.requestId });
  await rpcA.request("agent/approve", {
    sessionId: "smoke-project-main",
    requestId: approval.params.requestId,
    decision: { approved: true },
  });
  assert.equal((await main).reason, "completed");
  assert.equal(await (await download()).text(), mainProof);
  assert.ok(rpcA.text("smoke-project-main").includes("Read and Write completed"));
  console.log(
    "PASS: proxied WebSocket runs the real Core Read and approved Write in the same container volume",
  );

  smokeStage = "panel-agent-task";
  const models = await host.call("agent.task.models");
  assert.ok(models.models.some((model) => model.id === "project-fixture"));
  const approvalsBeforeTask = host.approved.size;
  const task = await host.finish(
    host.call("agent.task.start", {
      label: "Smoke shared file",
      prompt: "SMOKE_PANEL_RW: read and update the shared proof file.",
      toolNames: ["Read", "Write"],
      maxTurns: 4,
    }),
  );
  const result = await waitUntil(async () => {
    await host.poll();
    const current = await host.call("agent.task.get", { id: task.id });
    if (current.status === "failed" || current.status === "cancelled")
      throw new Error(JSON.stringify(current));
    return current.status === "completed" ? current : false;
  }, "independent panel Core task");
  assert.ok(
    host.approved.size >= approvalsBeforeTask + 2,
    "Panel Write requires its own trusted tool confirmation",
  );
  assert.ok(result.result.text.includes("Read and Write completed"));
  const downloaded = await download();
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition"), /attachment/);
  assert.equal(await downloaded.text(), taskProof);
  assert.equal(
    await docker([
      "exec",
      containerA,
      "node",
      "-e",
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(proofPath)}, "utf8"))`,
    ]),
    taskProof.trim(),
  );
  console.log(
    "PASS: independently approved panel Core task reads the main Agent's file, writes it, and downloads through HTTP",
  );

  smokeStage = "project-isolation";
  assert.equal(
    (await request(`/p/${b.id}/api/v1/files/content?path=downloads%2Fshared-proof.txt`)).status,
    404,
  );
  assert.equal(
    await docker([
      "exec",
      containerB,
      "node",
      "-e",
      `process.stdout.write(String(require("node:fs").existsSync(${JSON.stringify(proofPath)})))`,
    ]),
    "false",
  );
  const bSessions = await rpcB.request("agent/query", { type: "sessions" });
  assert.ok(!bSessions.data.some((session) => session.sessionId === "smoke-project-main"));
  assert.equal(
    (
      await rpcB.request("agent/run", {
        sessionId: "smoke-project-b",
        task: "SMOKE_B: reply from this separate project.",
      })
    ).reason,
    "completed",
  );
  assert.ok(rpcB.text("smoke-project-b").includes("Isolated project model replied"));
  console.log(
    "PASS: second project has its own real worker and cannot read the first project's file or session",
  );

  let verifyCandidateRestart;
  let verifyJobHuntRestart;
  let verifyDesignRestart;
  let verifyVideoRestart;
  let verifyQuantRestart;
  if (candidatePanels) {
    smokeStage = "panel-lifecycle";
    const { verifyCandidatePanelLifecycle } = await import("./smoke-candidate-panel-lifecycle.mjs");
    verifyCandidateRestart = await verifyCandidatePanelLifecycle({
      browserGuard,
      docker,
      json,
      request,
      containerCore,
      packageRoot: candidatePanels,
      containerA,
      containerB,
      projectA: a.id,
      projectB: b.id,
      panelHarness,
      serverUrl,
      password,
      evidenceDir: join(root, "..", "evidence"),
    });
  }
  if (candidatePanels && ["all", "job-hunt"].includes(candidateBusiness)) {
    smokeStage = "job-hunt";
    const { verifyCloudJobHuntRecovery } = await import("./smoke-cloud-job-hunt-recovery.mjs");
    verifyJobHuntRestart = await verifyCloudJobHuntRecovery({
      browserGuard,
      speechFixture,
      docker,
      request,
      serverUrl,
      password,
      containerA,
      containerB,
      projectA: a.id,
      projectB: b.id,
      scratch,
      evidenceDir: join(root, "..", "evidence"),
    });
  }
  if (candidatePanels && ["all", "design"].includes(candidateBusiness)) {
    smokeStage = "design";
    const { verifyCloudDesignRecovery } = await import("./smoke-cloud-design-recovery.mjs");
    verifyDesignRestart = await verifyCloudDesignRecovery({
      browserGuard,
      docker,
      request,
      serverUrl,
      password,
      containerA,
      containerB,
      projectA: a.id,
      projectB: b.id,
      candidatePanels,
      scratch,
      evidenceDir: join(root, "..", "evidence"),
    });
  }
  if (candidatePanels && ["all", "video"].includes(candidateBusiness)) {
    smokeStage = "video";
    const { verifyCloudVideoRecovery } = await import("./smoke-cloud-video-recovery.mjs");
    verifyVideoRestart = await verifyCloudVideoRecovery({
      browserGuard,
      json,
      request,
      panelHarness,
      serverUrl,
      password,
      projectA: a.id,
      projectB: b.id,
      scratch,
      evidenceDir: join(root, "..", "evidence"),
    });
  }
  if (candidatePanels && ["all", "quant"].includes(candidateBusiness)) {
    smokeStage = "quant";
    const { verifyCloudQuantBacktest } = await import("./smoke-cloud-quant-backtest.mjs");
    verifyQuantRestart = await verifyCloudQuantBacktest({
      browserGuard,
      docker,
      request,
      serverUrl,
      password,
      containerA,
      containerB,
      projectA: a.id,
      projectB: b.id,
      candidatePanels,
      evidenceDir: join(root, "..", "evidence"),
    });
  }
  let verifyDownloadRestart;
  if (downloadPanel || (downloadFixture && candidateBusiness === "all")) {
    smokeStage = "download";
    const { verifyCloudDownload } = await import("./smoke-cloud-download.mjs");
    verifyDownloadRestart = await verifyCloudDownload({
      browserGuard,
      docker,
      json,
      request,
      serverUrl,
      projectId: a.id,
      otherProjectId: b.id,
      container: containerA,
      packagePath: downloadPanel,
      containerCore,
      alreadyInstalled: !!candidatePanels,
      fixturePath: downloadFixture,
      evidenceDir: join(root, "..", "evidence"),
      scratch,
      password,
    });
  }
  smokeStage = "stop-project";
  const [beforeRecovery] = JSON.parse(await docker(["container", "inspect", containerA]));
  assert.equal(beforeRecovery.Config.Labels[label], installationId);
  const workspaceMount = beforeRecovery.Mounts.find((mount) => mount.Destination === "/workspace");
  assert.equal(workspaceMount?.Type, "volume");
  const [workspaceVolume] = JSON.parse(await docker(["volume", "inspect", workspaceMount.Name]));
  assert.equal(workspaceVolume.Labels[label], installationId);
  await guardedFixture.captureRuntime(containerA);
  await json(`/api/v1/projects/${a.id}/stop`, { method: "POST", body: {} });
  await waitUntil(() => rpcA.ws.readyState === WebSocket.CLOSED, "project stop closes its socket");
  assert.equal(
    (await docker(["ps", "-q", "--filter", `volume=${workspaceMount.Name}`])).trim(),
    "",
  );
  // Exercise the delivered administrator command against the actual stopped
  // project's volume, at its original canonical path, then restart that project.
  const recoveryEntry = installation
    ? "/opt/codeshell/node_modules/@cjhyy/code-shell-server/dist/bin/code-shell-settings-recovery.js"
    : "/opt/codeshell/packages/server/dist/bin/code-shell-settings-recovery.js";
  smokeStage = "offline-recovery";
  await docker(guardedFixture.offlineRecoveryArguments(workspaceMount.Name, recoveryEntry), {
    input: `
    import assert from "node:assert/strict";
    import { execFile } from "node:child_process";
    import { promisify } from "node:util";
    import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
    const file = "/workspace/.code-shell/settings.json";
    const original = existsSync(file) ? readFileSync(file) : null;
    const temporary = mkdtempSync("/tmp/settings-recovery-");
    const candidate = temporary + "/reviewed.json";
    const execute = promisify(execFile);
    const call = async (args) => JSON.parse((await execute(process.execPath,
      [${JSON.stringify(recoveryEntry)}, ...args, "--project", "/workspace"],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] })).stdout);
    try {
      const reviewed = { ...(original ? JSON.parse(original.toString("utf8")) : {}),
        recoveryIntegrationProbe: true };
      writeFileSync(candidate, JSON.stringify(reviewed), { mode: 0o600 });
      const inspection = await call(["inspect", "--from", candidate]);
      assert.ok(["valid", "missing"].includes(inspection.status));
      const repaired = await call(["repair", "--from", candidate,
        "--expected-revision", inspection.revision,
        "--candidate-sha256", inspection.candidate.sha256]);
      assert.equal(repaired.status, "valid");
      assert.equal(JSON.parse(readFileSync(file, "utf8")).recoveryIntegrationProbe, true);
      const restored = await call(["restore", "--backup-id", repaired.backupId,
        "--expected-revision", repaired.revision]);
      assert.equal(restored.status, inspection.status);
      if (original === null) assert.equal(existsSync(file), false);
      else assert.equal(readFileSync(file).equals(original), true);
      console.log("PASS: offline recovery repaired and exactly restored the stopped project volume");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      console.log("CANDIDATE_OFFLINE_GUARD " + readFileSync("/tmp/candidate-home/.candidate/guard.jsonl", "utf8"));
    }
  `,
  });
  smokeStage = "restart-project";
  const restarted = await start(a.id);
  assert.equal(restarted.generation, runningA.generation + 1);
  assert.equal(
    await (await download()).text(),
    taskProof,
    "Restart must retain the workspace volume",
  );
  assert.ok(
    [404, 410].includes(
      (await request(prefixA + grant.src, { anonymous: true, origin: "null" })).status,
    ),
  );
  assert.ok(
    [404, 410].includes(
      (await request(host.base + "/call", { method: "POST", body: { method: "context.get" } }))
        .status,
    ),
  );
  const restored = await connect(a.id, "A-restarted");
  const sessions = await restored.request("agent/query", { type: "sessions" });
  assert.ok(sessions.data.some((session) => session.sessionId === "smoke-project-main"));
  assert.equal((await json(`/p/${b.id}/api/v1/files`)).path, "");
  console.log(
    "PASS: stop/restart preserves project files and conversations, changes generation, and rejects old panel grants",
  );
  smokeStage = "restart-verification";
  await verifyDownloadRestart?.();
  await verifyCandidateRestart?.();
  await verifyJobHuntRestart?.();
  await verifyDesignRestart?.();
  await verifyVideoRestart?.();
  await verifyQuantRestart?.();
  smokeStage = "capture-runtime";
  await guardedFixture.captureRuntime(containerA);
  await guardedFixture.captureRuntime(containerB);
  smokeStage = "complete";
  success = true;
} catch (error) {
  failed = true;
  primaryFailure = error;
  console.error(`Docker sandbox smoke failed: ${JSON.stringify(summarizeFailure(error))}`);
  console.log(
    JSON.stringify({
      smokeProgress: summarizeSmokeProgress(smokeStage, child),
      rpcDiagnostics: [...rpcClients].map(([label, rpc]) => summarizeRpc(label, rpc)),
    }),
  );
  process.exitCode = 1;
} finally {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.CLOSED) continue;
    let timer;
    try {
      const closed = once(socket, "close");
      socket.terminate();
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned RPC socket close unknown")), 5000);
        }),
      ]);
    } catch (error) {
      cleanupFailures.push(error);
      success = false;
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  }
  // Recover only this scratch registry's random identity if startup failed early.
  const registryPath = join(dataDir, "project-control/registry.json");
  try {
    if (!installationId && existsSync(registryPath))
      installationId = JSON.parse(readFileSync(registryPath, "utf8")).installationId;
  } catch (error) {
    cleanupFailures.push(error);
    success = false;
    process.exitCode = 1;
  }
  try {
    if (!success && installationId) {
      for (const id of (
        await docker([
          "container",
          "ls",
          "-aq",
          "--filter",
          `label=${label}=${installationId}`,
        ]).catch(() => "")
      )
        .split(/\s+/)
        .filter(Boolean)) {
        const containerLog = await docker(["logs", id]).catch(String);
        writeFileSync(join(scratch, `${id}-container.log`), containerLog);
        const diagnostics = await docker([
          "exec",
          id,
          "node",
          "-e",
          `
        const fs = require("node:fs");
        const result = {};
        for (const name of ["model-errors.log", "model-output.log", "model-requests.jsonl"]) {
          try { result[name] = fs.readFileSync("/workspace/" + name, "utf8").slice(-60000); }
          catch { result[name] = "unavailable"; }
        }
        process.stdout.write(JSON.stringify(result));
      `,
        ]).catch(String);
        writeFileSync(join(scratch, `${id}-fixture.log`), diagnostics);
        console.log(
          JSON.stringify({
            containerId: /^[a-f0-9]{12,64}$/.test(id) ? id : "other",
            containerDiagnostics: summarizeContainerLogs(containerLog, diagnostics),
          }),
        );
        if (speechFixture) {
          const evidenceDir = join(root, "..", "evidence");
          mkdirSync(evidenceDir, { recursive: true });
          writeFileSync(
            join(evidenceDir, `cloud-job-hunt-speech-error-${id}.log`),
            await docker(["exec", id, "cat", "/tmp/codeshell-real-speech/provider.log"]).catch(
              String,
            ),
          );
        }
      }
    }
  } catch (error) {
    cleanupFailures.push(error);
    success = false;
    process.exitCode = 1;
  }
  await stopControl().catch((error) => {
    cleanupFailures.push(error);
    success = false;
    process.exitCode = 1;
    console.error(String(error));
  });
  await cleanupDocker().catch((error) => {
    cleanupFailures.push(error);
    success = false;
    process.exitCode = 1;
    console.error(`Cleanup failed: ${error}`);
  });
  await guardedFixture?.close().catch((error) => {
    cleanupFailures.push(error);
    success = false;
    process.exitCode = 1;
    console.error(`Guard custody cleanup failed: ${error}`);
  });
  if (success) {
    try {
      guardedFixture.writeSuccessReceipt(join(root, "..", "evidence"));
    } catch (error) {
      cleanupFailures.push(error);
      success = false;
      process.exitCode = 1;
    }
  }
  if (success) {
    rmSync(scratch, { recursive: true, force: true });
    console.log(
      "Real Docker sandbox smoke and owned cleanup passed. No external model service or real account key was used.",
    );
  } else {
    if (cleanupFailures.length)
      console.error(
        JSON.stringify(
          summarizeFailure(
            new AggregateError(
              [...(failed ? [primaryFailure] : []), ...cleanupFailures],
              "Docker candidate failed with cleanup/receipt errors",
              failed ? { cause: primaryFailure } : undefined,
            ),
          ),
        ),
      );
    writeFileSync(
      join(scratch, "control.log"),
      logs.replace(/#setup=[A-Za-z0-9_-]+/g, "#setup=[redacted]"),
    );
    console.error(`Smoke logs retained at ${scratch}`);
  }
}
