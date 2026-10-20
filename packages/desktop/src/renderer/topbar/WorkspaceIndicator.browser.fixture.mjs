/* Real IntersectionObserver, production menu layout, and controlled bridge requests. */
/* global window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {WorkspaceIndicator} from './topbar/WorkspaceIndicator';
  import {I18nProvider} from './i18n';
  import {saveUILanguage} from './uiLanguage';
  const workspace={root:'/fixture/main',kind:'main'};
  const rows=Array.from({length:40},(_,index)=>({
    path:index===0?workspace.root:'/fixture/worktree-'+index,
    branch:index===0?'main':'feature-'+index,
    head:'head-'+index,
    isMain:index===0,
    isManaged:index===0,
  }));
  const stats=window.fixture={requests:[],pending:[],active:0,maxActive:0};
  window.codeshell={
    getSessionWorkspaceAuthority:async()=>({
      workspace,projectId:'project',mainRootId:'root',mainRoot:workspace.root,
      mainRootName:'Fixture',rootStatus:'ok',
    }),
    getSessionGitBranches:async()=>({isRepo:true,current:'main',branches:['main']}),
    listSessionWorktrees:async()=>({current:workspace,mainRoot:workspace.root,worktrees:rows}),
    getSessionWorktreeDiff:(_session,path)=>new Promise((resolve,reject)=>{
      stats.requests.push(path);
      stats.active+=1;
      stats.maxActive=Math.max(stats.maxActive,stats.active);
      stats.pending.push({path,finish:()=>{
        stats.active-=1;
        if(path==='/fixture/worktree-1') reject(new Error('fixture unavailable'));
        else resolve({changedFiles:0,aheadCommits:1,hasUncommittedChanges:false});
      }});
    }),
  };
  window.finishPending=()=>stats.pending.splice(0).forEach(request=>request.finish());
  window.setFixtureLanguage=saveUILanguage;
  saveUILanguage('en');
  createRoot(document.getElementById('root')).render(
    <React.StrictMode><I18nProvider>
      <main className="fixed inset-0 bg-background p-4">
        <div id="workspace-host">
          <WorkspaceIndicator sessionId="fixture-session" projectPath="/fixture/main" projectName="Fixture"/>
        </div>
      </main>
    </I18nProvider></React.StrictMode>
  );
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
});
const cssPath = path.join(renderer, "styles/tailwind.css");
const compiled = await compile(await readFile(cssPath, "utf8"), {
  base: path.dirname(cssPath),
  from: cssPath,
  onDependency() {},
});
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx,html}", negated: false }],
});
const css = compiled.build([
  ...scanner.scan(),
  ...scanner.scanFiles([{ content: source, extension: "tsx" }]),
]);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://workspace.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://workspace.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const opener = page.locator("#workspace-host button").first();
  const scroll = page.locator("[data-workspace-scroll]");
  const statsToggle = page.getByRole("button", { name: "Change stats", exact: true });
  const externalGroup = page.getByRole("button", { name: "External worktrees (39)", exact: true });
  const screenshots = await mkdtemp(path.join(tmpdir(), "codeshell-workspace-ui-"));
  async function screenshot(name) {
    await page.evaluate(() => window.setFixtureLanguage("zh"));
    await page.getByRole("button", { name: "改动统计", exact: true }).waitFor();
    const output = path.join(screenshots, name);
    await page.getByRole("dialog").screenshot({ path: output });
    await page.evaluate(() => window.setFixtureLanguage("en"));
    await statsToggle.waitFor();
    return output;
  }
  const snapshot = () =>
    page.evaluate(() => ({
      requests: [...window.fixture.requests],
      active: window.fixture.active,
      maxActive: window.fixture.maxActive,
    }));
  async function drain() {
    for (let round = 0; round < 30; round += 1) {
      await page.evaluate(() => window.finishPending());
      // Allow real layout, IntersectionObserver and React updates to finish.
      await page.waitForTimeout(50);
      if ((await snapshot()).active === 0) return;
    }
    assert.fail("Visible worktree checks did not settle");
  }
  async function close() {
    await page.keyboard.press("Escape");
    await scroll.waitFor({ state: "hidden" });
  }
  async function open() {
    await opener.click();
    await scroll.waitFor({ state: "visible" });
  }

  await opener.waitFor();
  assert.equal((await snapshot()).requests.length, 0, "closed menu performs no diff checks");
  await open();
  await externalGroup.waitFor();
  assert.equal(
    await externalGroup.getAttribute("aria-expanded"),
    "false",
    "external rows start collapsed",
  );
  assert.equal(await statsToggle.getAttribute("aria-pressed"), "false", "stats start disabled");
  assert.equal(
    await page.getByTitle("/fixture/worktree-1", { exact: true }).count(),
    0,
    "collapsed external rows are not mounted",
  );
  await page.waitForTimeout(150);
  assert.equal(
    (await snapshot()).requests.length,
    0,
    "opening the default menu performs no diff checks",
  );
  assert.doesNotMatch(
    await scroll.textContent(),
    /checking/,
    "default rows show no checking label",
  );
  const defaultScreenshot = await screenshot("workspace-default.png");

  await externalGroup.click();
  await page.getByTitle("/fixture/worktree-1", { exact: true }).waitFor();
  assert.equal(
    await externalGroup.getAttribute("aria-expanded"),
    "true",
    "external group expands on demand",
  );
  await page.waitForTimeout(150);
  assert.equal(
    (await snapshot()).requests.length,
    0,
    "expanding external rows still performs no diff checks",
  );
  await statsToggle.click();
  await page.waitForFunction(() => window.fixture.active === 2);
  await drain();
  const initial = await snapshot();
  assert.ok(initial.requests.length >= 2, "initial visible rows are checked");
  assert.ok(initial.requests.length < 40, "first open does not check every worktree");
  assert.equal(initial.requests.includes("/fixture/worktree-39"), false, "last row stays lazy");
  assert.equal(initial.maxActive, 2, "requests are capped at two in flight");
  const failedRow = page.getByTitle("/fixture/worktree-1", { exact: true }).locator("../..");
  assert.match(await failedRow.textContent(), /Unavailable/, "failed checks have a terminal label");
  assert.doesNotMatch(await failedRow.textContent(), /checking/, "failed rows leave checking");
  const statsScreenshot = await screenshot("workspace-stats.png");

  await close();
  await open();
  await page.waitForTimeout(150);
  assert.deepEqual(
    (await snapshot()).requests,
    initial.requests,
    "reopening reuses recent success and failure results",
  );

  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(() => window.fixture.active > 0);
  await drain();
  const bottom = await snapshot();
  assert.ok(bottom.requests.includes("/fixture/worktree-39"), "scrolling checks the last row");
  assert.equal(
    bottom.requests.includes("/fixture/worktree-20"),
    false,
    "jumping to the bottom skips invisible middle rows",
  );

  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await page.waitForFunction(() => window.fixture.active === 2);
  await close();
  const closed = await snapshot();
  await drain();
  assert.deepEqual(
    (await snapshot()).requests,
    closed.requests,
    "closing prevents queued rows from starting when active checks finish",
  );

  await open();
  await page.waitForTimeout(150);
  assert.deepEqual((await snapshot()).requests, closed.requests, "top rows remain cached");
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(150);
  const final = await snapshot();
  assert.deepEqual(final.requests, closed.requests, "recent bottom summaries remain cached");
  assert.equal(final.maxActive, 2, "scrolling and reopening retain the concurrency bound");

  await page.setViewportSize({ width: 390, height: 650 });
  const dialog = page.getByRole("dialog");
  await page.waitForFunction(
    (element) => {
      const box = element.getBoundingClientRect();
      return (
        box.left >= 8 &&
        box.top >= 8 &&
        box.right <= window.innerWidth - 8 &&
        box.bottom <= window.innerHeight - 8
      );
    },
    await dialog.elementHandle(),
  );
  assert.equal(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    "390px window has no horizontal menu overflow",
  );
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => window.document.documentElement.classList.add("dark"));
  const darkScreenshot = await screenshot("workspace-dark-narrow.png");
  assert.deepEqual(
    (await snapshot()).requests,
    final.requests,
    "theme and viewport changes reuse the visible summary cache",
  );
  assert.deepEqual(errors, [], "production WorkspaceIndicator has no browser page errors");
  console.log(
    `WorkspaceIndicator browser smoke passed: 0 default checks; ${initial.requests.length}/40 enabled checks; ` +
      `${final.requests.length} total; max concurrency ${final.maxActive}; no page errors.`,
  );
  console.log(
    `Default UI: ${defaultScreenshot}\nEnabled stats UI: ${statsScreenshot}\nDark narrow UI: ${darkScreenshot}`,
  );
} finally {
  await browser.close();
}
