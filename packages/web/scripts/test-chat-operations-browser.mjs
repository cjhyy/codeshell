/** Production Workbench/controller/protocol against an owned loopback mock Host. */
/* global window, document, requestAnimationFrame */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { WebSocketServer, WebSocket } = require("ws");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-web-chat-operations-"));
const source = `
import React from 'react';import{createRoot}from'react-dom/client';
import{Workbench}from'./Workbench';import{useHubController}from'./useHubController';
const root=createRoot(document.getElementById('root'));
function Fixture(){const controller=useHubController({hub:true});window.controller=controller;return <Workbench controller={controller}/>}
root.render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const scripts = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const styles = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((f) => f.text)
  .join("\n");
const sessions = ["first", "second"].map((sessionId, index) => ({
  cwd: "/owned",
  sessionId,
  title: `Owned ${sessionId}`,
  startedAt: index + 1,
  lastActiveAt: index + 1,
  model: "owned-model",
  status: "completed",
  turnCount: 1,
  running: false,
  archivedAt: null,
  customTitle: "",
}));
const configuration = {
  workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
  defaults: {},
  connections: [],
  catalog: [],
  skills: [],
  mcpServers: [],
  restartRequired: false,
};
const calls = [],
  blocked = [],
  errors = [],
  reports = [];
const heldDetails = [],
  heldRuns = [],
  heldCancels = [],
  heldDecisions = [],
  heldJournals = [],
  heldUploads = [];
let holdDetail = false,
  runFailure = false,
  holdCancel = false,
  holdDecision = false,
  dropNextRun = false,
  holdJournal = false,
  holdAdmission = false,
  holdUpload = false;
let uploaded = 0;
const transcripts = new Map(
  sessions.map((s) => [
    s.sessionId,
    [{ message: { role: "assistant", content: `Saved ${s.sessionId}` } }],
  ]),
);
const approvals = [];
function reply(socket, id, result, error) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
}
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://owned.invalid");
  const json = (data, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  };
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
        styles +
        '</style><div id="root"></div><script>' +
        scripts +
        "</script>",
    );
  }
  if (url.pathname === "/api/v1/environment") return json({}, 404);
  if (url.pathname === "/api/v1/configuration") return json(configuration);
  if (url.pathname === "/api/v1/sessions") return json({ sessions, nextCursor: null });
  if (url.pathname.startsWith("/api/v1/uploads/") && request.method === "PUT") {
    request.resume();
    if (holdUpload) return heldUploads.push((message, status) => json({ error: message }, status));
    return json({
      id: "owned-upload-" + ++uploaded,
      name: decodeURIComponent(request.headers["x-file-name"]),
      size: 5,
      mimeType: "text/plain",
      path: "/owned/upload.txt",
    });
  }
  blocked.push(request.method + " " + request.url);
  json({ error: "Unhandled owned request" }, 404);
});
const sockets = new WebSocketServer({ server, path: "/ws" });
const notify = (method, params) => {
  if (method === "serve/sessionStatus") {
    const session = sessions.find((s) => s.sessionId === params.sessionId);
    if (session) session.running = params.running;
  }
  for (const socket of sockets.clients)
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
};
function detail(socket, request) {
  reply(socket, request.id, {
    type: "session_detail",
    data: {
      state: {},
      transcript: transcripts.get(request.params.sessionId) ?? [],
      running: sessions.find((s) => s.sessionId === request.params.sessionId)?.running ?? false,
    },
  });
}
sockets.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const request = JSON.parse(String(raw));
    calls.push(request);
    const { id, method, params } = request;
    if (method === "agent/query" && params.type === "sessions")
      return reply(socket, id, { type: "sessions", data: sessions });
    if (method === "agent/query" && params.type === "session_detail") {
      if (holdDetail) return heldDetails.push({ socket, request });
      return detail(socket, request);
    }
    if (method === "agent/query" && params.type === "output_journal" && holdJournal)
      return heldJournals.push({ socket, request });
    if (method === "agent/query" && params.type === "output_journal")
      return reply(socket, id, undefined, {
        code: -32602,
        message: "Unknown query type: output_journal",
      });
    if (method === "serve/approval.snapshot") return reply(socket, id, { approvals, leases: [] });
    if (method === "agent/run") {
      if (runFailure)
        return reply(socket, id, undefined, { code: -32000, message: "Owned run rejected" });
      if (dropNextRun) {
        dropNextRun = false;
        return socket.terminate();
      }
      heldRuns.push({ socket, request });
      if (holdAdmission) return;
      notify("agent/runAccepted", { sessionId: params.sessionId });
      notify("serve/sessionStatus", { sessionId: params.sessionId, running: true });
      return;
    }
    if (method === "agent/cancel") {
      if (holdCancel) return heldCancels.push({ socket, request });
      return reply(socket, id, {});
    }
    if (method === "agent/approve") {
      if (holdDecision) return heldDecisions.push({ socket, request });
      return reply(socket, id, {});
    }
    blocked.push("WS " + method + " " + JSON.stringify(params));
    reply(socket, id, undefined, { code: -32601, message: "Unhandled owned method" });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
let context;
const until = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "owned Host response did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
try {
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  await context.routeWebSocket("**/*", (route) => {
    if (route.url() === origin.replace("http:", "ws:") + "/ws") return void route.connectToServer();
    blocked.push(route.url());
    route.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/?session=first");
  await page.getByText("Saved first", { exact: true }).waitFor();
  const input = page.getByRole("textbox", { name: "任务内容", exact: true });
  const send = page.getByRole("button", { name: "发送", exact: true });
  const rejectAway = async (held, message, marker) => {
    await page.getByRole("button", { name: /Owned first/ }).click();
    await page.getByText("Saved first", { exact: true }).waitFor();
    reply(held.socket, held.request.id, undefined, { code: -32000, message });
    // This later frame proves the browser processed the preceding rejection.
    notify("agent/streamEvent", { sessionId: "first", event: { type: "stream_request_start" } });
    notify("agent/streamEvent", {
      sessionId: "first",
      event: { type: "text_delta", text: marker },
    });
    notify("agent/streamEvent", { sessionId: "first", event: { type: "assistant_message" } });
    notify("agent/streamEvent", { sessionId: "first", event: { type: "turn_complete" } });
    await page.getByText(marker, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("alert").count(),
      0,
      "late operation errors must not enter another session",
    );
    await page.getByRole("button", { name: /Owned second/ }).click();
    await page.getByRole("alert").filter({ hasText: message }).waitFor();
  };
  holdDetail = true;
  await page.getByRole("button", { name: /Owned second/ }).click();
  await until(() => heldDetails.length === 1);
  await input.fill("Draft during restore");
  assert.equal(
    await send.isDisabled(),
    true,
    "must not send into a session while its running state and transcript are unknown",
  );
  assert.equal(
    await page.evaluate(() => window.controller.send()),
    false,
    "controller must independently gate sends while restoring",
  );
  holdDetail = false;
  const held = heldDetails.shift();
  detail(held.socket, held.request);
  await page.getByText("Saved second", { exact: true }).waitFor();
  assert.equal(await send.isEnabled(), true);
  assert.equal(await input.inputValue(), "Draft during restore");
  reports.push({ operation: "restore-gates-send-and-preserves-draft" });

  // A definitely rejected Run restores the exact draft and uploaded attachment.
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "owned.txt", mimeType: "text/plain", buffer: Buffer.from("owned") });
  await page.getByRole("button", { name: "移除 owned.txt", exact: true }).waitFor();
  runFailure = true;
  await send.click();
  await page.getByRole("alert").filter({ hasText: "内容和附件已恢复" }).waitFor();
  assert.equal(await input.inputValue(), "Draft during restore");
  assert.equal(await page.locator(".msg.user").count(), 0);
  assert.equal(await page.getByRole("button", { name: "移除 owned.txt", exact: true }).count(), 1);
  runFailure = false;
  const beforeRun = calls.filter((c) => c.method === "agent/run").length;
  await send.evaluate((button) => {
    button.click();
    button.click();
  });
  await until(() => heldRuns.length === 1);
  assert.equal(calls.filter((c) => c.method === "agent/run").length, beforeRun + 1);
  assert.deepEqual(heldRuns[0].request.params.uploadIds, ["owned-upload-1"]);
  assert.equal(await page.locator(".msg.user").count(), 1);
  reports.push({ operation: "rejected-run-restores-draft-and-attachment-duplicate-send-once" });

  holdCancel = true;
  const stop = page.getByRole("button", { name: "停止", exact: true });
  await stop.evaluate((button) => {
    button.click();
    button.click();
  });
  await until(() => heldCancels.length > 0);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(heldCancels.length, 1, "repeated Stop clicks must keep one cancellation in flight");
  let cancellation = heldCancels.shift();
  await page.getByRole("button", { name: /Owned first/ }).click();
  await page.getByText("Saved first", { exact: true }).waitFor();
  reply(cancellation.socket, cancellation.request.id, undefined, {
    code: -32000,
    message: "Owned cancellation rejected for second",
  });
  notify("agent/streamEvent", { sessionId: "first", event: { type: "stream_request_start" } });
  notify("agent/streamEvent", {
    sessionId: "first",
    event: { type: "text_delta", text: "Owned after cancellation marker" },
  });
  notify("agent/streamEvent", { sessionId: "first", event: { type: "assistant_message" } });
  await page.getByText("Owned after cancellation marker", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "late cancellation errors must not enter another session",
  );
  await page.getByRole("button", { name: /Owned second/ }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Owned cancellation rejected for second" })
    .waitFor();
  await stop.click();
  await until(() => heldCancels.length === 1);
  cancellation = heldCancels.shift();
  reply(cancellation.socket, cancellation.request.id, {});
  const run = heldRuns.shift();
  reply(run.socket, run.request.id, {});
  notify("serve/sessionStatus", { sessionId: "second", running: false });
  notify("agent/streamEvent", { sessionId: "second", event: { type: "turn_complete" } });
  await send.waitFor();
  holdCancel = false;
  reports.push({ operation: "duplicate-cancel-once" });
  reports.push({ operation: "late-cancellation-failure-scoped-and-origin-retry" });

  // Decision failure retains the question and answer for an explicit retry.
  const approval = {
    requestId: "owned-question",
    sessionId: "second",
    request: { toolName: "__ask_user__", args: {}, description: "Owned question" },
  };
  approvals.push(approval);
  notify("agent/approvalRequest", approval);
  const answer = page.getByPlaceholder("输入回答…", { exact: true });
  await answer.fill("Owned answer");
  holdDecision = true;
  const answerButton = page.getByRole("button", { name: "回答", exact: true });
  await answerButton.evaluate((button) => {
    button.click();
    button.click();
  });
  await until(() => heldDecisions.length > 0);
  assert.equal(heldDecisions.length, 1);
  let decision = heldDecisions.shift();
  reply(decision.socket, decision.request.id, undefined, {
    code: -32000,
    message: "Owned first decision rejected",
  });
  await page.getByRole("alert").filter({ hasText: "Owned first decision rejected" }).waitFor();
  assert.equal(await answer.inputValue(), "Owned answer");
  await answerButton.click();
  await until(() => heldDecisions.length === 1);
  decision = heldDecisions.shift();
  await rejectAway(decision, "Owned decision rejected", "Owned after decision marker");
  assert.equal(
    await answer.inputValue(),
    "Owned answer",
    "an approval answer draft must survive a session switch during submission",
  );
  await answerButton.click();
  await until(() => heldDecisions.length === 1);
  decision = heldDecisions.shift();
  assert.equal(decision.request.params.decision.answer, "Owned answer");
  approvals.length = 0;
  reply(decision.socket, decision.request.id, {});
  await answer.waitFor({ state: "detached" });
  reports.push({ operation: "approval-failure-preserves-answer-retry-and-duplicate-once" });
  reports.push({ operation: "late-approval-failure-scoped-and-origin-retry" });

  const choices = {
    requestId: "owned-closed-choice",
    sessionId: "second",
    request: {
      toolName: "__ask_user__",
      args: {
        options: [
          { label: "允许本次", description: "只允许这个请求" },
          { label: "拒绝", description: "保留现有权限" },
        ],
        optionsOnly: true,
      },
      description: "Owned closed choice",
    },
  };
  approvals.push(choices);
  notify("agent/approvalRequest", choices);
  await page.getByText("Owned closed choice", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "自定义回答", exact: true }).count(),
    0,
    "closed choices must not offer a free-text answer",
  );
  await page.getByRole("button", { name: "允许本次 只允许这个请求", exact: true }).click();
  await until(() => heldDecisions.length === 1);
  decision = heldDecisions.shift();
  assert.equal(decision.request.params.decision.answer, "允许本次");
  approvals.length = 0;
  reply(decision.socket, decision.request.id, {});
  await page.getByText("Owned closed choice", { exact: true }).waitFor({ state: "detached" });
  reports.push({ operation: "closed-choice-options-only-shows-description-and-sends-exact-label" });

  await page.setViewportSize({ width: 320, height: 360 });
  const multiple = {
    requestId: "owned-multiple-choice",
    sessionId: "second",
    request: {
      toolName: "__ask_user__",
      args: { options: ["选项甲", "选项乙", "OwnedLongOption".repeat(40)], multiSelect: true },
      description: "Owned multiple choice",
    },
  };
  approvals.push(multiple);
  notify("agent/approvalRequest", multiple);
  await page.getByText("Owned multiple choice", { exact: true }).waitFor();
  const submitChoices = page.getByRole("button", { name: "回答", exact: true });
  assert.equal(await submitChoices.isDisabled(), true);
  const firstChoice = page.getByRole("checkbox", { name: "选项甲", exact: true });
  await firstChoice.focus();
  await page.keyboard.press("Space");
  await page.getByRole("checkbox", { name: "选项乙", exact: true }).check();
  await page.getByRole("textbox", { name: "自定义回答", exact: true }).fill("Owned extra");
  assert.equal(
    await page.locator(".approval").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
    "long choices must wrap at phone width",
  );
  await page.screenshot({ path: path.join(output, "mobile-multiple-choice-320x360.png") });
  await submitChoices.click();
  await until(() => heldDecisions.length === 1);
  decision = heldDecisions.shift();
  assert.equal(decision.request.params.decision.answer, "选项甲, 选项乙, Other: Owned extra");
  reply(decision.socket, decision.request.id, undefined, {
    code: -32000,
    message: "Owned multiple choice rejected",
  });
  await page.getByRole("alert").filter({ hasText: "Owned multiple choice rejected" }).waitFor();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: /Owned first/ }).click();
  await page.getByText("Saved first", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: "选项甲", exact: true }).count(),
    0,
    "another session must not expose the pending question's controls",
  );
  await page.getByRole("button", { name: /Owned second/ }).click();
  await page.getByText("Owned multiple choice", { exact: true }).waitFor();
  assert.equal(await firstChoice.isChecked(), true);
  assert.equal(
    await page.getByRole("textbox", { name: "自定义回答", exact: true }).inputValue(),
    "Owned extra",
  );
  await submitChoices.click();
  await until(() => heldDecisions.length === 1);
  decision = heldDecisions.shift();
  assert.equal(decision.request.params.decision.answer, "选项甲, 选项乙, Other: Owned extra");
  approvals.length = 0;
  reply(decision.socket, decision.request.id, {});
  await page.getByText("Owned multiple choice", { exact: true }).waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 720 });
  reports.push({
    operation: "mobile-multiple-choices-keyboard-custom-answer-failure-retry-preserves-selections",
  });
  reports.push({
    operation: "approval-draft-and-multiple-selections-stay-scoped-across-session-switch",
  });

  const optional = {
    requestId: "owned-optional-question",
    sessionId: "second",
    request: {
      toolName: "__ask_user__",
      args: { asynchronous: true },
      description: "Owned optional question",
    },
  };
  approvals.push(optional);
  notify("agent/approvalRequest", optional);
  await page.getByText("Owned optional question", { exact: true }).waitFor();
  await input.fill("Continue while optional question is unanswered");
  assert.equal(
    await page.getByRole("button", { name: "停止", exact: true }).count(),
    0,
    "an optional asynchronous question must not block the conversation as a running task",
  );
  assert.equal(await send.isEnabled(), true);
  await send.click();
  await until(() => heldRuns.length === 1);
  assert.equal(heldRuns[0].request.params.task, "Continue while optional question is unanswered");
  const optionalRun = heldRuns.shift();
  reply(optionalRun.socket, optionalRun.request.id, {});
  notify("serve/sessionStatus", { sessionId: "second", running: false });
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await until(() => heldDecisions.length === 1);
  decision = heldDecisions.shift();
  assert.equal(decision.request.params.decision.approved, false);
  approvals.length = 0;
  reply(decision.socket, decision.request.id, {});
  await page.getByText("Owned optional question", { exact: true }).waitFor({ state: "detached" });
  reports.push({ operation: "optional-async-question-allows-new-message-before-answer" });

  holdAdmission = true;
  await input.fill("Owned pending admission");
  await send.click();
  await until(() => heldRuns.length === 1);
  const rejectedRun = heldRuns.shift();
  await rejectAway(rejectedRun, "Owned admission rejected", "Owned after admission marker");
  assert.equal(await input.inputValue(), "Owned pending admission");
  await page.getByRole("alert").filter({ hasText: "内容和附件已恢复" }).waitFor();
  holdAdmission = false;
  reports.push({ operation: "late-run-rejection-scoped-and-original-draft-restored" });

  holdUpload = true;
  await page.locator('input[type="file"]').setInputFiles({
    name: "owned-late.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("owned"),
  });
  await until(() => heldUploads.length === 1);
  await page.getByRole("button", { name: /Owned first/ }).click();
  await page.getByText("Saved first", { exact: true }).waitFor();
  heldUploads.shift()("Owned upload rejected", 500);
  await page.waitForFunction(() => !window.controller.uploadBusy);
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "late upload errors must not enter another session",
  );
  await page.getByRole("button", { name: /Owned second/ }).click();
  await page.getByRole("alert").filter({ hasText: "Owned upload rejected" }).waitFor();
  assert.equal(await input.inputValue(), "Owned pending admission");
  holdUpload = false;
  reports.push({ operation: "late-upload-failure-scoped-and-origin-draft-kept" });

  // Lost acknowledgement checks durable history and restores an unaccepted draft.
  const runsBeforeDisconnect = calls.filter((c) => c.method === "agent/run").length;
  await input.fill("Owned reconnect draft");
  dropNextRun = true;
  await send.click();
  await page.getByRole("alert").filter({ hasText: "内容和附件已恢复" }).waitFor();
  await page.waitForFunction(
    () =>
      window.controller.connection === "open" &&
      !window.controller.loading &&
      !window.controller.uncertain,
  );
  assert.equal(await input.inputValue(), "Owned reconnect draft");
  assert.equal(
    calls.filter((c) => c.method === "agent/run").length,
    runsBeforeDisconnect + 1,
    "reconnect must not repeat a Run",
  );
  assert.equal(await send.isEnabled(), true);
  reports.push({ operation: "disconnect-uncertain-run-checks-history-no-repeat" });

  // Session drafts stay scoped; late replies cannot replace another session.
  await page.getByRole("button", { name: /Owned first/ }).click();
  await page.getByText("Saved first", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "");
  await input.fill("Owned first draft");
  await page.getByRole("button", { name: /Owned second/ }).click();
  await page.getByText("Saved second", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "Owned reconnect draft");
  holdDetail = true;
  await page.getByRole("button", { name: /Owned first/ }).click();
  await until(() => heldDetails.length === 1);
  await page.getByRole("button", { name: /Owned second/ }).click();
  await until(() => heldDetails.length === 2);
  const late = heldDetails.shift();
  const current = heldDetails.shift();
  detail(current.socket, current.request);
  await page.getByText("Saved second", { exact: true }).waitFor();
  detail(late.socket, late.request);
  assert.equal(await page.getByText("Saved first", { exact: true }).count(), 0);
  holdDetail = false;
  reports.push({ operation: "session-switch-restores-scoped-drafts-and-ignores-late-snapshot" });

  // Compatibility probing takes a round trip while real stream output keeps arriving.
  holdJournal = true;
  await page.getByRole("button", { name: /Owned first/ }).click();
  await until(() => heldJournals.length === 1);
  notify("agent/streamEvent", { sessionId: "first", event: { type: "stream_request_start" } });
  notify("agent/streamEvent", {
    sessionId: "first",
    event: { type: "text_delta", text: "Owned live output during recovery" },
  });
  notify("agent/streamEvent", { sessionId: "first", event: { type: "assistant_message" } });
  await page.getByText("Owned live output during recovery", { exact: true }).waitFor();
  const journal = heldJournals.shift();
  reply(journal.socket, journal.request.id, undefined, {
    code: -32602,
    message: "Unknown query type: output_journal",
  });
  await page.waitForFunction(() => !window.controller.loading);
  assert.equal(
    await page.getByText("Owned live output during recovery", { exact: true }).count(),
    1,
    "compatibility recovery must retain stream events received during its asynchronous journal probe",
  );
  holdJournal = false;
  reports.push({ operation: "live-stream-during-legacy-journal-probe-preserved" });
  await page.getByRole("button", { name: /Owned second/ }).click();
  await page.getByText("Saved second", { exact: true }).waitFor();

  await input.fill("");
  await page.reload();
  await page.getByText("Saved second", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), "second");
  assert.equal(calls.filter((c) => c.method === "agent/run").length, runsBeforeDisconnect + 1);
  reports.push({ operation: "reload-restores-selected-transcript-no-run" });

  await page.setViewportSize({ width: 320, height: 360 });
  await input.fill("Owned mobile line");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "Owned mobile line\n");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "展开侧栏", exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  assert.equal(
    await page.locator(".shell").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  await page.screenshot({ path: path.join(output, "mobile-320x360.png") });
  reports.push({ operation: "mobile-multiline-keyboard-sidebar-return" });
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ output, reports, calls: calls.length, errors, blocked }));
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, calls, blocked, errors }, null, 2),
  );
  await context?.close();
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
