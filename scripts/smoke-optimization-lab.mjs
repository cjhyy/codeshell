// Run after Desktop predist; --workspace uses this checkout's compiled packages instead.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--workspace"),
  "Usage: node scripts/smoke-optimization-lab.mjs [--workspace]",
);
const workspace = process.argv.includes("--workspace");
function entry(source, name, file) {
  const directory = workspace
    ? join(root, "packages", source)
    : join(root, "packages/desktop/node_modules/@cjhyy", name);
  assert.ok(
    workspace || !fs.lstatSync(directory).isSymbolicLink(),
    `Run Desktop predist first: ${directory}`,
  );
  const path = join(directory, "dist", file);
  assert.ok(fs.existsSync(path), `Missing compiled entry: ${path}`);
  return path;
}
const workerEntry = entry("core", "code-shell-core", "cli/agent-server-stdio.js");
const modules = [
  ["coding", "code-shell-capability-coding", "index.capability.js", "createCodingModule"],
  ["arena", "code-shell-arena", "index.runtime.js", "createArenaModule"],
  ["pet", "code-shell-pet", "index.capability.js", "createPetModule"],
  [
    "optimization-lab",
    "code-shell-capability-optimization-lab",
    "index.capability.js",
    "createOptimizationLabModule",
  ],
].map(
  ([source, name, file, factory]) => `${pathToFileURL(entry(source, name, file)).href}#${factory}`,
);
const fixture = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "optimization-lab-smoke-")));
const home = join(fixture, "home");
const cwd = join(fixture, "workspace");
const dataHome = join(home, ".code-shell");
const labDirectory = join(dataHome, "optimization-lab");
fs.mkdirSync(home);
fs.mkdirSync(join(cwd, ".code-shell"), { recursive: true });
let modelRequests = 0;
const modelServer = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(500).end("Foundation queries must never request a model");
});
const dataset = {
  schemaVersion: 1,
  title: "Worker smoke fixture",
  taskFamily: "source-citation",
  cases: Array.from({ length: 6 }, (_, index) => ({
    id: `case-${index}`,
    version: 1,
    sourceGroupId: `source-${index}`,
    provenance: "synthetic",
    caseRole: index === 0 ? "regression" : "target_failure",
    split: index < 3 ? "dev" : "holdout",
    input: `Summarize fixture source ${index}`,
    hardAssertions: [{ id: "citation", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
  })),
};

async function withWorker(enabled, inspect) {
  fs.writeFileSync(
    join(cwd, ".code-shell/settings.json"),
    JSON.stringify({
      credentials: [
        {
          id: "fixture-key",
          catalogId: "deepseek",
          apiKey: "fake-smoke-key",
          baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        },
      ],
      modelConnections: [
        {
          id: "fixture-model",
          catalogId: "deepseek",
          tag: "text",
          model: "deepseek-v4-flash",
          credentialId: "fixture-key",
        },
      ],
      defaults: { text: "fixture-model" },
      ...(enabled ? { featureFlags: { optimization_lab: true } } : {}),
    }),
  );
  // An allowlisted environment keeps real settings, credentials and module hooks out.
  const child = spawn(process.execPath, [workerEntry], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      AGENT_CWD: cwd,
      CODE_SHELL_HOME: dataHome,
      CODE_SHELL_DATA_ROOT: dataHome,
      CODESHELL_AGENT_STDIO: "1",
      CODE_SHELL_CAPABILITY_MODULES: modules.slice(0, enabled ? 4 : 3).join(","),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let failure,
    stderr = "",
    sequence = 0,
    stopping = false;
  const pending = new Map();
  const closed = new Promise((done) => child.once("close", done));
  const fail = (error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    child.kill("SIGKILL");
  };
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.once("close", (code, signal) => {
    if (!stopping) fail(new Error(`Worker exited ${code ?? signal}: ${stderr}`));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const frame = JSON.parse(line);
      assert.equal(frame.jsonrpc, "2.0", "Invalid NDJSON protocol frame");
      if (frame.method) {
        assert.equal(frame.id, undefined, `Unexpected worker request: ${frame.method}`);
        return;
      }
      const request = pending.get(frame.id);
      assert.ok(request, `Unexpected worker response id: ${frame.id}`);
      pending.delete(frame.id);
      if (frame.error) request.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      else request.resolve(frame.result);
    } catch (error) {
      fail(error);
    }
  });
  const timeout = setTimeout(() => fail(new Error(`Worker smoke timed out: ${stderr}`)), 15_000);
  const query = async (type, value = dataset) => {
    if (failure) throw failure;
    const result = await new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "agent/query",
          params: { type, cwd, dataset: value },
        }) + "\n",
      );
    });
    assert.equal(result.type, type);
    return result.data;
  };
  try {
    const result = await inspect(query);
    if (failure) throw failure;
    return result;
  } finally {
    clearTimeout(timeout);
    stopping = true;
    child.kill("SIGTERM");
    const killTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await closed;
    clearTimeout(killTimeout);
    lines.close();
  }
}

try {
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  await withWorker(false, async (query) => {
    await assert.rejects(query("optimization_lab_validate_dataset"), /-32602: Unknown query type/);
    await assert.rejects(query("optimization_lab_freeze_dataset"), /-32602: Unknown query type/);
    assert.equal(fs.existsSync(labDirectory), false, "Default-off worker created lab data");
  });
  const frozen = await withWorker(true, async (query) => {
    assert.equal((await query("optimization_lab_validate_dataset")).ok, true);
    assert.equal((await query("optimization_lab_validate_dataset", {})).ok, false);
    assert.equal(fs.existsSync(labDirectory), false, "Validation wrote lab data");
    const result = await query("optimization_lab_freeze_dataset");
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.match(result.manifest.datasetHash, /^[0-9a-f]{64}$/);
    assert.equal(result.manifest.cases.length, 6);
    assert.ok(resolve(result.path).startsWith(labDirectory + sep));
    return {
      ...result,
      bytes: fs.readFileSync(result.path, "utf8"),
      mtime: fs.statSync(result.path).mtimeMs,
    };
  });
  await withWorker(true, async (query) => {
    const again = await query("optimization_lab_freeze_dataset", {
      ...dataset,
      cases: [...dataset.cases].reverse(),
    });
    assert.equal(again.ok, true);
    assert.equal(again.created, false);
    assert.equal(again.path, frozen.path);
    assert.deepEqual(again.manifest, frozen.manifest);
    assert.equal(fs.readFileSync(frozen.path, "utf8"), frozen.bytes);
    assert.equal(fs.statSync(frozen.path).mtimeMs, frozen.mtime, "Restart rewrote the manifest");
  });
  assert.equal(modelRequests, 0, "Foundation issued model requests");
  console.log(
    `Optimization Lab worker smoke passed (${workspace ? "workspace" : "materialized"}; 6 cases; restart preserved hash; 0 model requests)`,
  );
} finally {
  modelServer.closeAllConnections();
  await new Promise((done) => modelServer.close(done));
  fs.rmSync(fixture, { recursive: true, force: true });
}
