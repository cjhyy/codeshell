import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  installLocalNetworkGuard,
  confinedWorkerEnvironment,
} from "./runtime-cost-smoke-isolation.mjs";

const root = mkdtempSync(join(tmpdir(), "codeshell-cost-consumers-"));
const children = new Set();
let requests = 0;
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests++;
  res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
  const response = {
    id: "fixture",
    object: body.stream ? "chat.completion.chunk" : "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        ...(body.stream
          ? { delta: { content: "cost consumer ok" } }
          : { message: { role: "assistant", content: "cost consumer ok" } }),
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  res.end(
    body.stream
      ? `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`
      : JSON.stringify(response),
  );
});
await new Promise((resolveListen) => http.listen(0, "127.0.0.1", resolveListen));
const endpoint = `http://127.0.0.1:${http.address().port}/v1`;
// Host settings resolve HOME/.code-shell. CODE_SHELL_HOME is not a settings override.
// The child-only home never changes this process or the user's settings.
const fixtureUserHome = join(root, "isolated-user-home");
const origin = new URL(endpoint).origin;
const isolationModule = new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href;
installLocalNetworkGuard(origin);
const env = {
  ...confinedWorkerEnvironment(process.env, fixtureUserHome, origin, isolationModule),
  CODESHELL_COST_SMOKE_GUARD_LOG: join(root, "guard-receipts.jsonl"),
  CODE_SHELL_CREDENTIAL_ACCESS: "local",
  CODE_SHELL_DATA_ROOT: join(root, "data"),
  AGENT_CWD: root,
  CODE_SHELL_CAPABILITY_MODULES: "",
  CODE_SHELL_DEV: "0",
  CODESHELL_SELF_UPDATE_CHECK: "0",
};
assert.equal(existsSync(fixtureUserHome), false);
mkdirSync(join(fixtureUserHome, ".code-shell"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(fixtureUserHome, ".code-shell", "settings.json"),
  JSON.stringify({
    credentials: [
      { id: "fixture-key", catalogId: "openai", apiKey: "synthetic-local-key", baseUrl: endpoint },
    ],
    modelConnections: [
      {
        id: "fixture",
        catalogId: "openai",
        tag: "text",
        model: "gpt-4o",
        credentialId: "fixture-key",
      },
    ],
    defaults: { text: "fixture" },
    agent: { preset: "general", maxTurns: 1 },
    session: { storageDir: join(root, "tui-sessions") },
  }),
);
async function requireWorkerGuard(child) {
  for (let index = 0; index < 100; index++) {
    const receipts = existsSync(env.CODESHELL_COST_SMOKE_GUARD_LOG)
      ? readFileSync(env.CODESHELL_COST_SMOKE_GUARD_LOG, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const receipt = receipts.find((entry) => entry.pid === child.pid);
    if (receipt) {
      assert.equal(receipt.ppid, process.pid);
      assert.equal(receipt.origin, origin);
      assert.equal(receipt.homeId, createHash("sha256").update(fixtureUserHome).digest("hex"));
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Missing worker guard receipt; cost smoke stopped");
}
function worker() {
  const child = spawn(process.execPath, [resolve("packages/core/dist/cli/agent-server-stdio.js")], {
    env,
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let serial = 0,
    buffer = "",
    errors = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`worker exited ${code}: ${errors.slice(-1500)}`));
    }
  });
  return {
    child,
    async request(method, params) {
      await requireWorkerGuard(child);
      const id = ++serial;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker request timed out: ${method}; ${errors.slice(-1000)}`)),
          20000,
        );
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async close() {
      const exited = once(child, "exit");
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0, errors.slice(-1000));
      children.delete(child);
    },
  };
}
let succeeded = false;
try {
  const core = await import("@cjhyy/code-shell-core");
  const sdk = new core.Engine({
    llm: { provider: "openai", model: "gpt-4o", apiKey: "synthetic-local-key", baseUrl: endpoint },
    cwd: root,
    sessionStorageDir: join(root, "sdk-sessions"),
    settingsScope: "isolated",
    maxTurns: 1,
    isSubAgent: true,
    headless: true,
    behaviorProfiles: [{ id: "cost-smoke", disableSessionTitle: true, disableHooks: true }],
  });
  sdk.getHookRegistry().clear();
  const sdkBefore = requests;
  const sdkResult = await sdk.run("Return one confirmation", {
    sessionId: "cost-sdk",
    clientMessageId: "sdk-one",
    behaviorMode: "cost-smoke",
  });
  assert.ok(["completed", "max_turns"].includes(sdkResult.reason));
  assert.equal(sdk.getUsageSummary().requests, requests - sdkBefore);
  assert.ok(sdk.getUsageSummary().requests >= 1);
  assert.ok(sdk.getUsageSummary().knownEstimatedCostUsd > 0);
  await sdk.dispose();

  let current = worker();
  const result = await current.request("agent/run", {
    sessionId: "cost-worker",
    clientMessageId: "worker-one",
    task: "Return one confirmation",
    cwd: root,
  });
  assert.ok(["completed", "max_turns"].includes(result.reason));
  let summary;
  for (let i = 0; i < 30; i++) {
    summary = (await current.request("agent/query", { type: "usage", sessionId: "cost-worker" }))
      .data;
    if (summary.byPurpose.some((p) => p.purpose === "title") && summary.unknownUsageRequests === 0)
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.ok(summary.requests >= 1);
  assert.equal(summary.unknownCostRequests, 0);
  assert.ok(summary.byModel.every((entry) => entry.model === "gpt-4o"));
  await assert.rejects(
    current.request("agent/query", { type: "usage", scope: "store" }),
    /owned Session/,
  );
  await current.close();
  const beforeRestart = requests;
  current = worker();
  const restored = (
    await current.request("agent/query", { type: "usage", sessionId: "cost-worker" })
  ).data;
  assert.equal(restored.requests, summary.requests);
  const replay = await current.request("agent/run", {
    sessionId: "cost-worker",
    clientMessageId: "worker-one",
    task: "Return one confirmation",
    cwd: root,
  });
  assert.equal(replay.runId, result.runId);
  assert.equal(requests, beforeRestart);
  await current.close();

  const tui = spawn(
    process.execPath,
    [
      resolve("packages/tui/dist/cli/main.js"),
      "run",
      "Return one confirmation",
      "--preset",
      "general",
      "--max-turns",
      "1",
      "--output",
      "json",
      "--no-wait-background-agents",
    ],
    { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(tui);
  await requireWorkerGuard(tui);
  let output = "",
    errors = "";
  tui.stdout.on("data", (chunk) => (output += chunk));
  tui.stderr.on("data", (chunk) => (errors += chunk));
  const [tuiCode] = await once(tui, "exit");
  children.delete(tui);
  const tuiResult = JSON.parse(output);
  assert.ok(["completed", "max_turns"].includes(tuiResult.reason));
  assert.equal(tuiCode, tuiResult.reason === "completed" ? 0 : 1, errors.slice(-2000));
  assert.match(output, /cost consumer ok/);
  const tuiLedger = new core.UsageLedger({
    storageDir: join(root, "tui-sessions", ".usage-ledger"),
  }).summary({ scope: "store" });
  assert.ok(tuiLedger.requests >= 1);
  // CLI may exit while its best-effort title is pending; keep that attempt unknown.
  assert.equal(tuiLedger.unknownCostRequests, tuiLedger.unknownUsageRequests);
  assert.ok(tuiLedger.knownEstimatedCostUsd > 0);
  const ledgerDir = join(root, "data", "sessions", ".usage-ledger");
  const namespace = readdirSync(ledgerDir)[0];
  const raw = readdirSync(join(ledgerDir, namespace))
    .filter((file) => file.endsWith(".json"))
    .map((file) => readFileSync(join(ledgerDir, namespace, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(raw, /synthetic-local-key|Return one confirmation|127\.0\.0\.1/);
  succeeded = true;
  console.log(
    JSON.stringify({
      sdk: "node compiled SDK request accounted",
      desktopWorker: "stdio run/restart/replay accounted",
      tui: "compiled CLI runtime accounted",
      physicalRequests: requests,
      workerReceipts: summary.requests,
      tuiReceipts: tuiLedger.requests,
    }),
  );
} finally {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }),
  );
  await new Promise((resolveClose) => http.close(resolveClose));
  if (succeeded) rmSync(root, { recursive: true, force: true });
  else console.error(`Cost smoke private evidence retained: ${root}`);
}
