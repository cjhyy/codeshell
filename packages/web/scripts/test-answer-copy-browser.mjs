/** Owned synthetic answers only; clipboard writes are captured in memory. */
/* global window, document, navigator */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-answer-copy-"));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{AnswerContent}from'./AnswerContent';import{MessageContent}from'./MessageContent';
window.copied=[];window.copyFails=false;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.copyFails)throw Error('Owned clipboard unavailable');window.copied.push(text);}},configurable:true});
function Fixture(){const[scope,setScope]=React.useState('first'),[pending,setPending]=React.useState(false),[partial,setPartial]=React.useState(false);window.setCopyScope=setScope;window.setCopyPending=setPending;window.setCopyPartial=setPartial;
const items=[{kind:'assistant',id:'one',text:'**Final first.**',reasoning:'NOT_COPIED_REASONING',done:true},{kind:'assistant',id:'two',text:'Final second.\\n\\n\`\`\`ts\\nconst result = 1;\\n\`\`\`',reasoning:'',done:true},{kind:'assistant',id:'long',text:scope+' preview',reasoning:'',textDetailRef:scope+'/full',done:!pending}];
return <main><MessageContent text='NOT_COPIED_PROCESS' showCopy={false}/><p>NOT_COPIED_TOOL_LOG</p><AnswerContent items={items} pending={pending} partial={partial} detailScope={scope} loadHistoryDetail={async ref=>{const r=await fetch('/detail?ref='+encodeURIComponent(ref));if(!r.ok)throw Error('Owned detail failed');return r.json();}}/></main>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"development"' },
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const errors = [],
  blocked = [],
  reports = [];
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: theme,
      serviceWorkers: "block",
    });
    const reads = [];
    let held;
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://answer-copy-owned.test" || route.request().method() !== "GET") {
        blocked.push(url.pathname);
        return route.abort();
      }
      if (url.pathname === "/" && !url.search)
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
        });
      const ref = url.searchParams.get("ref");
      if (
        url.pathname !== "/detail" ||
        !["first/full", "late/full", "second/full"].includes(ref) ||
        [...url.searchParams.keys()].join() !== "ref"
      ) {
        blocked.push(url.pathname);
        return route.abort();
      }
      reads.push(ref);
      if (ref === "late/full") {
        held = route;
        return;
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ text: "FULL_" + ref }),
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://answer-copy-owned.test/");
    for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
    });
    const reply = (label) => page.getByRole("button", { name: label, exact: true });
    const base = "**Final first.**\n\nFinal second.\n\n```ts\nconst result = 1;\n```\n\n";
    await reply("复制已显示内容").waitFor();
    assert.equal(await page.locator(".message-actions .message-copy").count(), 1);
    assert.equal(await reply("复制代码").count(), 1);
    await reply("复制已显示内容").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), base + "first preview");
    assert.deepEqual(reads, [], "copying a preview must not fetch its hidden body");
    await reply("复制代码").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), "const result = 1;");
    await page.getByText("展开完整内容", { exact: true }).click();
    await page.getByText("FULL_first/full", { exact: true }).waitFor();
    await reply("复制回复").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), base + "FULL_first/full");
    assert.deepEqual(reads, ["first/full"]);
    await page.getByText("收起完整内容", { exact: true }).click();
    await reply("复制已显示内容").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), base + "first preview");
    await page.evaluate(() => window.setCopyPending(true));
    await page.waitForFunction(
      () => document.querySelectorAll(".message-actions .message-copy").length === 0,
    );
    await page.evaluate(() => window.setCopyPending(false));
    await reply("复制已显示内容").waitFor();
    await page.evaluate(() => window.setCopyScope("late"));
    await page.getByText("late preview", { exact: true }).waitFor();
    await page.getByText("展开完整内容", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".message-detail-status") !== null);
    for (let i = 0; !held && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(held);
    await reply("复制已显示内容").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), base + "late preview");
    await page.evaluate(() => window.setCopyScope("second"));
    await held.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ text: "LATE_UNMOUNTED_BODY" }),
    });
    await page.getByText("second preview", { exact: true }).waitFor();
    await reply("复制已显示内容").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), base + "second preview");
    assert.equal(await page.getByText("LATE_UNMOUNTED_BODY", { exact: true }).count(), 0);
    await page.getByText("展开完整内容", { exact: true }).click();
    await page.getByText("FULL_second/full", { exact: true }).waitFor();
    await reply("复制回复").waitFor();
    await page.evaluate(() => window.setCopyPartial(true));
    await reply("复制已显示内容").click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), base + "FULL_second/full");
    await page.evaluate(() => {
      window.copyFails = true;
    });
    await reply("复制已显示内容").click();
    await page.getByText("复制失败", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        window.copied.some((text) => /NOT_COPIED|LATE_UNMOUNTED/.test(text)),
      ),
      false,
    );
    assert.equal(await page.locator(".message-actions .message-copy").count(), 1);
    await page.screenshot({ path: path.join(output, theme + "-answer-copy.png") });
    reports.push({
      theme,
      singleReplyAction: true,
      onlyVisibleFinalText: true,
      codeCopyKept: true,
      noImplicitDetailFetch: true,
      lateBodyDiscarded: true,
      pendingActionHidden: true,
      reads: reads.length,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ ok: true, reports, errors, blocked }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, output, reports }));
} finally {
  await browser.close();
}
