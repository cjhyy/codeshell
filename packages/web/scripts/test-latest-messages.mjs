/** Production Workbench/React/CSS with an owned snapshot/session HTTP API.
 * Browser requests to any other origin are blocked. No provider or credentials.
 * Run: bun run --cwd packages/web test:latest-browser
 */
/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(web, "../desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output =
  process.env.CODESHELL_LATEST_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-web-latest-")));
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {Workbench} from './Workbench';
  function Fixture(){
    const [model,setModel]=React.useState(null);
    const read=async(url='/fixture/state')=>setModel(await (await fetch(url)).json());
    window.refreshFixture=()=>read();
    React.useEffect(()=>{void read()},[]);
    if(!model)return null;
    const noop=()=>{};
    const controller={panelSessionId:undefined,...model,host:'desktop',workspaceApi:true,
      chat:{items:model.items,run:'running',seq:1,liveByAgent:{}},configuration:null,
      configurationVersion:0,sessionsVersion:0,draft:model.draft??'',files:[],uploading:false,
      uploadBusy:false,hasUnsent:false,uncertain:false,running:true,localDrafts:[],approvals:[],
      approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,
      setDraft:draft=>setModel(current=>({...current,draft})),
      removeFile:noop,selectSession:id=>read('/fixture/session?id='+id),newSession:noop,
      send:()=>{if(!model.draft?.trim())return false;setModel(current=>({...current,draft:''}));return true},
      stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,
      onAuthLost:noop,showTurnCounts:false};
    return <Workbench controller={controller}/>;
  }
  createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(web, "app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: path.join(output, "bundle"),
  platform: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const history = (session) => [
  ...Array.from({ length: 36 }, (_, index) => ({
    kind: "assistant",
    id: `${session}-${index}`,
    reasoning: "",
    done: true,
    text:
      `## ${session} paragraph ${index}\n\n` +
      "Read earlier conversation without losing your place. ".repeat(12),
  })),
  {
    kind: "assistant",
    id: `${session}-stream`,
    reasoning: "",
    text: "Streaming reply",
    done: false,
  },
];
const histories = { a: history("a"), b: history("b") };
let model = {
  activeId: "a",
  items: histories.a,
  connection: "open",
  loading: false,
  workspaceCwd: "/fixture",
  workspaceName: "Latest message review",
  workspaceKey: "fixture",
  title: "Session A",
  sessions: [
    { sessionId: "a", title: "Session A", status: "active" },
    { sessionId: "b", title: "Session B", status: "active" },
  ],
};
const requests = [],
  unexpected = [],
  external = [],
  errors = [],
  reports = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  requests.push(url.pathname + url.search);
  const reply = (body, status = 200, type = "application/json") => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  if (request.method !== "GET") {
    unexpected.push(`${request.method} ${request.url}`);
    return reply({}, 405);
  }
  if (url.pathname === "/")
    return reply(
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      200,
      "text/html",
    );
  if (url.pathname === "/fixture.js") return reply(js, 200, "text/javascript");
  if (url.pathname === "/fixture.css") return reply(css, 200, "text/css");
  if (url.pathname === "/fixture/state") return reply(model);
  if (url.pathname === "/fixture/session" && Object.hasOwn(histories, url.searchParams.get("id"))) {
    const id = url.searchParams.get("id");
    model = { ...model, activeId: id, items: histories[id], title: `Session ${id.toUpperCase()}` };
    return reply(model);
  }
  if (url.pathname === "/api/v1/environment") return reply({}, 404);
  unexpected.push(request.url);
  reply({}, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium
  .launch({
    headless: true,
    executablePath:
      process.env.CODESHELL_TEST_CHROMIUM ||
      (process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined),
  })
  .catch(async (cause) => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw cause;
  });
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  serviceWorkers: "block",
});
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
page.on("pageerror", (error) => errors.push(String(error)));
const list = () => page.locator(".messages");
const jump = () => page.getByRole("button", { name: /^回到最新消息/ });
const distance = () =>
  list().evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const update = async (patch = {}) => {
  model = { ...model, ...patch };
  await page.evaluate(() => window.refreshFixture());
  await frames();
};
const grow = async (suffix) => {
  await update({
    items: model.items.map((item) =>
      item.id.endsWith("-stream") ? { ...item, text: item.text + suffix } : item,
    ),
  });
};
const readEarlier = async () => {
  await list().focus();
  await page.keyboard.press("PageUp");
  await jump().waitFor();
  // Native PageUp can animate. Wait for its actual scroll position to settle.
  await page.evaluate(async () => {
    const node = document.querySelector(".messages");
    let previous = node.scrollTop,
      stable = 0;
    while (stable < 4) {
      await new Promise(requestAnimationFrame);
      const next = node.scrollTop;
      stable = Math.abs(previous - next) < 0.1 ? stable + 1 : 0;
      previous = next;
    }
  });
  assert.ok((await distance()) > 100);
  return list().evaluate((node) => node.scrollTop);
};
const atBottom = () =>
  page.waitForFunction(() => {
    const node = document.querySelector(".messages");
    return node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
  });
