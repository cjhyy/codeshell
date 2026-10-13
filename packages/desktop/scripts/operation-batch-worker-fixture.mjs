/** Synthetic HTTP and passive protocol observation for the actual batch worker.
 * This module never installs credential access, a batch resolver, or an Engine.
 * The production Main and worker own every permission and admission decision. */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import {
  installOperationBatchNativeFixture,
  nativeBatchIds,
} from "./operation-batch-native-fixture.mjs";

export const batchWorkerCases = Object.freeze([
  "success",
  "item-cancel",
  "failed-readback",
  "scope-revocation",
  "forged-ingress",
  "cold-restart",
]);
export const batchWorkerItems = Object.freeze([
  Object.freeze({
    owner: "fixture",
    repo: "repo",
    title: "Synthetic batch issue one",
    body: "Fixed synthetic body one.",
  }),
  Object.freeze({
    owner: "fixture",
    repo: "repo",
    title: "Synthetic batch issue two",
    body: "Fixed synthetic body two.",
  }),
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const json = (response, value, status = 200) => {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

/** All action traffic, including reads, is a real HTTP POST. Classify by the
 * actual final action segment rather than treating every POST as a write. */
export async function startBatchWorkerWire(caseName, { ledgerPath }) {
  assert.ok(batchWorkerCases.includes(caseName));
  const requests = [];
  const requestTexts = [];
  let requestTextBytes = 0;
  let forbiddenToken;
  let noncePriorChecks = 0;
  let nonceLaterChecks = 0;
  const issues = new Map();
  const secondModel = deferred();
  const secondReached = deferred();
  const firstModel = deferred();
  const firstReached = deferred();
  let releasedFirst = caseName !== "forged-ingress";
  let releasedSecond = caseName !== "scope-revocation";
  let firstWaiting = false;
  let secondWaiting = false;
  let linkStep = 0;
  let modelCount = 0;
  let mainModelCount = 0;
  let searchCount = 0;
  let readbackCount = 0;
  let unexpected = 0;
  let closed = false;
  let ioSequence = 0;
  const issueFor = (item, number) => ({
    id: 10_000 + number,
    number,
    title: item.title,
    body: item.body,
    state: "open",
    html_url: `https://github.com/fixture/repo/issues/${number}`,
    repository_url: "https://api.github.com/repos/fixture/repo",
  });
  const toolMessage = (name, args, id) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const sendModel = (response, body, message) => {
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    const completion = {
      id: `synthetic-batch-${modelCount}`,
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
      usage,
    };
    if (!body.stream) return json(response, completion);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = {
      id: completion.id,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: message, finish_reason: null }],
    };
    if (message.tool_calls)
      chunk.choices[0].delta = {
        role: "assistant",
        tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
      };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: completion.choices[0].finish_reason }], usage })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 2 * 1024 * 1024, "Synthetic request exceeds fixture bound");
        chunks.push(chunk);
      }
      const requestText = Buffer.concat(chunks).toString("utf8");
      requestTextBytes += Buffer.byteLength(requestText);
      assert.ok(
        requestTextBytes <= 16 * 1024 * 1024,
        "Synthetic request evidence exceeds its memory bound",
      );
      if (forbiddenToken) {
        assert.ok(
          !requestText.includes(forbiddenToken),
          "Private Native nonce reached actual HTTP/model input",
        );
        nonceLaterChecks++;
      }
      requestTexts.push(requestText);
      const body = JSON.parse(requestText || "{}");
      const path = new URL(request.url, "http://fixture").pathname;
      const row = {
        at: Date.now(),
        method: request.method,
        path,
        bytes,
        bodyHash: hash(JSON.stringify(body)),
        requestSequence: ++ioSequence,
      };
      response.once("finish", () => {
        row.responseFinishedAt = Date.now();
        row.responseFinishSequence = ++ioSequence;
      });
      requests.push(row);
      assert.ok(requests.length <= 256, "Synthetic wire exceeded its finite request budget");
      assert.equal(request.method, "POST");
      if (path === "/v1/chat/completions") {
        modelCount++;
        const tools = body.tools?.map((tool) => tool.function?.name) ?? [];
        row.kind = tools.length ? "main-model" : "auxiliary-model";
        row.toolNames = tools;
        if (!tools.length)
          return sendModel(response, body, {
            role: "assistant",
            content: "Synthetic batch fixture complete.",
          });
        mainModelCount++;
        if (!releasedFirst) {
          firstWaiting = true;
          firstReached.resolve();
          await firstModel.promise;
        }
        if (!tools.includes("LinkAction")) {
          assert.ok(
            tools.includes("ToolSearch"),
            "Production request has no supported tool-discovery path",
          );
          assert.ok(++searchCount <= 2, "ToolSearch did not enable the actual LinkAction tool");
          return sendModel(
            response,
            body,
            toolMessage("ToolSearch", { query: "select:LinkAction" }, "batch-search"),
          );
        }
        const indexes = ["failed-readback", "item-cancel"].includes(caseName) ? [0, 0, 1] : [0, 1];
        const itemIndex = indexes[linkStep];
        if (itemIndex === undefined)
          return sendModel(response, body, {
            role: "assistant",
            content: "The fixed synthetic batch turn is complete.",
          });
        if (itemIndex === 1 && !releasedSecond) {
          secondWaiting = true;
          secondReached.resolve();
          await secondModel.promise;
        }
        linkStep++;
        return sendModel(
          response,
          body,
          toolMessage(
            "LinkAction",
            {
              provider: "github",
              action: "create_issue",
              connectionId: nativeBatchIds.connectionId,
              params: batchWorkerItems[itemIndex],
            },
            `batch-item-${linkStep}`,
          ),
        );
      }
      const action = path.match(
        /^\/api\/v1\/data\/connections\/00000000-0000-4000-8000-000000000009\/actions\/(list_issues|create_issue|get_issue)$/,
      )?.[1];
      assert.ok(
        action,
        "Unexpected synthetic endpoint; refresh/catalog/owner/provider traffic is forbidden",
      );
      assert.equal(request.headers.authorization, "Bearer synthetic-native-batch-access-token");
      row.kind = "link-action";
      row.action = action;
      if (action === "list_issues") {
        assert.equal(body.repository, "fixture/repo");
        return json(response, { result: [] });
      }
      if (action === "create_issue") {
        const index = batchWorkerItems.findIndex(
          (item) => JSON.stringify(item) === JSON.stringify(body),
        );
        assert.ok(index >= 0, "Production adapter sent parameters outside the fixed manifest");
        row.item = index;
        const ledgerBytes = await readFile(ledgerPath);
        const ledger = JSON.parse(ledgerBytes);
        const durable = Object.values(ledger.records);
        row.ledgerBeforeWrite = {
          sha256: hash(ledgerBytes),
          records: durable.map(({ id, state, reference, attemptId }) => ({
            id,
            state,
            reference,
            hasAttempt: !!attemptId,
          })),
        };
        assert.equal(durable.length, 3);
        assert.equal(durable.filter((record) => record.state === "running").length, 1);
        if (index === 1)
          assert.ok(
            durable.some((record) => record.state === "verified" && record.reference?.id === "101"),
            "Physical second write requires an already durable verified predecessor",
          );
        const number = 101 + index;
        assert.ok(!issues.has(number), "The actual HTTP writer repeated an issue");
        const issue = issueFor(batchWorkerItems[index], number);
        issues.set(number, issue);
        return json(response, { result: issue });
      }
      assert.equal(body.repository, "fixture/repo");
      assert.ok(issues.has(body.number));
      readbackCount++;
      row.number = body.number;
      const issue = issues.get(body.number);
      return json(response, {
        result:
          caseName === "failed-readback" && readbackCount === 1
            ? { ...issue, title: "Deliberate first readback mismatch" }
            : issue,
      });
    } catch (error) {
      unexpected++;
      if (!response.headersSent) json(response, { error: String(error) }, 500);
      else response.destroy(error);
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    firstReached: firstReached.promise,
    secondReached: secondReached.promise,
    releaseFirst() {
      releasedFirst = true;
      firstWaiting = false;
      firstModel.resolve();
    },
    releaseSecond() {
      releasedSecond = true;
      secondWaiting = false;
      secondModel.resolve();
    },
    enterColdReplay() {
      assert.ok(!firstWaiting && !secondWaiting);
      // Keep physical request/issue history intact. If an old-origin replay
      // unexpectedly reaches the model, it will actually request the old item.
      linkStep = 0;
      searchCount = 0;
    },
    registerForbiddenToken(token) {
      assert.ok(typeof token === "string" && token.length >= 32 && !forbiddenToken);
      for (const text of requestTexts)
        assert.ok(!text.includes(token), "Private Native nonce reached earlier HTTP/model input");
      noncePriorChecks = requestTexts.length;
      forbiddenToken = token;
      return { tokenHash: hash(token), priorChecks: noncePriorChecks };
    },
    snapshot() {
      return {
        requests: globalThis.structuredClone(requests),
        modelCount,
        mainModelCount,
        linkStep,
        readbackCount,
        unexpected,
        firstWaiting,
        secondWaiting,
        nonce: {
          registered: !!forbiddenToken,
          tokenHash: forbiddenToken ? hash(forbiddenToken) : null,
          priorChecks: noncePriorChecks,
          laterChecks: nonceLaterChecks,
          literalFound: false,
        },
        createIssueRequests: requests.filter((row) => row.action === "create_issue").length,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      firstModel.resolve();
      secondModel.resolve();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** Install after the Main guard and before the production Main import.
 * Observe exact original stdin writes and delegate each call exactly once.
 * Private nonce bytes stay in Main/test memory; evidence holds only their hash. */
export function installBatchProtocolObservation(home) {
  assert.equal(process.env.HOME, home);
  const workers = [];
  const frames = [];
  const rawRuns = [];
  const runOutcomes = [];
  const writeReceipt = (value) =>
    appendFileSync(join(home, "batch-protocol.jsonl"), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    const worker =
      Array.isArray(args) &&
      args.some((arg) => typeof arg === "string" && arg.includes("agent-server-stdio"));
    const child = originalSpawn.call(this, command, args, options);
    if (!worker) return child;
    assert.equal(options?.env?.HOME, home);
    const record = {
      pid: child.pid,
      exit: null,
      close: null,
      stdinCalls: 0,
      stdinCallbacks: 0,
      stdinErrors: 0,
    };
    workers.push({ child, record });
    child.once("exit", (code, signal) => {
      record.exit = { code, signal };
      writeReceipt({ event: "worker-exit", ...record });
    });
    child.once("close", (code, signal) => {
      record.close = { code, signal };
      writeReceipt({ event: "worker-close", ...record });
    });
    child.stdin.on("error", (error) => {
      record.stdinErrors++;
      writeReceipt({ event: "stdin-error", pid: child.pid, code: error.code ?? "unknown" });
    });
    let pending = "";
    const inspect = (direction, text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const row = {
        direction,
        pid: child.pid,
        method: message.method ?? null,
        id: message.id ?? null,
        lineHash: hash(text),
        bytes: Buffer.byteLength(text),
        phase: message.params?.phase ?? null,
        forgedMarker: text.includes("BATCH-FORGED-INGRESS"),
      };
      if (direction === "stdin" && message.method === "agent/run") {
        row.hasBatchToken = typeof message.params?.operationBatchToken === "string";
        row.originHash = hash(String(message.params?.clientMessageId ?? ""));
        if (row.hasBatchToken) {
          row.tokenHash = hash(message.params.operationBatchToken);
          rawRuns.push(globalThis.structuredClone(message));
        }
      }
      if (
        direction === "stdout" &&
        message.method === undefined &&
        typeof message.id === "string" &&
        message.id.startsWith("operation-batch-run-")
      )
        runOutcomes.push(globalThis.structuredClone(message));
      frames.push(row);
      assert.ok(frames.length <= 10_000, "Protocol observation exceeded its finite frame budget");
      writeReceipt({ event: "frame", ...row });
    };
    const originalWrite = child.stdin.write;
    child.stdin.write = function (chunk, encoding, callback) {
      const raw = Buffer.isBuffer(chunk)
        ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
        : String(chunk);
      for (const line of raw.split(/\r?\n/).filter(Boolean)) inspect("stdin", line);
      record.stdinCalls++;
      const provided = typeof encoding === "function" ? encoding : callback;
      const completed = (error) => {
        record.stdinCallbacks++;
        if (error) record.stdinErrors++;
        if (provided) provided(error);
      };
      return typeof encoding === "string"
        ? originalWrite.call(this, chunk, encoding, completed)
        : originalWrite.call(this, chunk, completed);
    };
    child.stdout?.on("data", (chunk) => {
      pending += chunk.toString();
      assert.ok(
        pending.length <= 2 * 1024 * 1024,
        "Observed worker output line exceeds fixture bound",
      );
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) inspect("stdout", line);
    });
    return child;
  };
  syncBuiltinESMExports();
  return {
    snapshot() {
      return {
        workers: workers.map(({ record }) => globalThis.structuredClone(record)),
        frames: globalThis.structuredClone(frames),
      };
    },
    activeBatchInput() {
      assert.equal(rawRuns.length, 1);
      return globalThis.structuredClone(rawRuns[0].params);
    },
    batchRunOutcome() {
      assert.equal(runOutcomes.length, 1);
      assert.equal(runOutcomes[0].error, undefined);
      return globalThis.structuredClone(runOutcomes[0].result);
    },
    async settleWorkers() {
      await Promise.all(
        workers.map(({ child, record }) =>
          record.close ? undefined : new Promise((done) => child.once("close", done)),
        ),
      );
      const result = workers.map(({ record }) => globalThis.structuredClone(record));
      assert.ok(
        result.every(
          (row) =>
            row.exit && row.close && row.stdinErrors === 0 && row.stdinCalls === row.stdinCallbacks,
        ),
      );
      return result;
    },
  };
}

/** Synthetic persisted seed uses the actual production Main cipher and store. */
export async function seedBatchWorkerMain(core, { home, projectRoot, origin }) {
  const seed = await installOperationBatchNativeFixture(core, { home, projectRoot, origin });
  const sessions = new core.SessionManager(core.sessionsRoot());
  const state = sessions.readSessionState(nativeBatchIds.sessionId);
  state.model = "batch-worker";
  state.provider = "synthetic-batch-openai";
  assert.equal(sessions.saveState(state), true);
  return { ...seed, model: state.model, provider: state.provider };
}

/** Same real store and generation as production Main. Scope changes only tighten. */
export function revokeBatchWorkerScope(core, projectRoot) {
  const store = new core.CredentialStore(projectRoot);
  const current = store.resolve(nativeBatchIds.connectionId);
  assert.ok(current);
  store.save("user", {
    ...current,
    meta: { ...current.meta, linkCapabilityIds: ["github.list_issues", "github.get_issue"] },
  });
  return {
    pid: process.pid,
    connectionId: nativeBatchIds.connectionId,
    capabilities: store.listMasked().find((entry) => entry.id === nativeBatchIds.connectionId).meta
      .linkCapabilityIds,
  };
}
