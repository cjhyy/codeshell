/**
 * Workbench desktop-parity polish against an owned loopback mock Host:
 * sidebar conversation search, per-browser pins that survive a reload, the
 * pending-approval jump bar above the composer, and the manual light / dark /
 * system appearance toggle. Never contacts a live service.
 * Set CODESHELL_POLISH_SCREENSHOT_DIR to also capture screenshots.
 */
/* global document, getComputedStyle, localStorage */
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
const output = await mkdtemp(path.join(tmpdir(), "codeshell-web-workbench-polish-"));
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{Workbench}from'./Workbench';import{useHubController}from'./useHubController';
import{initThemePreference}from'./theme';
initThemePreference();
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

const session = (sessionId, title, lastActiveAt) => ({
  cwd: "/owned",
  sessionId,
  title,
  startedAt: 1,
  lastActiveAt,
  model: "owned-model",
  status: "completed",
  turnCount: 1,
  running: false,
  archivedAt: null,
  customTitle: "",
});
const sessions = [
  session("first", "Owned first", 40),
  session("deploy", "部署检查清单", 30),
  session("weekly", "Weekly report", 20),
  session("study", "整理学习计划", 10),
];
// Enough output that the approval card at the end can be scrolled out of view.
const transcript = Array.from({ length: 24 }, (_, index) => ({
  message: {
    role: "assistant",
    content: `Owned paragraph ${index + 1}\n\n${"内容 ".repeat(60)}`,
  },
}));
const approvals = [
  {
    requestId: "owned-approval",
    sessionId: "first",
    request: { toolName: "Bash", args: { command: "ls" }, description: "Owned command" },
  },
];
const blocked = [];
const errors = [];
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
      `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcfcfd"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151517"><style>${styles}</style><div id="root"></div><script>${scripts}</script></html>`,
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
  if (url.pathname === "/api/v1/sessions") return json({ sessions, nextCursor: null });
  blocked.push(`${request.method} ${request.url}`);
  json({ error: "Unhandled owned request" }, 404);
});
const sockets = new WebSocketServer({ server, path: "/ws" });
sockets.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const { id, method, params } = JSON.parse(String(raw));
    if (method === "agent/query" && params.type === "sessions")
      return send(socket, id, { type: "sessions", data: sessions });
    if (method === "agent/query" && params.type === "session_detail")
      return send(socket, id, {
        type: "session_detail",
        data: { state: {}, transcript, running: false },
      });
    if (method === "agent/query" && params.type === "output_journal")
      return send(socket, id, undefined, {
        code: -32602,
        message: "Unknown query type: output_journal",
      });
    if (method === "serve/approval.snapshot") return send(socket, id, { approvals, leases: [] });
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
const shots = process.env.CODESHELL_POLISH_SCREENSHOT_DIR;
const reports = [];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
try {
  if (shots) await mkdir(shots, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
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
  await page.getByText("Owned paragraph 24", { exact: true }).waitFor();
  // A landmark on wide screens, a modal dialog on phones: address it by id.
  const sidebar = page.locator("#workbench-sidebar");
  const recent = sidebar.getByRole("list", { name: "最近对话", exact: true });
  const rows = () =>
    recent
      .locator(":scope > li .session-title")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent));

  // Search narrows the loaded conversations; Escape restores them.
  const search = sidebar.getByRole("searchbox", { name: "搜索对话", exact: true });
  await search.fill("weekly");
  assert.deepEqual(await rows(), ["Weekly report"]);
  await search.fill("学习");
  assert.deepEqual(await rows(), ["整理学习计划"]);
  await search.fill("no-such-conversation");
  await sidebar.getByText("没有匹配“no-such-conversation”的对话", { exact: true }).waitFor();
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  assert.equal((await rows()).length, 4);
  reports.push("sidebar-search");

  // Pinning lifts a row into 置顶 and survives a reload (per-browser preference).
  const deployRow = recent.locator(":scope > li").filter({ hasText: "部署检查清单" });
  await deployRow.hover();
  await deployRow.getByRole("button", { name: "置顶此对话", exact: true }).click();
  const pinned = sidebar.getByRole("list", { name: "置顶对话", exact: true });
  await pinned.getByText("部署检查清单", { exact: true }).waitFor();
  assert.deepEqual(await rows(), ["Owned first", "Weekly report", "整理学习计划"]);
  await page.reload();
  await page.getByText("Owned paragraph 24", { exact: true }).waitFor();
  await pinned.getByText("部署检查清单", { exact: true }).waitFor();
  assert.equal(
    await pinned
      .getByRole("button", { name: "取消置顶此对话", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  reports.push("sidebar-pin-persists");

  // Pending approval jump bar: hidden while the card is on screen, shown once
  // it scrolls away, and one click brings the card back.
  for (const client of sockets.clients)
    if (client.readyState === WebSocket.OPEN)
      client.send(
        JSON.stringify({ jsonrpc: "2.0", method: "agent/approvalRequest", params: approvals[0] }),
      );
  const card = page.getByText("Owned command", { exact: true });
  await card.waitFor();
  const bar = page.locator(".approval-jump");
  const messages = page.getByRole("region", { name: "消息列表", exact: true });
  await messages.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await page.waitForTimeout(150);
  assert.equal(await bar.count(), 0, "no jump bar while the approval is visible");
  await messages.hover();
  for (let step = 0; step < 20; step++) await page.mouse.wheel(0, -1200);
  await bar.waitFor();
  assert.match(await bar.innerText(), /1 项操作等待你确认/);
  await shot(page, "after-desktop-1280-light");
  await bar.getByRole("button", { name: "查看", exact: true }).click();
  await bar.waitFor({ state: "detached" });
  assert.ok(await card.isVisible());
  reports.push("approval-jump-bar");

  // Appearance: explicit dark persists across reloads; system removes the override.
  const appearance = sidebar.getByRole("group", { name: "外观", exact: true });
  const bodyColor = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bodyColor();
  await appearance.getByRole("button", { name: "深色", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  const dark = await bodyColor();
  assert.notEqual(dark, light);
  assert.equal(
    await page
      .evaluate(() =>
        [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.content),
      )
      .then((values) => values.join()),
    "#151517,#151517",
  );
  await page.reload();
  await page.getByText("Owned paragraph 24", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await bodyColor(), dark);
  await shot(page, "after-desktop-1280-dark");
  await appearance.getByRole("button", { name: "跟随系统", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);
  assert.equal(await page.evaluate(() => localStorage.getItem("codeshell.web.theme")), null);
  assert.equal(await bodyColor(), light);
  reports.push("theme-toggle");

  // Phone: the search field is 16px (no iOS zoom) and the pin control is reachable.
  await appearance.getByRole("button", { name: "深色", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  assert.equal(
    await search.evaluate((node) => getComputedStyle(node).fontSize),
    "16px",
    "phone search must not trigger iOS zoom",
  );
  const pinBox = await pinned
    .getByRole("button", { name: "取消置顶此对话", exact: true })
    .boundingBox();
  assert.ok(pinBox && pinBox.width >= 32 && pinBox.height >= 32, "phone pin target ≥32px");
  await shot(page, "after-phone-390-dark-sidebar");
  reports.push("phone-layout");

  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ ok: true, reports }));
} finally {
  await browser.close();
  sockets.close();
  server.close();
}
