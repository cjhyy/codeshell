/**
 * Desktop-parity composer and question-card input against an owned loopback
 * mock Host: IME Enter guard, pasted and dropped attachments, Enter answers a
 * question, and phone-width inputs stay at 16px so iOS does not zoom.
 * Set CODESHELL_PARITY_SCREENSHOT_DIR to also capture desktop/phone screenshots.
 */
/* global window, document, DataTransfer, File, ClipboardEvent, DragEvent, KeyboardEvent, getComputedStyle */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { WebSocketServer, WebSocket } = require("ws");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-web-composer-parity-"));
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{Workbench}from'./Workbench';import{useHubController}from'./useHubController';
function Fixture(){const controller=useHubController({hub:true});return <Workbench controller={controller}/>}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: path.join(repo, "packages/web/app"),
    loader: "tsx",
  },
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
  .map((file) => file.text)
  .join("\n");

const session = {
  cwd: "/owned",
  sessionId: "first",
  title: "Owned first",
  startedAt: 1,
  lastActiveAt: 1,
  model: "owned-model",
  status: "completed",
  turnCount: 1,
  running: false,
  archivedAt: null,
  customTitle: "",
};
const reply = [
  "Saved first",
  "",
  "| 文件 | 状态 |",
  "| --- | --- |",
  "| `app.css` | 已修改 |",
  "",
  "```ts",
  "export const ready = true;",
  "```",
].join("\n");
const approvals = [
  {
    requestId: "owned-question",
    sessionId: "first",
    request: { toolName: "__ask_user__", args: {}, description: "Owned question" },
  },
];
const calls = [];
const blocked = [];
const errors = [];
let uploaded = 0;
const send = (socket, id, result, error) => {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
};
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://owned.invalid");
  const json = (data, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  };
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(
      `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${styles}</style><div id="root"></div><script>${scripts}</script></html>`,
    );
  }
  if (url.pathname === "/api/v1/environment") return json({}, 404);
  if (url.pathname === "/api/v1/configuration")
    return json({
      workspace: { path: "/owned", settingsScope: "local", skillDirectories: [] },
      defaults: {},
      connections: [],
      catalog: [],
      skills: [],
      mcpServers: [],
      restartRequired: false,
    });
  if (url.pathname === "/api/v1/sessions") return json({ sessions: [session], nextCursor: null });
  if (url.pathname.startsWith("/api/v1/uploads/") && request.method === "PUT") {
    request.resume();
    return json({
      id: `owned-upload-${++uploaded}`,
      name: decodeURIComponent(request.headers["x-file-name"]),
      size: 5,
      mimeType: "text/plain",
      path: "/owned/upload.txt",
    });
  }
  blocked.push(`${request.method} ${request.url}`);
  json({ error: "Unhandled owned request" }, 404);
});
const sockets = new WebSocketServer({ server, path: "/ws" });
sockets.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const request = JSON.parse(String(raw));
    calls.push(request);
    const { id, method, params } = request;
    if (method === "agent/query" && params.type === "sessions")
      return send(socket, id, { type: "sessions", data: [session] });
    if (method === "agent/query" && params.type === "session_detail")
      return send(socket, id, {
        type: "session_detail",
        data: {
          state: {},
          transcript: [{ message: { role: "assistant", content: reply } }],
          running: false,
        },
      });
    if (method === "agent/query" && params.type === "output_journal")
      return send(socket, id, undefined, {
        code: -32602,
        message: "Unknown query type: output_journal",
      });
    if (method === "serve/approval.snapshot") return send(socket, id, { approvals, leases: [] });
    if (method === "agent/approve") {
      approvals.length = 0;
      return send(socket, id, {});
    }
    if (method === "agent/run") return; // held: the test only checks admission
    blocked.push(`WS ${method}`);
    send(socket, id, undefined, { code: -32601, message: "Unhandled owned method" });
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
const until = async (predicate, message) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const shots = process.env.CODESHELL_PARITY_SCREENSHOT_DIR;
const reports = [];
try {
  if (shots) await mkdir(shots, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?session=first`);
  await page.getByText("Saved first", { exact: true }).waitFor();
  if (shots) await page.screenshot({ path: path.join(shots, "desktop-1280.png") });

  // Question card: Shift+Enter keeps typing, Enter answers.
  for (const client of sockets.clients)
    if (client.readyState === WebSocket.OPEN)
      client.send(
        JSON.stringify({ jsonrpc: "2.0", method: "agent/approvalRequest", params: approvals[0] }),
      );
  const answer = page.getByRole("textbox", { name: "自定义回答", exact: true });
  await answer.fill("Owned answer");
  await answer.press("Shift+Enter");
  assert.equal(calls.filter((call) => call.method === "agent/approve").length, 0);
  await answer.press("Enter");
  await until(
    () => calls.some((call) => call.method === "agent/approve"),
    "Enter must answer the question",
  );
  const decision = calls.find((call) => call.method === "agent/approve").params.decision;
  assert.equal(decision.approved, true);
  assert.match(decision.answer, /^Owned answer/);
  await page.getByText("Owned question", { exact: true }).waitFor({ state: "detached" });
  reports.push("enter-answers-question");

  const input = page.getByRole("textbox", { name: "任务内容", exact: true });
  // Pasted files become attachments; pasted text stays text.
  await input.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(["owned"], "pasted.txt", { type: "text/plain" }));
    node.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.getByRole("button", { name: "移除 pasted.txt", exact: true }).waitFor();
  reports.push("paste-file-attaches");

  // Dropped files become attachments, with a visible drop target meanwhile.
  const composer = page.locator("footer.composer");
  const dragging = () => composer.evaluate((node) => node.classList.contains("composer-dragging"));
  await composer.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(["owned"], "dropped.txt", { type: "text/plain" }));
    window.__ownedDrop = data;
    node.dispatchEvent(
      new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  assert.equal(await dragging(), true);
  await composer.evaluate((node) =>
    node.dispatchEvent(
      new DragEvent("drop", { dataTransfer: window.__ownedDrop, bubbles: true, cancelable: true }),
    ),
  );
  await page.getByRole("button", { name: "移除 dropped.txt", exact: true }).waitFor();
  assert.equal(await dragging(), false);
  reports.push("drop-file-attaches");

  // An IME confirmation (Safari: keyCode 229, isComposing false) must not send.
  await input.fill("中文输入");
  await input.evaluate((node) => {
    const init = { key: "Enter", keyCode: 229, bubbles: true, cancelable: true };
    node.dispatchEvent(new KeyboardEvent("keydown", init));
  });
  await page.waitForTimeout(100);
  assert.equal(calls.filter((call) => call.method === "agent/run").length, 0);
  assert.equal(await input.inputValue(), "中文输入");
  await input.press("Enter");
  await until(
    () => calls.some((call) => call.method === "agent/run"),
    "a plain Enter must still send",
  );
  const run = calls.find((call) => call.method === "agent/run").params;
  assert.equal(run.uploadIds.length, 2);
  reports.push("ime-enter-guard-and-send-with-attachments");

  // Phone width: no focused field may be under 16px (iOS auto-zoom).
  await page.setViewportSize({ width: 390, height: 844 });
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")]
      .filter((node) => !["checkbox", "radio", "file", "hidden"].includes(node.type))
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => [node.getAttribute("aria-label") || node.name, getComputedStyle(node)])
      .map(([name, style]) => [name, style.fontSize])
      .filter(([, size]) => parseFloat(size) < 16),
  );
  assert.deepEqual(small, [], "phone inputs must be at least 16px");
  if (shots) await page.screenshot({ path: path.join(shots, "phone-390.png") });
  reports.push("phone-inputs-16px");

  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ ok: true, reports }));
} finally {
  await browser.close();
  sockets.close();
  server.close();
}