try {
  await page.goto(origin);
  await list().waitFor();
  assert.equal(await page.getByRole("region", { name: "消息列表", exact: true }).count(), 1);
  await atBottom();
  await grow("\nLive output at the bottom.\n".repeat(10));
  await atBottom();
  assert.equal(await jump().count(), 0);

  const before = await readEarlier();
  await page.evaluate(() => {
    window.jumpButton = document.querySelector(".latest-messages");
  });
  for (let index = 0; index < 20; index++) {
    await grow(`\nStreaming increment ${index}.`);
    assert.equal(await jump().getAttribute("aria-label"), "回到最新消息，1 条新输出");
    assert.equal(
      await page.evaluate(() => window.jumpButton === document.querySelector(".latest-messages")),
      true,
    );
  }
  assert.ok(
    Math.abs((await list().evaluate((node) => node.scrollTop)) - before) <= 1,
    "Streaming preserves the reader's scroll position",
  );
  await update({
    items: [...model.items, { kind: "system", id: "new-output", text: "Another output message" }],
  });
  assert.equal(await jump().getAttribute("aria-label"), "回到最新消息，2 条新输出");
  await update({
    items: [
      ...model.items,
      { kind: "assistant", id: "hidden-empty", text: "", reasoning: "", done: true },
    ],
  });
  assert.equal(
    await jump().getAttribute("aria-label"),
    "回到最新消息，2 条新输出",
    "Hidden assistant placeholders never add a notice",
  );
  await update();
  assert.equal(
    await jump().getAttribute("aria-label"),
    "回到最新消息，2 条新输出",
    "An identical replay does not inflate the count",
  );
  await jump().focus();
  await page.keyboard.press("Enter");
  await atBottom();
  assert.equal(await jump().count(), 0);
  assert.equal(
    await list().evaluate((node) => node === document.activeElement),
    true,
    "Jump returns keyboard focus to the transcript",
  );
  await grow("\nFollowing resumed.\n".repeat(12));
  await atBottom();

  const beforeReconnect = await readEarlier();
  await grow("\nOutput before reconnect.");
  await update({ connection: "closed" });
  assert.equal(await jump().getAttribute("aria-label"), "回到最新消息");
  await update({ connection: "open", loading: true });
  await update({ loading: false });
  assert.ok(
    Math.abs((await list().evaluate((node) => node.scrollTop)) - beforeReconnect) <= 1,
    "Reconnect clears notices without stealing reading position",
  );
  assert.equal(await jump().getAttribute("aria-label"), "回到最新消息");
  await grow("\nNew output after reconnect.");
  assert.equal(await jump().getAttribute("aria-label"), "回到最新消息，1 条新输出");
  const readerTop = await list().evaluate((node) => node.scrollTop);
  const input = page.getByRole("textbox", { name: "任务内容", exact: true });
  await input.press("Enter");
  assert.equal(
    await jump().getAttribute("aria-label"),
    "回到最新消息，1 条新输出",
    "A rejected empty send preserves reading state",
  );
  assert.ok(Math.abs((await list().evaluate((node) => node.scrollTop)) - readerTop) <= 1);
  await input.fill("Explicitly accepted fixture draft");
  await input.press("Enter");
  await atBottom();
  assert.equal(await jump().count(), 0, "Only an accepted send resumes following");
  await readEarlier();
  await grow("\nUnread before switching session.");
  await page.getByRole("button", { name: /^Session B/ }).click();
  await page.waitForFunction(() =>
    document.querySelector(".session[aria-current=page]")?.textContent.includes("Session B"),
  );
  await atBottom();
  assert.equal(await jump().count(), 0);

  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 760, 1280]) {
      await page.setViewportSize({ width, height: width < 760 ? 360 : 620 });
      await atBottom();
      await grow("\nResize follow test.\n".repeat(6));
      await atBottom();
      await readEarlier();
      await grow("\nPaused output.");
      const button = await jump().boundingBox();
      const composer = await page.locator(".composer").boundingBox();
      const listBounds = await list().boundingBox();
      const viewportBounds = await page.locator(".message-viewport").boundingBox();
      assert.ok(
        listBounds.width >= viewportBounds.width - 1,
        "The live announcement never takes transcript width",
      );
      assert.ok(
        button.x >= 0 && button.x + button.width <= width,
        "Latest button fits the viewport",
      );
      assert.ok(
        button.y >= 0 && button.y + button.height <= composer.y,
        "Latest button never covers the composer",
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        "No horizontal overflow",
      );
      await page.screenshot({ path: path.join(output, `latest-${colorScheme}-${width}.png`) });
      await page.setViewportSize({ width, height: width < 760 ? 390 : 650 });
      await frames();
      assert.ok((await distance()) > 100, "Resizing an older paragraph does not jump to latest");
      await jump().focus();
      await page.keyboard.press("Space");
      await atBottom();
      reports.push({ colorScheme, width, button, composer });
    }
  }
  await readEarlier();
  await grow("\nUnread in the previous workspace.");
  await update({ workspaceKey: "another-workspace" });
  await atBottom();
  assert.equal(await jump().count(), 0, "Workspace changes reset the previous notice");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(external, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        production: true,
        streamingIncrements: 20,
        stableCounts: true,
        reconnectPreservesReading: true,
        sessionReset: true,
        workspaceReset: true,
        reports,
        requests,
        errors,
        external,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS Web latest messages: following, paused streaming/counts, replay/reconnect, session/workspace reset, keyboard and 8 light/dark layouts. Evidence: ${output}`,
  );
} catch (cause) {
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  console.error(`Latest message failure evidence: ${output}`);
  throw cause;
} finally {
  await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
