/** Fresh-build first: bun run build:server. No operator state or remote model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";
import { candidateHash, candidateFile } from "./docker-candidate-guard.mjs";
import { createTestStockWebSocketPackage } from "../tests/fixtures/docker-candidate-stock-ws-package.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stock = createTestStockWebSocketPackage(join(repo, "packages/server/package.json"));
const env = createBunTestEnvironment(process.env, stock.root);
const home = env.HOME;
const workspace = join(home, "workspace");
mkdirSync(workspace, { mode: 0o700 });
const preload = join(repo, "scripts/fixtures/connection-recovery-preload.mjs");
const entry = join(repo, "scripts/fixtures/connection-recovery-native.mjs");
const node = realpathSync(process.execPath);
const worker = join(repo, "packages/core/dist/cli/agent-server-stdio.js");
const policy = {
  version: 1,
  role: "controller",
  home,
  dataRoot: home,
  preload,
  preloadHash: candidateFile(preload).sha256,
  guardHash: candidateFile(join(repo, "scripts/docker-candidate-guard.mjs")).sha256,
  receipt: join(home, "guard.jsonl"),
  origins: [],
  listeners: [{ host: "127.0.0.1", port: 0 }],
  children: [],
  stockWebSocket: stock.pin,
  workerPolicy: join(home, "worker-policy.json"),
  worker: {
    node,
    nodeHash: candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256,
    entry: worker,
    entryHash: candidateFile(worker).sha256,
    cwd: workspace,
  },
  repo,
};
const policyPath = join(home, "controller-policy.json");
writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
Object.assign(env, {
  NODE_OPTIONS: `--import=${preload}`,
  CODESHELL_DOCKER_CANDIDATE_CONFIG: policyPath,
  CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: candidateHash(readFileSync(policyPath)),
  DISABLE_AUTOUPDATER: "1",
});
let child,
  capturedClose = false;
try {
  child = spawn(node, [entry], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout = (stdout + bytes).slice(-256 * 1024);
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-256 * 1024);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 90_000);
  const [code, signal] = await once(child, "close").finally(() => clearTimeout(timer));
  capturedClose = true;
  writeFileSync(join(home, "controller.stdout.log"), stdout, { mode: 0o600 });
  writeFileSync(join(home, "controller.stderr.log"), stderr, { mode: 0o600 });
  assert.equal(timedOut, false, `connection recovery deadline; evidence retained: ${home}`);
  assert.equal(code, 0, `connection recovery failed; evidence: ${home}; ${stderr}`);
  assert.equal(signal, null);
  const receipt = JSON.parse(readFileSync(join(home, "result.json")));
  assert.equal(receipt.passed, true);
  assert.equal(receipt.cleanup.children, 0);
  assert.equal(receipt.cleanup.sockets, 0);
  assert.equal(receipt.cleanup.listeners, 0);
  console.log(
    JSON.stringify({ ...receipt, custody: home, controllerPid: child.pid, code, signal }),
  );
  // Evidence is retained intentionally, including source transforms and guards.
} finally {
  if (child && !capturedClose) {
    child.kill("SIGTERM");
    await once(child, "close");
  }
  // Failed or interrupted child custody must not be erased by the launcher.
}
