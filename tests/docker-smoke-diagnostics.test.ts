import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  summarizeContainerLogs,
  summarizeFailure,
  summarizeRpc,
  waitForRunApproval,
} from "../scripts/smoke-project-diagnostics.mjs";

const sessionId = "smoke-project-main";
const approval = () => ({ method: "agent/approvalRequest", params: { sessionId } });
const pending = () => new Promise(() => {});
const secret = "root-cookie-and-full-model-prompt-never-print";

test("actual Run rejection wins before the approval deadline without revealing its raw message", async () => {
  const start = Date.now();
  const run = Promise.reject(
    new Error(JSON.stringify({ code: -32001, message: `Session unavailable: ${secret}` })),
  );
  let failure;
  let summary;
  try {
    await waitForRunApproval([], run, sessionId, 5000);
  } catch (error) {
    failure = String(error);
    summary = summarizeFailure(error);
  }
  expect(Date.now() - start).toBeLessThan(1000);
  expect(failure).toContain("Project A agent/run rejected before Write approval");
  expect(failure).toContain('"code":-32001');
  expect(failure).toContain('"session"');
  expect(failure).not.toContain(secret);
  expect(summary.stage).toBe("main-run-rejected-before-approval");
  expect(summary.code).toBe(-32001);
  expect(JSON.stringify(summary)).not.toContain(secret);
});

for (const error of [null, undefined])
  test(`non-Error ${error} Run rejection also fails immediately`, async () => {
    await expect(waitForRunApproval([], Promise.reject(error), sessionId, 5000)).rejects.toThrow(
      "Project A agent/run rejected before Write approval",
    );
  });

test("a completed Run without approval is an explicit failure and never prints the result text", async () => {
  await expect(
    waitForRunApproval(
      [],
      Promise.resolve({ reason: "completed", turnCount: 0, text: secret }),
      sessionId,
    ),
  ).rejects.toThrow('settled before Write approval: {"reason":"completed","turnCount":0}');
});

test("early model failure keeps its exact public terminal reason without dumping the model output", async () => {
  await expect(
    waitForRunApproval([], Promise.resolve({ reason: "model_error", text: secret }), sessionId),
  ).rejects.toThrow('settled before Write approval: {"reason":"model_error"}');
});

test("only this session's real approval resolves, and later Run rejection is handled", async () => {
  const messages = [{ method: "agent/approvalRequest", params: { sessionId: "other-session" } }];
  let rejectRun;
  const run = new Promise((_resolve, reject) => (rejectRun = reject));
  const wait = waitForRunApproval(messages, run, sessionId, 5000);
  const expected = approval();
  messages.push(expected);
  expect(await wait).toBe(expected);
  rejectRun(new Error(secret));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("an already observed approval wins when the Run has settled after that approval", async () => {
  const expected = approval();
  expect(
    await waitForRunApproval([expected], Promise.resolve({ reason: "completed" }), sessionId),
  ).toBe(expected);
});

test("absence of both approval and Run outcome still fails at the bounded deadline", async () => {
  const start = Date.now();
  await expect(waitForRunApproval([], pending(), sessionId, 25)).rejects.toThrow(
    "Timed out: real main-agent Write approval",
  );
  expect(Date.now() - start).toBeLessThan(1000);
});

test("named A/B summaries distinguish worker exit and RPC rejection without arbitrary fields", () => {
  const a = summarizeRpc("A", {
    pending: new Map(),
    messages: [
      { method: "serve/workerExit", params: { clean: false, gaveUp: true, token: secret } },
      { error: { code: -32000, message: secret }, result: { text: secret } },
      {
        method: "agent/streamEvent",
        params: { event: { type: "error", error: `model ${secret}` } },
      },
    ],
  });
  const b = summarizeRpc("B", {
    pending: new Map(),
    messages: [{ method: "serve/approvalSnapshot", params: { approvals: [] } }],
  });
  expect(a.project).toBe("A");
  expect(a.latest[0].gaveUp).toBe(true);
  expect(a.latest[1].error.code).toBe(-32000);
  expect(a.latest[2].streamError.categories).toEqual(["model"]);
  expect(b.project).toBe("B");
  expect(b.latest[0].approvals).toBe(0);
  expect(JSON.stringify({ a, b })).not.toContain(secret);
});

test("container/model logs emit bounded structural progress while excluding prompts and credentials", () => {
  const request = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [
      { role: "user", content: secret },
      { role: "tool", content: secret },
    ],
    tools: [{ function: { name: "Read", description: secret } }, { function: { name: "Write" } }],
    credentials: secret,
  });
  const result = summarizeContainerLogs(
    `ERR_MODULE_NOT_FOUND ${secret}\n`.repeat(10_000),
    JSON.stringify({
      "model-errors.log": `settings credentials ${secret}`,
      "model-output.log": `Cookie: ${secret}`,
      "model-requests.jsonl": `${request}\n${request}\nmalformed-${secret}\n`,
    }),
  );
  expect(result.container.categories).toContain("module");
  expect(result.container.errorCodes).toContain("ERR_MODULE_NOT_FOUND");
  expect(result.modelRequests.parsed).toBe(2);
  expect(result.modelRequests.invalid).toBe(1);
  expect(result.modelRequests.latest[0]).toEqual({
    model: "gpt-4o-mini",
    messages: 2,
    toolResults: 1,
    tools: 2,
    readAvailable: true,
    writeAvailable: true,
  });
  expect(result.fixtureErrors.categories).toContain("settings");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result).length).toBeLessThan(4096);
});

test("malformed extraction and arbitrary error values remain safe diagnostics", () => {
  const result = summarizeContainerLogs(secret, secret);
  expect(result.fixtureErrors.available).toBe(false);
  expect(result.modelRequests.parsed).toBe(0);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(summarizeFailure(new Error(secret)))).not.toContain(secret);
});

test("the actual smoke names all clients, uses the Run race and preserves strict cleanup/failure wiring", () => {
  const source = readFileSync(
    new URL("../scripts/smoke-project-sandboxes.mjs", import.meta.url),
    "utf8",
  );
  expect(source).toContain('connect(a.id, "A")');
  expect(source).toContain('connect(b.id, "B")');
  expect(source).toContain('connect(a.id, "A-restarted")');
  expect(source).toContain('waitForRunApproval(rpcA.messages, main, "smoke-project-main")');
  expect(source).not.toContain("void main.catch");
  expect(source).not.toContain("lastRpc");
  expect(source).toContain('assert.equal((await main).reason, "completed")');
  expect(source).toContain("summarizeContainerLogs(containerLog, diagnostics)");
  expect(source).toContain("process.exitCode = 1");
  expect(
    source.includes("console.error(`Docker sandbox smoke failed: ${error.stack ?? error}`)"),
  ).toBe(false);
  expect(source).toContain("JSON.stringify(summarizeFailure(error))");
  expect(source.indexOf("await stopControl().catch")).toBeLessThan(
    source.indexOf("await cleanupDocker().catch"),
  );
});
