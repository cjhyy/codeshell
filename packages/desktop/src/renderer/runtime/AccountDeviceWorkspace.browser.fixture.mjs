/* Production device workspace, isolated bridge, no network or paid provider. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const renderer = path.join(desktop, "src/renderer");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-account-devices-ui-"));
const source = String.raw`
import React from "react";
import {createRoot} from "react-dom/client";
import {AccountDeviceWorkspace} from "./runtime/AccountDeviceWorkspace";
window.calls=[]; window.listeners=[]; let accountListener;
window.devices=["a","b"].map(hostId=>({hostId,environmentId:"env-"+hostId,name:hostId==="a"?"Mac Studio":"Linux Builder",online:true,revoked:false,protocolVersion:1}));
window.connections={};
window.codeshell={
 cloudAccount:{status:async()=>({state:"signed-in",origin:"https://account.fixture.invalid",account:{id:"account-a",username:"fixture"}}),onStatus:callback=>{accountListener=callback;return()=>{}}},
 mobileRemote:{relay:{status:async()=>({state:"ready",registered:true,hostId:"a"}),onStatus:()=>()=>{}}},
 accountDevices:{
 list:async()=>window.devices,
 projects:async({hostId})=>[{id:"project",name:hostId==="a"?"Desktop project":"Builder project",path:"/"+hostId+"/real-project"}],
 connect:async({hostId,projectId})=>{const c={id:"connection-"+hostId,hostId,environmentId:"env-"+hostId,projectId,sessionId:"session-"+hostId};window.connections[hostId]=c;window.calls.push(["connect",hostId,projectId]);return c},
 resume:async({connectionId})=>{window.calls.push(["resume",connectionId]);return {...Object.values(window.connections).find(c=>c.id===connectionId),historyNeedsReview:true}},
 send:async(input)=>{window.calls.push(["send",input]);return {ok:true}},stop:async(input)=>window.calls.push(["stop",input]),approve:async(input)=>window.calls.push(["approve",input]),close:async(input)=>window.calls.push(["close",input]),
 onEvent:callback=>{window.listeners.push(callback);return()=>{}}
 }};
window.emit=(hostId,event,type="event")=>{const c=window.connections[hostId];for(const callback of window.listeners)callback({connectionId:c.id,hostId,environmentId:c.environmentId,projectId:c.projectId,sessionId:c.sessionId,type,event})};
window.output=(hostId,text)=>window.emit(hostId,{type:"session.stream",sessionId:"session-"+hostId,event:{method:"agent/streamEvent",params:{sessionId:"session-"+hostId,event:{type:"text_delta",text}}}});
window.signOut=()=>accountListener({state:"signed-out"});
createRoot(document.getElementById("root")).render(<AccountDeviceWorkspace open onClose={()=>{}}/>);
`;
const result = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});
const cssPath = path.join(renderer, "styles/tailwind.css");
const compiled = await compile(await readFile(cssPath, "utf8"), {
  base: path.dirname(cssPath),
  from: cssPath,
  onDependency() {},
});
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }],
});
const css = compiled.build(scanner.scan());
if (process.argv.includes("--build-only")) {
  const visualBridge = `
window.codeshell.accountDevices.send=async(input)=>{window.calls.push(["send",input]);const hostId=input.connectionId.slice(-1);setTimeout(()=>{window.emit(hostId,{type:"chat.accepted",sessionId:"session-"+hostId});window.output(hostId,"受控 producer 已在 "+hostId+" 项目输出。任务保持原电脑归属。\\n");window.emit(hostId,{method:"agent/approvalRequest",params:{sessionId:"session-"+hostId,requestId:"approval-"+hostId,request:{toolName:"Write",description:"允许在所选电脑的项目写入 fixture 文件？"}}});},40)};
window.codeshell.accountDevices.approve=async(input)=>{window.calls.push(["approve",input]);const hostId=input.connectionId.slice(-1);window.emit(hostId,{type:"approval.resolved",sessionId:"session-"+hostId,approvalId:input.approvalId});window.output(hostId,input.approved?"审批已允许这一次，继续原任务。\\n":"审批已拒绝。\\n")};
window.codeshell.accountDevices.stop=async(input)=>{window.calls.push(["stop",input]);const hostId=input.connectionId.slice(-1);window.output(hostId,"已向原执行电脑 "+hostId+" 发送取消。\\n");window.emit(hostId,{type:"session.stream",sessionId:"session-"+hostId,event:{method:"agent/streamEvent",params:{sessionId:"session-"+hostId,event:{type:"turn_complete",reason:"aborted_streaming"}}}})};
`;
  const html = path.join(output, "devices-visual.html");
  await writeFile(
    html,
    `<html><meta charset="utf-8"><title>CodeShell isolated account devices fixture</title><style>${css}</style><body><div id="root"></div><script>${result.outputFiles[0].text}</script><script>${visualBridge}</script></body></html>`,
  );
  console.log(
    JSON.stringify({
      html,
      boundary:
        "standalone production component with isolated synthetic bridge; no network, account credentials or model",
    }),
  );
  process.exit(0);
}
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const unexpected = [];
  const fixtureOrigin = "https://devices-ui.fixture.invalid/";
  await context.route("**/*", (route) => {
    if (route.request().url() === fixtureOrigin)
      return route.fulfill({
        contentType: "text/html",
        body: `<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
      });
    unexpected.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixtureOrigin);
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByRole("button", { name: /Mac Studio/ }).click();
  await page.getByLabel("执行项目").selectOption("project");
  await page.getByText(/已连接.*Mac Studio/).waitFor();
  await page.getByLabel("电脑任务", { exact: true }).fill("Run the isolated producer on A");
  await page.getByRole("button", { name: "发送到此电脑" }).click();
  await page.evaluate(() => window.output("a", "Producer A output — original executor"));
  await page.getByText("Producer A output — original executor", { exact: true }).waitFor();
  await page.getByLabel("电脑任务", { exact: true }).fill("A draft survives switching");
  await page.getByLabel("添加图片", { exact: true }).setInputFiles({
    name: "a-only.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
  });
  await page.getByRole("button", { name: "a-only.png ×" }).waitFor();
  await page.getByRole("button", { name: /Linux Builder/ }).click();
  await page.getByLabel("执行项目").selectOption("project");
  await page.getByText(/已连接.*Linux Builder/).waitFor();
  assert.equal(await page.getByLabel("电脑任务", { exact: true }).inputValue(), "");
  assert.equal(await page.getByText("a-only.png ×").count(), 0);
  assert.equal(
    await page.getByText("Producer A output — original executor", { exact: true }).count(),
    0,
  );
  await page.getByLabel("电脑任务", { exact: true }).fill("B draft");
  await page.getByRole("button", { name: "停止此电脑任务" }).click();
  await page.evaluate(() => window.output("a", " continued while B selected"));
  await page.getByRole("button", { name: /Mac Studio/ }).click();
  await page.getByLabel("执行项目").selectOption("project");
  assert.equal(
    await page.getByLabel("电脑任务", { exact: true }).inputValue(),
    "A draft survives switching",
  );
  await page.getByRole("button", { name: "a-only.png ×" }).waitFor();
  await page.getByText(/Producer A output.*continued while B selected/).waitFor();
  await page.getByRole("button", { name: "停止此电脑任务" }).click();
  await page.evaluate(() =>
    window.emit("a", {
      method: "agent/approvalRequest",
      params: {
        sessionId: "session-a",
        requestId: "approval-a",
        request: { toolName: "Write", description: "Write in A project" },
      },
    }),
  );
  await page.getByLabel("审批回答").fill("Approved fixture answer");
  await page.getByRole("button", { name: "允许这一次" }).click();
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(
    calls.filter((call) => call[0] === "stop"),
    [
      ["stop", { connectionId: "connection-b" }],
      ["stop", { connectionId: "connection-a" }],
    ],
  );
  assert.equal(calls.filter((call) => call[0] === "send").length, 1);
  assert.equal(calls.find((call) => call[0] === "send")[1].connectionId, "connection-a");
  assert.equal(calls.find((call) => call[0] === "approve")[1].approvalId, "approval-a");
  await page.evaluate(() => {
    window.emit("a", {
      method: "agent/approvalResolved",
      params: {
        sessionId: "session-a",
        requestId: "approval-a",
      },
    });
    for (const generation of [1, 2])
      window.emit("a", {
        method: "agent/approvalRequest",
        params: {
          sessionId: "session-a",
          requestId: "reused-id",
          connectionId: "worker-a",
          generation,
          request: { toolName: "Write", description: "Approval generation " + generation },
        },
      });
    window.emit("a", {
      method: "agent/approvalResolved",
      params: {
        sessionId: "session-a",
        requestId: "reused-id",
        connectionId: "worker-a",
        generation: 1,
      },
    });
  });
  await page.getByText("Approval generation 2", { exact: true }).waitFor();
  assert.equal(await page.getByText("Approval generation 1", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  const routed = await page.evaluate(
    () => window.calls.filter((call) => call[0] === "approve").at(-1)[1],
  );
  assert.equal(routed.workerConnectionId, "worker-a");
  assert.equal(routed.generation, 2);
  assert.equal(await page.getByRole("button", { name: "允许这一次" }).isDisabled(), true);
  await page.evaluate(() =>
    window.emit("a", {
      method: "agent/approvalResolved",
      params: {
        sessionId: "session-a",
        requestId: "reused-id",
        connectionId: "worker-a",
        generation: 2,
      },
    }),
  );
  await page.getByText("Approval generation 2", { exact: true }).waitFor({ state: "hidden" });
  // A fast Host may finish while the main-process IPC reply is still pending.
  // The reply must not erase a newer draft or turn completion back into running.
  await page.evaluate(() => {
    window.emit("a", { type: "chat.accepted", sessionId: "session-a" });
    window.emit("a", {
      type: "session.stream",
      sessionId: "session-a",
      event: {
        method: "agent/streamEvent",
        params: { event: { type: "turn_complete", reason: "completed" } },
      },
    });
    window.codeshell.accountDevices.send = (input) => {
      window.calls.push(["send", input]);
      window.emit("a", { type: "chat.accepted", sessionId: "session-a" });
      window.output("a", "fast task finished before IPC reply");
      window.emit("a", {
        type: "session.stream",
        sessionId: "session-a",
        event: {
          method: "agent/streamEvent",
          params: { event: { type: "turn_complete", reason: "completed" } },
        },
      });
      return new Promise((resolve) => {
        window.finishSend = resolve;
      });
    };
  });
  await page.getByLabel("电脑任务", { exact: true }).fill("Fast task");
  await page.getByRole("button", { name: "发送到此电脑" }).click();
  await page.getByText(/fast task finished before IPC reply/).waitFor();
  await page.getByLabel("电脑任务", { exact: true }).fill("New draft while IPC is pending");
  assert.equal(await page.getByRole("button", { name: "发送到此电脑" }).isDisabled(), true);
  await page.evaluate(() => window.finishSend());
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "发送到此电脑" && !button.disabled,
    ),
  );
  assert.equal(
    await page.getByLabel("电脑任务", { exact: true }).inputValue(),
    "New draft while IPC is pending",
  );
  assert.equal(await page.getByText("Fast task", { exact: true }).count(), 1);
  // The Host's actual frame limit applies to all text and attachments together.
  const sentBeforeLargeImage = await page.evaluate(
    () => window.calls.filter((call) => call[0] === "send").length,
  );
  await page.getByLabel("添加图片", { exact: true }).setInputFiles({
    name: "too-large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(800_000, 1),
  });
  await page.getByRole("button", { name: "too-large.png ×" }).waitFor();
  await page.getByRole("button", { name: "发送到此电脑" }).click();
  await page.getByText(/任务与图片合计超过 1 MiB/).waitFor();
  assert.equal(
    await page.evaluate(() => window.calls.filter((call) => call[0] === "send").length),
    sentBeforeLargeImage,
  );
  await page.getByRole("button", { name: "too-large.png ×" }).click();
  // Restore the original long task after access expires; never create or resend it.
  await page.evaluate(() => {
    window.output("a", "long task still runs on A");
    window.emit("a", undefined, "disconnected");
  });
  await page.getByRole("button", { name: "恢复原会话" }).click();
  await page.getByText(/已恢复原会话。断线期间的历史需要核对/).waitFor();
  assert.equal(
    await page.getByLabel("电脑任务", { exact: true }).inputValue(),
    "New draft while IPC is pending",
  );
  await page.getByRole("button", { name: "停止此电脑任务" }).click();
  const resumedCalls = await page.evaluate(() => window.calls);
  assert.deepEqual(
    resumedCalls.filter((call) => call[0] === "resume"),
    [["resume", "connection-a"]],
  );
  assert.equal(resumedCalls.filter((call) => call[0] === "connect").length, 2);
  assert.equal(resumedCalls.filter((call) => call[0] === "send").length, sentBeforeLargeImage);
  assert.deepEqual(resumedCalls.filter((call) => call[0] === "stop").at(-1), [
    "stop",
    { connectionId: "connection-a" },
  ]);
  await page.screenshot({ path: path.join(output, "devices-desktop.png") });
  // An older online directory response cannot undo a newer offline response.
  await page.evaluate(() => {
    const previous = window.structuredClone(window.devices);
    window.codeshell.accountDevices.list = () => {
      window.codeshell.accountDevices.list = async () => window.devices;
      return new Promise((resolve) => {
        window.finishOldList = () => resolve(previous);
      });
    };
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => typeof window.finishOldList === "function");
  await page.evaluate(() => {
    window.devices = window.devices.map((device) => ({ ...device, online: false }));
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.disabled);
  await page.evaluate(async () => {
    window.finishOldList();
    await new Promise(window.requestAnimationFrame);
  });
  assert.equal(await page.getByRole("button", { name: /Mac Studio/ }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "发送到此电脑" }).isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "devices-narrow.png") });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.evaluate(() => window.signOut());
  await page.getByText("请先登录账号，登录后本机将自动加入设备协作。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("电脑任务", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    JSON.stringify({
      ok: true,
      assertions:
        "device/project selection; output, drafts, attachments, approvals and Stop isolation; worker-generation approval fencing; fast completion before IPC reply; oversized-frame preflight; original-session restoration without task replay; late directory responses; offline rejection; logout; 390px layout",
      screenshots: output,
    }),
  );
} finally {
  await browser.close();
}
