/* Production computer chooser, synthetic main bridge, no account or model traffic. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
const outputIndex = process.argv.indexOf("--output-dir");
const output =
  outputIndex >= 0
    ? path.resolve(process.argv[outputIndex + 1])
    : await mkdtemp(path.join(tmpdir(), "codeshell-computer-chooser-ui-"));
await mkdir(output, { recursive: true });
const LOCAL = "11111111-1111-4111-8111-111111111111";
const REMOTE = "22222222-2222-4222-8222-222222222222";
const OFFLINE = "33333333-3333-4333-8333-333333333333";
const REVOKED = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ORIGIN = "https://account.fixture.invalid";
const source = String.raw`
import React from "react";
import {createRoot} from "react-dom/client";
import {AccountDeviceWorkspace} from "./runtime/AccountDeviceWorkspace";
const boot=window.fixtureConfig??{};
const localId=${JSON.stringify(LOCAL)};
const origin=${JSON.stringify(ACCOUNT_ORIGIN)};
window.calls=[];window.pendingLists=[];window.pendingOpens=[];
window.account=boot.account??{state:"signed-in",origin,account:{id:"account-a",username:"fixture"}};
window.relay=boot.relay??{state:"ready",registered:true,hostId:localId,accountId:"account-a",relayOrigin:origin,remoteAccessEnabled:true,name:"Mac Studio"};
window.features={"devices.directory":{id:"devices.directory",state:boot.featureState??"ready"}};
window.devices=boot.devices??[
 {hostId:localId,environmentId:"env-local",name:"Mac Studio",online:true,revoked:false,protocolVersion:1},
 {hostId:${JSON.stringify(REMOTE)},environmentId:"env-remote",name:"Linux Builder",online:true,revoked:false,protocolVersion:1},
 {hostId:${JSON.stringify(OFFLINE)},environmentId:"env-offline",name:"Travel Laptop",online:false,revoked:false,protocolVersion:1},
 {hostId:${JSON.stringify(REVOKED)},environmentId:"env-revoked",name:"Revoked Computer",online:true,revoked:true,protocolVersion:1}
];
window.listMode=boot.listMode;window.openMode=boot.openMode;
const accountListeners=new Set(),relayListeners=new Set(),featureListeners=new Set();
window.setAccount=state=>{window.account=state;for(const fn of accountListeners)fn(state)};
window.setRelay=state=>{window.relay=state;for(const fn of relayListeners)fn(state)};
window.setFeature=state=>{window.features={"devices.directory":{id:"devices.directory",state}};for(const fn of featureListeners)fn(window.features)};
const subscribe=set=>fn=>{set.add(fn);return()=>set.delete(fn)};
const forbidden=name=>(...args)=>{window.calls.push(["forbidden",name,args]);throw new Error("Chooser must not call "+name)};
window.codeshell={
 platform:"darwin",
 cloudAccount:{
  status:()=>boot.deferAccount?new Promise(resolve=>{window.finishAccount=resolve}):Promise.resolve(window.account),
  onStatus:subscribe(accountListeners),resume:forbidden("account.resume")
 },
 mobileRemote:{relay:{
  status:()=>boot.deferRelay?new Promise(resolve=>{window.finishRelay=resolve}):Promise.resolve(window.relay),
  onStatus:subscribe(relayListeners)
 }},
 accountFeatures:{
  snapshot:()=>boot.deferFeatures?new Promise(resolve=>{window.finishFeatures=resolve}):Promise.resolve(window.features),
  onChanged:subscribe(featureListeners)
 },
 accountDevices:{
  list:async()=>{window.calls.push(["list",window.account.account?.id]);if(window.listMode==="defer")return new Promise((resolve,reject)=>window.pendingLists.push({resolve,reject}));if(window.listMode==="fail")throw new Error("目录暂时不可用");return [...window.devices]},
  ...Object.fromEntries(["projects","connect","resume","send","stop","approve","close","onEvent"].map(name=>[name,forbidden(name)]))
 },
 openExternal:async url=>{window.calls.push(["external",url]);if(window.openMode==="defer")return new Promise((resolve,reject)=>window.pendingOpens.push({resolve,reject}));if(window.openMode==="fail")throw new Error("浏览器未能打开");}
};
function Fixture(){
 const [open,setOpen]=React.useState(true);
 const [draft,setDraft]=React.useState("原有聊天草稿");
 window.showChooser=()=>setOpen(true);
 return <>
  <main hidden={open} aria-label="原有本机工作台"><h1>原有聊天</h1><span>existing-session</span><textarea aria-label="原有聊天草稿" value={draft} onChange={e=>setDraft(e.target.value)}/></main>
  <AccountDeviceWorkspace open={open} onClose={()=>{window.calls.push(["back"]);setOpen(false)}} onOpenLocal={()=>{window.calls.push(["local"]);setOpen(false)}}/>
 </>;
}
window.addEventListener("codeshell:open-account-settings",()=>window.calls.push(["account-settings"]));
createRoot(document.getElementById("root")).render(<Fixture/>);
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
const html = `<html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeShell computer chooser fixture</title><style>${css}</style><body><div id="root"></div></body></html>`;
if (process.argv.includes("--build-only")) {
  const file = path.join(output, "computer-chooser.html");
  await writeFile(
    file,
    html.replace("</body>", `<script>${result.outputFiles[0].text}</script></body>`),
  );
  console.log(
    JSON.stringify({
      html: file,
      boundary:
        "production component with synthetic bridge; no credentials, account calls, task or model",
    }),
  );
  process.exit(0);
}
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const checks = [];
const screenshots = [];
const errors = [];
const unexpected = [];
const fixtureOrigin = "https://computer-chooser.fixture.invalid/";
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route("**/*", (route) => {
  if (route.request().url() === fixtureOrigin)
    return route.fulfill({ contentType: "text/html", body: html });
  unexpected.push(route.request().url());
  return route.abort();
});
const localButton = (page) => page.getByRole("button", { name: "打开本机聊天", exact: true });
const remoteButton = (page) =>
  page.getByRole("button", { name: "连接 Linux Builder", exact: true });
