/*
 * Manual native-browser regression for ContextMenu + imperative dialogs.
 * Run: node packages/desktop/src/renderer/ui/DialogProvider.browser.fixture.mjs
 * Playwright Chromium must be installed. Components bundle only in memory;
 * this fixture never writes production output or uses a developer profile.
 */
/* global document, window */
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const uiDir = fileURLToPath(new URL(".", import.meta.url));
const renderer = fileURLToPath(new URL("..", import.meta.url));
const built = await build({
  stdin: {
    contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ContextMenu} from './ContextMenu.tsx';
    import {DialogProvider,usePrompt,useConfirm,useAlert} from './DialogProvider.tsx';
    function Harness(){
      const [menu,setMenu]=useState(null); const [showOpener,setShowOpener]=useState(true);
      const [actions,setActions]=useState([]);
      const prompt=usePrompt(); const confirm=useConfirm(); const alert=useAlert(); window.reviewApi={prompt,confirm,alert,setShowOpener};
      const record = label=>setActions(prev=>[...prev,label]);
      const items=[
        {label:'Alpha',onClick:()=>record('Alpha')},
        {label:'Disabled',disabled:true,onClick:()=>record('Disabled')},
        {label:'Prompt action',onClick:()=>{void window.reviewApi[window.reviewDialogKind||'prompt']({title:'Menu prompt',message:'Input name',defaultValue:'default'}).then(value=>record('Prompt:'+String(value)));}},
        {label:'Omega',onClick:()=>record('Omega')},
      ];
      return <>
        <button id="before">Before</button>
        {showOpener && <button id="opener" onClick={()=>setMenu('normal')}>Open menu</button>}
        <input id="outside" placeholder="Outside input"/>
        <button id="disabled-opener" onClick={()=>setMenu('disabled')}>Open disabled menu</button>
        <button id="after">After</button>
        <output>{actions.join(',')}</output>
        {menu && <ContextMenu x={100} y={100} items={menu==='disabled'?items.map(item=>({...item,disabled:true})):items} onClose={()=>setMenu(null)}/>}
      </>;
    }
    createRoot(document.getElementById('root')).render(<DialogProvider><Harness/></DialogProvider>);
  `,
    resolveDir: uiDir,
    loader: "tsx",
  },
  alias: { "@": renderer },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const failures = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
function check(condition, message) {
  if (!condition) throw new Error(message);
}
const focused = async () =>
  page.evaluate(
    () =>
      document.activeElement?.id ||
      document.activeElement?.textContent ||
      document.activeElement?.tagName,
  );
const waitFocused = async (selector) =>
  page.waitForFunction(
    (selector) => document.activeElement === document.querySelector(selector),
    selector,
  );
const open = async (id = "opener") => {
  await page.locator("#" + id).click();
  await page.getByRole("menu").waitFor();
  await waitFocused(id === "disabled-opener" ? '[role="menu"]' : '[role="menuitem"]');
};
const close = async () => {
  if (await page.getByRole("menu").count()) await page.keyboard.press("Escape");
};
const test = async (name, fn) => {
  try {
    await fn();
    console.log("PASS", name);
  } catch (e) {
    failures.push(name + ": " + e.message);
    console.log("FAIL", name, e.message);
  } finally {
    await close();
  }
};
try {
  await page.setContent(
    '<html><head><style>button,input{margin:8px} [role=menu]{background:white;border:1px solid black;z-index:99;list-style:none;padding:4px} [role=menuitem]{display:block} [role=dialog]{position:fixed;inset:120px;background:white;border:2px solid black;z-index:999;padding:20px}</style></head><body><div id="root"></div></body></html>',
  );
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.locator("#opener").waitFor();
  await test("Arrow/Home/End skip disabled and wrap", async () => {
    await open();
    check((await focused()) === "Alpha", "initial enabled focus");
    await page.keyboard.press("ArrowDown");
    check((await focused()) === "Prompt action", "skip disabled");
    await page.keyboard.press("End");
    check((await focused()) === "Omega", "End");
    await page.keyboard.press("ArrowDown");
    check((await focused()) === "Alpha", "down wrap");
    await page.keyboard.press("ArrowUp");
    check((await focused()) === "Omega", "up wrap");
    await page.keyboard.press("Home");
    check((await focused()) === "Alpha", "Home");
    check((await page.locator("output").innerText()) === "", "navigation cannot activate");
    await page.keyboard.press("Escape");
    check((await focused()) === "opener", "Escape opener focus");
  });
  await test("Tab continues after persistent opener", async () => {
    await open();
    await page.keyboard.press("Tab");
    check((await page.getByRole("menu").count()) === 0, "Tab closes");
    check((await focused()) === "outside", "Tab after opener, got " + (await focused()));
  });
  await test("Shift+Tab continues before persistent opener", async () => {
    await open();
    await page.keyboard.press("Shift+Tab");
    check((await focused()) === "before", "ShiftTab before opener, got " + (await focused()));
  });
  await test("all disabled menus receive focus and ignore Arrow/Enter", async () => {
    await open("disabled-opener");
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"])
      await page.keyboard.press(key);
    check(
      await page.getByRole("menu").evaluate((node) => node === document.activeElement),
      "disabled menu retains focus",
    );
    check((await page.locator("output").innerText()) === "", "disabled cannot activate");
    await page.keyboard.press("Escape");
    check((await focused()) === "disabled-opener", "disabled menu Escape opener");
  });
  await test("outside input click keeps target focus", async () => {
    await open();
    await page.locator("#outside").click();
    check((await page.getByRole("menu").count()) === 0, "outside closes");
    check((await focused()) === "outside", "outside target focus, got " + (await focused()));
    await page.keyboard.type("new value");
    check((await page.locator("#outside").inputValue()) === "new value", "outside remains usable");
  });
  await test("native Enter invokes item once", async () => {
    await open();
    await page.keyboard.press("Enter");
    check((await page.locator("output").innerText()) === "Alpha", "one activation");
    check((await focused()) === "opener", "action opener focus");
  });
  await test("menu action dialog returns focus to persistent opener", async () => {
    await open();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    check((await page.getByRole("menu").count()) === 0, "menu closes before dialog");
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(30);
    check((await focused()) === "opener", "dialog return focus got " + (await focused()));
  });

  await test("Confirm and Alert menu actions restore the same persistent opener", async () => {
    for (const kind of ["confirm", "alert"]) {
      await page.evaluate((kind) => (window.reviewDialogKind = kind), kind);
      await open();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: kind === "alert" ? "知道了" : "确定", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await waitFocused("#opener");
    }
  });
  await test("queued dialogs keep focus in each request until the final close", async () => {
    await page.locator("#opener").focus();
    await page.evaluate(() => {
      window.openerFocuses = 0;
      document.getElementById("opener").addEventListener("focus", () => window.openerFocuses++);
      void window.reviewApi.confirm({ title: "Queue first", message: "First" });
      void window.reviewApi.confirm({ title: "Queue second", message: "Second" });
      void window.reviewApi.alert({ title: "Queue alert", message: "Alert" });
      void window.reviewApi.prompt({
        title: "Queue prompt",
        message: "Prompt",
        defaultValue: "queue first",
      });
      void window.reviewApi.prompt({
        title: "Queue final",
        message: "Final",
        defaultValue: "queue final",
      });
    });
    for (const title of ["Queue first", "Queue second"]) {
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await dialog.waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === "确定");
      check(
        (await page.evaluate(() => window.openerFocuses)) === 0,
        "queue should not return to opener",
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
    const alert = page.getByRole("dialog", { name: "Queue alert", exact: true });
    await alert.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === "知道了");
    check(
      (await page.evaluate(() => window.openerFocuses)) === 0,
      "alert queue should not return to opener",
    );
    await alert.getByRole("button", { name: "知道了", exact: true }).click();
    for (const [title, value] of [
      ["Queue prompt", "queue first"],
      ["Queue final", "queue final"],
    ]) {
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await dialog.waitFor();
      await waitFocused('[role="dialog"] input');
      check(
        (await dialog.getByRole("textbox").inputValue()) === value,
        "each queued prompt has its own default",
      );
      check(
        (await page.evaluate(() => window.openerFocuses)) === 0,
        "prompt queue should not return to opener",
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
    await waitFocused("#opener");
    check(
      (await page.evaluate(() => window.openerFocuses)) === 1,
      "opener receives focus only after final close",
    );
  });
  await test("a follow-up dialog enqueued by the result retains batch focus", async () => {
    await page.locator("#opener").focus();
    await page.evaluate(() => {
      window.openerFocuses = 0;
      void window.reviewApi
        .confirm({ title: "Chain first", message: "First" })
        .then(() => window.reviewApi.alert({ title: "Chain follow-up", message: "Follow-up" }));
    });
    await page
      .getByRole("dialog", { name: "Chain first", exact: true })
      .getByRole("button", { name: "确定", exact: true })
      .click();
    const followup = page.getByRole("dialog", { name: "Chain follow-up", exact: true });
    await followup.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === "知道了");
    check(
      (await page.evaluate(() => window.openerFocuses)) === 0,
      "follow-up cannot steal focus back to opener",
    );
    await followup.getByRole("button", { name: "知道了", exact: true }).click();
    await waitFocused("#opener");
  });
  await test("closing does not steal an external focus target chosen by the caller", async () => {
    await page.locator("#opener").focus();
    await page.evaluate(() => {
      void window.reviewApi
        .confirm({ title: "External target", message: "Done" })
        .then(() => document.getElementById("outside").focus());
    });
    await page
      .getByRole("dialog", { name: "External target", exact: true })
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await waitFocused("#outside");
    await page.waitForTimeout(30);
    check((await focused()) === "outside", "external focus must be preserved");
  });
  await test("an unmounted opener is a safe focus fallback", async () => {
    await page.locator("#opener").focus();
    await page.evaluate(() => {
      const opener = document.getElementById("opener");
      const originalFocus = opener.focus.bind(opener);
      window.detachedFocusAttempts = 0;
      opener.focus = (...args) => {
        if (!opener.isConnected) window.detachedFocusAttempts++;
        originalFocus(...args);
      };
      void window.reviewApi.prompt({ title: "Removed opener", message: "Name" });
      window.reviewApi.setShowOpener(false);
    });
    await page
      .getByRole("dialog", { name: "Removed opener", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(30);
    check(
      (await page.evaluate(() => window.detachedFocusAttempts)) === 0,
      "closing cannot focus an unmounted opener",
    );
    check((await page.locator("#opener").count()) === 0, "the original opener stays unmounted");
    await page.locator("#outside").click();
    await page.evaluate(() => window.reviewApi.setShowOpener(true));
    await page.locator("#opener").waitFor();
    check((await focused()) === "outside", "a replacement opener cannot steal outside focus");
  });
  console.log(JSON.stringify({ failures, errors }));
  if (failures.length || errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
