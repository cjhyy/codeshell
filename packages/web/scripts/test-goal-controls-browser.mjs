/** Actual browser + production hooks/controller, against an owned protocol fixture. */
/* global window, localStorage */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright"),
  { WebSocketServer } = require("ws");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-goal-browser-"));
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{useRemoteApp}from'../src/hooks/useRemoteApp';import{useDesktopController}from'./DesktopApp';
function Fixture(){const app=useRemoteApp();const controller=useDesktopController(app,undefined,()=>{});
window.fixture={app,controller};return <main>{controller.goalActions}<p data-testid="goal">{app.chat.goal}</p><p role="status">{app.notice}</p></main>}
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
const script = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const calls = [],
  errors = [],
  blocked = [];
let goal = {
    objective: "Browser fixture objective",
    goalId: "browser-goal",
    revision: 7,
    paused: true,
  },
  failClear = true;
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>',
    );
  }
});
const sockets = new WebSocketServer({ server, path: "/ws" });
sockets.on("connection", (socket) =>
  socket.on("message", (data) => {
    const event = JSON.parse(String(data));
    calls.push(event);
    const send = (reply) => socket.send(JSON.stringify(reply));
    if (event.type === "auth.device")
      send({
        type: "auth.ok",
        device: { id: "fixture", name: "Fixture" },
        capabilities: { goalControls: 1 },
      });
    if (event.type === "session.list") send({ type: "session.list.ok", sessions: [], total: 0 });
    if (event.type === "session.select" || event.type === "session.history")
      send({ type: "session.history.ok", sessionId: event.sessionId, events: [] });
    if (event.type === "goal.get")
      send({
        type: "goal.state",
        sessionId: event.sessionId,
        requestId: event.requestId,
        ok: true,
        goal,
      });
    if (event.type === "goal.update") {
      assert.equal(event.expectedGoalId, goal.goalId);
      assert.equal(event.expectedRevision, goal.revision);
      goal = { ...goal, revision: goal.revision + 1, paused: false };
      send({
        type: "goal.updated",
        sessionId: event.sessionId,
        requestId: event.requestId,
        ok: true,
        goal,
      });
      send({
        method: "agent/streamEvent",
        params: { sessionId: event.sessionId, event: { type: "stream_request_start" } },
      });
    }
    if (event.type === "goal.extend")
      send({
        type: "goal.extended",
        sessionId: event.sessionId,
        requestId: event.requestId,
        ok: true,
      });
    if (event.type === "goal.clear") {
      if (failClear) {
        failClear = false;
        send({
          type: "goal.cleared",
          sessionId: event.sessionId,
          requestId: event.requestId,
          ok: false,
          message: "Fixture clear failure",
        });
      } else {
        goal = null;
        send({
          type: "goal.cleared",
          sessionId: event.sessionId,
          requestId: event.requestId,
          ok: true,
          cleared: true,
        });
      }
    }
  }),
);
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
try {
  context = await browser.newContext({ serviceWorkers: "block" });
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
  await context.addInitScript(() => {
    localStorage.setItem("cs.deviceId", "fixture");
    localStorage.setItem("cs.deviceSecret", "fixture");
    localStorage.setItem("cs.deviceName", "Fixture");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.fixture?.app.status === "online");
  await page.evaluate(() => window.fixture.app.selectSession("browser-session"));
  await page.getByTestId("goal").filter({ hasText: "已暂停" }).waitFor();
  await page.getByRole("button", { name: "恢复目标", exact: true }).click();
  await page.getByRole("button", { name: "追加轮次", exact: true }).waitFor();
  await page.getByRole("button", { name: "追加轮次", exact: true }).click();
  await page.waitForFunction(() => !window.fixture.app.goalControlBusy);
  await page.getByRole("button", { name: "结束目标", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Fixture clear failure" }).waitFor();
  await page.getByRole("button", { name: "结束目标", exact: true }).click();
  await page.waitForFunction(
    () => !window.fixture.app.chat.goal && !window.fixture.app.goalControlBusy,
  );
  assert.equal(calls.filter((event) => event.type === "goal.update").length, 1);
  assert.equal(calls.find((event) => event.type === "goal.extend").addTurns, 100);
  assert.equal(
    calls.some((event) => event.type === "chat.send"),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify({
      output,
      checks: [
        "cold-paused-snapshot",
        "versioned-resume",
        "running-extend",
        "clear-error",
        "clear-success",
      ],
      errors,
      blocked,
    }),
  );
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ calls, errors, blocked }, null, 2),
  );
  await context?.close();
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