const refreshButton = (page) => page.getByRole("button", { name: "刷新电脑列表", exact: true });
async function createPage(boot = {}) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixtureOrigin);
  await page.evaluate((config) => {
    window.fixtureConfig = config;
  }, boot);
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await localButton(page).waitFor();
  return page;
}
async function closePage(page) {
  assert.deepEqual(
    await page.evaluate(() => window.calls.filter((c) => c[0] === "forbidden")),
    [],
    "Computer selection must never create, send, stop, approve or subscribe to a task",
  );
  await page.close();
}
async function checkpoint(name, run) {
  await run();
  checks.push(name);
}
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
      ),
  );
}
try {
  const page = await createPage();
  await remoteButton(page).waitFor();
  await checkpoint("chooser has no separate project/task form or execution calls", async () => {
    for (const name of ["执行项目", "电脑任务", "添加图片", "发送到此电脑", "停止此电脑任务"])
      assert.equal(await page.getByLabel(name, { exact: true }).count(), 0);
    assert.equal(await page.locator("select").count(), 0);
    assert.equal(await page.locator("textarea:visible").count(), 0);
    assert.equal(await page.getByText("Revoked Computer", { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "连接 Mac Studio", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "连接 Travel Laptop", exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.calls.filter((c) => c[0] === "forbidden")),
      [],
    );
  });
  await checkpoint("local selection returns to existing chat and preserves its draft", async () => {
    await localButton(page).click();
    await page.getByRole("main", { name: "原有本机工作台" }).waitFor();
    assert.equal(await page.getByLabel("原有聊天草稿").inputValue(), "原有聊天草稿");
    assert.equal(await page.getByText("existing-session", { exact: true }).count(), 1);
    assert.deepEqual(
      await page.evaluate(() =>
        window.calls.filter((c) => ["external", "forbidden"].includes(c[0])),
      ),
      [],
    );
    await page.evaluate(() => window.showChooser());
    await remoteButton(page).waitFor();
  });
  await checkpoint(
    "online remote opens exact selected computer in the account workbench",
    async () => {
      await remoteButton(page).click();
      assert.deepEqual(await page.evaluate(() => window.calls.filter((c) => c[0] === "external")), [
        ["external", `${ACCOUNT_ORIGIN}/app?target=choose&computer=${REMOTE}`],
      ]);
      assert.deepEqual(
        await page.evaluate(() => window.calls.filter((c) => c[0] === "forbidden")),
        [],
      );
    },
  );
  await closePage(page);

  for (const [name, boot] of [
    ["signed out", { account: { state: "signed-out" }, featureState: "sign-in" }],
    ["safe storage unavailable", { account: { state: "storage-error" }, featureState: "pending" }],
    ["remote feature disabled", { featureState: "hidden" }],
    ["directory unavailable", { listMode: "fail" }],
    ["directory still loading", { listMode: "defer" }],
    ["local registration unavailable", { relay: { state: "unregistered", registered: false } }],
  ]) {
    const page = await createPage(boot);
    await checkpoint(`local chat remains available when ${name}`, async () => {
      assert.equal(await localButton(page).isEnabled(), true);
      await localButton(page).click();
      await page.getByRole("main", { name: "原有本机工作台" }).waitFor();
      assert.deepEqual(
        await page.evaluate(() =>
          window.calls.filter((c) => ["external", "forbidden"].includes(c[0])),
        ),
        [],
      );
      assert.equal(await page.getByLabel("原有聊天草稿").inputValue(), "原有聊天草稿");
    });
    await closePage(page);
  }

  const retry = await createPage({ openMode: "fail" });
  await remoteButton(retry).waitFor();
  await checkpoint(
    "browser launch failure leaves explicit retry and local chat available",
    async () => {
      await remoteButton(retry).click();
      await retry.getByRole("alert").filter({ hasText: "浏览器未能打开" }).waitFor();
      assert.equal(await remoteButton(retry).isEnabled(), true);
      assert.equal(await localButton(retry).isEnabled(), true);
      await retry.evaluate(() => {
        window.openMode = undefined;
      });
      await remoteButton(retry).click();
      assert.equal(
        await retry.evaluate(() => window.calls.filter((c) => c[0] === "external").length),
        2,
      );
    },
  );
  await closePage(retry);

  const pending = await createPage({ openMode: "defer" });
  await remoteButton(pending).waitFor();
  await checkpoint("one pending browser launch cannot be duplicated", async () => {
    await remoteButton(pending).click();
    assert.equal(await remoteButton(pending).isDisabled(), true);
    assert.equal(await localButton(pending).isEnabled(), true);
    assert.equal(
      await pending.evaluate(() => window.calls.filter((c) => c[0] === "external").length),
      1,
    );
  });
  await checkpoint("closing chooser ignores a late launch error", async () => {
    await pending.getByRole("button", { name: "返回工作台", exact: true }).click();
    await pending.evaluate(() => window.pendingOpens[0].reject(new Error("旧页面打开失败")));
    await settle(pending);
    assert.equal(await pending.getByText("旧页面打开失败", { exact: true }).count(), 0);
    await pending.evaluate(() => {
      window.openMode = undefined;
      window.showChooser();
    });
    await remoteButton(pending).waitFor();
    assert.equal(await remoteButton(pending).isEnabled(), true);
  });
  await closePage(pending);

  const localWhileOpening = await createPage({ openMode: "defer" });
  await remoteButton(localWhileOpening).waitFor();
  await checkpoint("opening a browser never blocks returning to local chat", async () => {
    await remoteButton(localWhileOpening).click();
    await localButton(localWhileOpening).click();
    await localWhileOpening.getByRole("main", { name: "原有本机工作台" }).waitFor();
    assert.equal(await localWhileOpening.getByLabel("原有聊天草稿").inputValue(), "原有聊天草稿");
    await localWhileOpening.evaluate(() =>
      window.pendingOpens[0].reject(new Error("已离开的连接失败")),
    );
    await settle(localWhileOpening);
    assert.equal(await localWhileOpening.getByText("已离开的连接失败", { exact: true }).count(), 0);
  });
  await closePage(localWhileOpening);

  const switched = await createPage({ listMode: "defer" });
  await switched.waitForFunction(() => window.pendingLists.length === 1);
  await checkpoint(
    "late old-account directory response cannot populate the new account",
    async () => {
      await switched.evaluate(() => {
        window.setAccount({ state: "signed-out" });
        window.setAccount({
          state: "signed-in",
          origin: "https://account.fixture.invalid",
          account: { id: "account-b", username: "second" },
        });
      });
      await switched.waitForFunction(() => window.pendingLists.length >= 2);
      await switched.evaluate(() => window.pendingLists[0].resolve(window.devices));
      await settle(switched);
      assert.equal(await remoteButton(switched).count(), 0);
      await switched.evaluate(() => window.pendingLists[1].resolve([]));
      await settle(switched);
      assert.equal(await remoteButton(switched).count(), 0);
      assert.equal(await localButton(switched).isEnabled(), true);
    },
  );
  await closePage(switched);

  const openSwitch = await createPage({ openMode: "defer" });
  await remoteButton(openSwitch).waitFor();
  await checkpoint(
    "old-account launch completion cannot clear a new launch or show its error",
    async () => {
      await remoteButton(openSwitch).click();
      await openSwitch.evaluate(() =>
        window.setAccount({
          state: "signed-in",
          origin: "https://account.fixture.invalid",
          account: { id: "account-b", username: "second" },
        }),
      );
      await remoteButton(openSwitch).waitFor();
      await openSwitch.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (button) =>
            button.getAttribute("aria-label") === "连接 Linux Builder" && !button.disabled,
        ),
      );
      await remoteButton(openSwitch).click();
      await openSwitch.waitForFunction(() => window.pendingOpens.length === 2);
      await openSwitch.evaluate(() => window.pendingOpens[0].reject(new Error("旧账号打开失败")));
      await settle(openSwitch);
      assert.equal(await remoteButton(openSwitch).isDisabled(), true);
      assert.equal(await openSwitch.getByText("旧账号打开失败", { exact: true }).count(), 0);
      await openSwitch.evaluate(() => window.pendingOpens[1].reject(new Error("当前账号打开失败")));
      await openSwitch.getByRole("alert").filter({ hasText: "当前账号打开失败" }).waitFor();
      assert.equal(await remoteButton(openSwitch).isEnabled(), true);
    },
  );
  await closePage(openSwitch);

  const relayMismatch = await createPage({
    relay: {
      state: "ready",
      registered: true,
      hostId: REMOTE,
      accountId: "old-account",
      relayOrigin: ACCOUNT_ORIGIN,
    },
  });
  await checkpoint(
    "another account's stale relay cannot hide or mislabel the remote computer",
    async () => {
      await remoteButton(relayMismatch).waitFor();
      assert.equal(await remoteButton(relayMismatch).isEnabled(), true);
      await remoteButton(relayMismatch).click();
      assert.deepEqual(
        await relayMismatch.evaluate(() => window.calls.filter((c) => c[0] === "external")),
        [["external", `${ACCOUNT_ORIGIN}/app?target=choose&computer=${REMOTE}`]],
      );
    },
  );
  await closePage(relayMismatch);

  const relayRace = await createPage({ deferRelay: true });
  await remoteButton(relayRace).waitFor();
  await checkpoint(
    "late relay snapshot cannot replace the current local-computer identity",
    async () => {
      await relayRace.evaluate(
        ({ localId, remoteId, origin }) => {
          window.setRelay({
            state: "ready",
            registered: true,
            hostId: localId,
            accountId: "account-a",
            relayOrigin: origin,
          });
          window.finishRelay({
            state: "ready",
            registered: true,
            hostId: remoteId,
            accountId: "account-a",
            relayOrigin: origin,
          });
        },
        { localId: LOCAL, remoteId: REMOTE, origin: ACCOUNT_ORIGIN },
      );
      await settle(relayRace);
      assert.equal(await remoteButton(relayRace).count(), 1);
      assert.equal(
        await relayRace.getByRole("button", { name: "连接 Mac Studio", exact: true }).count(),
        0,
      );
    },
  );
  await closePage(relayRace);

  const status = await createPage({ deferAccount: true, deferRelay: true, deferFeatures: true });
  await checkpoint(
    "live account and feature events take precedence over initial snapshots",
    async () => {
      await status.evaluate(() => {
        window.setAccount({ state: "signed-out" });
        window.setFeature("sign-in");
        window.finishAccount({
          state: "signed-in",
          origin: "https://old.fixture.invalid",
          account: { id: "old", username: "old" },
        });
        window.finishFeatures({ "devices.directory": { id: "devices.directory", state: "ready" } });
        window.finishRelay({
          state: "ready",
          registered: true,
          hostId: "11111111-1111-4111-8111-111111111111",
          accountId: "old",
          relayOrigin: "https://old.fixture.invalid",
        });
      });
      await settle(status);
      assert.equal(await remoteButton(status).count(), 0);
      assert.equal(
        await status.evaluate(() => window.calls.filter((c) => c[0] === "list").length),
        0,
      );
      await localButton(status).click();
      await status.getByRole("main", { name: "原有本机工作台" }).waitFor();
    },
  );
  await closePage(status);

  const refresh = await createPage();
  await remoteButton(refresh).waitFor();
  await checkpoint("directory refresh keeps existing choices while loading", async () => {
    await refresh.evaluate(() => {
      window.listMode = "defer";
    });
    await refreshButton(refresh).click();
    await refresh.waitForFunction(() => window.pendingLists.length === 1);
    assert.equal(await remoteButton(refresh).count(), 1);
    assert.equal(await localButton(refresh).isEnabled(), true);
    await refresh.evaluate(() => window.pendingLists[0].reject(new Error("稍后再试")));
    await refresh.getByRole("alert").filter({ hasText: "暂时无法读取其他电脑" }).waitFor();
    assert.equal(await localButton(refresh).isEnabled(), true);
  });
  await closePage(refresh);

  for (const width of [360, 640, 1280]) {
    const page = await createPage();
    await page.setViewportSize({ width, height: 820 });
    await remoteButton(page).waitFor();
    await checkpoint(
      `${width}px chooser fits and exposes working local/back controls`,
      async () => {
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          true,
        );
        assert.equal(await localButton(page).isEnabled(), true);
        const back = page.getByRole("button", { name: "返回工作台", exact: true });
        assert.deepEqual(
          await back.evaluate((button) => [
            window
              .getComputedStyle(button.closest("header"))
              .getPropertyValue("-webkit-app-region"),
            window.getComputedStyle(button).getPropertyValue("-webkit-app-region"),
          ]),
          ["drag", "no-drag"],
        );
        const file = path.join(output, `computer-chooser-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        screenshots.push(file);
        await page.keyboard.press("Escape");
        await page.getByRole("main", { name: "原有本机工作台" }).waitFor();
      },
    );
    await closePage(page);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  const report = {
    ok: true,
    checks,
    count: checks.length,
    screenshots,
    errors,
    unexpected,
    boundary:
      "Production chooser, synthetic main bridge, isolated browser context; no real account, credentials, host project, task or provider",
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
