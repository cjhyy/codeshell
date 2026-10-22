/** Production Session identity menus, with an owned bridge-free offline page.
 * node scripts/run-isolated-node-smoke.mjs packages/desktop/src/renderer/topbar/SessionDigitalHumanControl.browser.fixture.mjs
 */
/* global document, window, requestAnimationFrame, innerWidth, innerHeight */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
const output =
  process.env.CODESHELL_SESSION_PROFILE_QA_DIR ||
  (await mkdtemp(path.join(tmpdir(), "codeshell-session-profile-ui-")));
await mkdir(output, { recursive: true });

const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {SessionDigitalHumanControl} from './topbar/SessionDigitalHumanControl';
import {TopBar} from './TopBar';
import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';
const root=createRoot(document.getElementById('root'));
let current={};
window.actions=[];
const onProfileChange=name=>window.actions.push(name);
const noop=()=>{};
function Fixture(props){
  return <main className="fixed inset-0 bg-background p-3 text-foreground" data-fixture-session={props.sessionId ?? 'none'}>
    {props.topBar?<div id="topbar-host"><TopBar projectName="Fixture" projectPath={null}
      sessionId={props.sessionId} sessionTitle="Work session" workspaceProfile={props.profile}
      workspaceProfiles={props.profiles} workspaceProfileSwitchDisabled={props.disabled}
      onWorkspaceProfileChange={props.readOnly?undefined:onProfileChange}
      busy={false} sidebarCollapsed onToggleSidebar={noop} panelOpen={false}
      onTogglePanel={noop} isMac={false} isFullscreen={false} panelAvailable={false}
      statusAvailable={false}/></div>:<header className="flex min-w-0 items-center gap-2 border-b border-border pb-3">
      <span className="min-w-0 flex-1 truncate text-sm">{props.lang==='zh'?'当前项目 / 普通工作会话':'Current project / Work session'}</span>
      <SessionDigitalHumanControl sessionId={props.sessionId} profile={props.profile}
        profiles={props.profiles} disabled={props.disabled}
        onProfileChange={props.readOnly?undefined:onProfileChange}/>
    </header>}
    <button id="outside" className="mt-8 rounded-md border border-border px-3 py-2">Outside</button>
  </main>;
}
function render(){
  saveUILanguage(current.lang);
  document.documentElement.classList.toggle('dark',current.theme==='dark');
  flushSync(()=>root.render(<I18nProvider key={current.lang}><Fixture {...current}/></I18nProvider>));
}
window.mountFixture=props=>{window.actions=[];current={lang:'zh',sessionId:'session',profile:null,profiles:[],...props};render();};
window.patchFixture=props=>{current={...current,...props};render();};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
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
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin" &&
    existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const reports = [];
const errors = [];
const externalRequests = [];
const profiles = [
  { name: "product-manager", label: "产品经理", description: "负责产品目标与交付标准" },
  { name: "ui-designer", label: "UI 设计师", description: "负责体验设计与视觉规范" },
];
const labels = {
  zh: {
    actions: "会话操作",
    use: "使用数字人继续…",
    current: "查看当前数字人：产品经理",
    change: "更换数字人",
    default: "使用项目默认",
  },
  en: {
    actions: "Session actions",
    use: "Continue with a digital human…",
    current: "View current digital human: 产品经理",
    change: "Change digital human",
    default: "Use project default",
  },
};
const context = await browser.newContext({ viewport: { width: 940, height: 700 } });
await context.route("**/*", (route) => {
  if (route.request().url() === "http://session-digital-human.test/") {
    return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  }
  externalRequests.push(route.request().url());
  return route.abort("blockedbyclient");
});
try {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://session-digital-human.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  async function mount(props) {
    await page.evaluate((value) => window.mountFixture(value), props);
    await page.locator(`[data-fixture-session="${props.sessionId ?? "session"}"]`).waitFor();
    await settle();
  }
  async function settle() {
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="menu"]')].every((element) =>
        element
          .getAnimations()
          .every((animation) => ["finished", "idle"].includes(animation.playState)),
      ),
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function menusFit() {
    await settle();
    const boxes = await page.locator('[role="menu"]').evaluateAll((elements) =>
      elements.map((element) => ({
        rect: element.getBoundingClientRect().toJSON(),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      })),
    );
    for (const box of boxes) {
      assert.ok(box.rect.left >= 8 && box.rect.right <= box.viewportWidth - 8, JSON.stringify(box));
      assert.ok(
        box.rect.top >= 8 && box.rect.bottom <= box.viewportHeight - 8,
        JSON.stringify(box),
      );
      assert.ok(box.scrollWidth <= box.clientWidth + 1, JSON.stringify(box));
    }
    return boxes;
  }
  async function closeMenus() {
    for (let attempt = 0; attempt < 3 && (await page.getByRole("menu").count()) > 0; attempt += 1) {
      await page.keyboard.press("Escape");
    }
    await waitNoMenus();
  }
  async function waitNoMenus() {
    await page.waitForFunction(() => document.querySelector('[role="menu"]') === null);
  }
  async function openRoles(lang, bound = false) {
    const trigger = page.getByRole("button", {
      name: bound ? labels[lang].current : labels[lang].actions,
      exact: true,
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const submenu = page.getByRole("menuitem", {
      name: bound ? labels[lang].change : labels[lang].use,
      exact: true,
    });
    await submenu.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitemradio", { name: /产品经理/ }).waitFor();
    return trigger;
  }

  for (const lang of ["zh", "en"]) {
    for (const width of [940, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await page.mouse.move(width - 1, 699);
      await mount({ lang, sessionId: `${lang}-${width}-ordinary`, profiles });
      assert.equal(
        await page
          .getByRole("button", { name: /^(查看当前数字人|View current digital human)/ })
          .count(),
        0,
        "an ordinary Session has no identity chip even when the library is populated",
      );
      await openRoles(lang);
      const ordinaryBoxes = await menusFit();
      const ordinaryScreenshot = path.join(output, `ordinary-${lang}-${width}.png`);
      await page.screenshot({ path: ordinaryScreenshot });
      const selected = page.getByRole("menuitemradio", { name: /产品经理/ });
      await selected.focus();
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.actions), ["product-manager"]);
      await waitNoMenus();
      assert.equal(
        await page
          .getByRole("button", { name: labels[lang].actions, exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
        "keyboard selection restores focus to the Session menu opener",
      );

      await mount({
        lang,
        sessionId: `${lang}-${width}-bound`,
        profile: "product-manager",
        profiles,
        theme: width === 390 ? "dark" : "light",
      });
      const identity = page.getByRole("button", { name: labels[lang].current, exact: true });
      await identity.click();
      await page.getByText(profiles[0].description, { exact: true }).waitFor();
      const boundBoxes = await menusFit();
      const boundScreenshot = path.join(output, `bound-${lang}-${width}.png`);
      await page.screenshot({ path: boundScreenshot });
      await page.getByRole("menuitem", { name: new RegExp(`^${labels[lang].default}`) }).click();
      assert.deepEqual(await page.evaluate(() => window.actions), [""]);
      await waitNoMenus();

      await identity.click();
      await page.getByRole("menu").waitFor();
      await page.evaluate(
        (sessionId) => window.patchFixture({ sessionId }),
        `${lang}-${width}-next`,
      );
      await waitNoMenus();
      assert.deepEqual(
        await page.evaluate(() => window.actions),
        [""],
        "navigation changes no binding",
      );
      reports.push({ lang, width, ordinaryBoxes, boundBoxes, ordinaryScreenshot, boundScreenshot });
    }
  }

  await page.setViewportSize({ width: 390, height: 700 });
  await mount({ lang: "zh", sessionId: "missing-profile", profile: "retired-human", profiles: [] });
  const missing = page.getByRole("button", { name: "查看当前数字人：retired-human", exact: true });
  await missing.click();
  await menusFit();
  const missingScreenshot = path.join(output, "missing-profile-zh-390.png");
  await page.screenshot({ path: missingScreenshot });
  await page.getByRole("menuitem", { name: new RegExp(`^${labels.zh.default}`) }).click();
  assert.deepEqual(
    await page.evaluate(() => window.actions),
    [""],
    "a missing library entry can be unbound",
  );

  await mount({
    lang: "zh",
    sessionId: "busy-profile",
    profile: "product-manager",
    profiles,
    disabled: true,
  });
  const busy = page.getByRole("button", { name: labels.zh.current, exact: true });
  await busy.waitFor();
  if ((await busy.isDisabled()) || (await busy.getAttribute("aria-disabled")) === "true") {
    assert.equal(await page.getByRole("menu").count(), 0);
  } else {
    await busy.click();
    let disabledActions = 0;
    for (const item of await page.getByRole("menuitem").all()) {
      const text = await item.textContent();
      if (text?.includes(labels.zh.change) || text?.includes(labels.zh.default)) {
        assert.equal(
          await item.getAttribute("aria-disabled"),
          "true",
          "busy identity actions are disabled",
        );
        disabledActions += 1;
      }
    }
    assert.equal(disabledActions, 2, "both changing and unbinding are disabled while busy");
    await closeMenus();
  }
  assert.deepEqual(
    await page.evaluate(() => window.actions),
    [],
    "busy Session cannot change identity",
  );

  await mount({ lang: "zh", sessionId: "empty-library", profiles: [] });
  assert.equal(
    await page
      .getByRole("button", { name: /^(查看当前数字人|View current digital human)/ })
      .count(),
    0,
  );

  // Keep callbacks, Session/title and the profiles reference stable across patches:
  // only the changed identity prop may invalidate TopBar's memo comparator.
  await page.setViewportSize({ width: 940, height: 700 });
  await mount({
    lang: "zh",
    sessionId: "memo-session",
    profile: "product-manager",
    profiles,
    topBar: true,
  });
  await page.getByRole("button", { name: labels.zh.current, exact: true }).waitFor();
  await page.evaluate(() => window.patchFixture({ profile: "ui-designer" }));
  await page.getByRole("button", { name: "查看当前数字人：UI 设计师", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: labels.zh.current, exact: true }).count(),
    0,
    "TopBar refreshes when only the bound profile changes",
  );
  const renamedProfiles = profiles.map((profile) =>
    profile.name === "ui-designer" ? { ...profile, label: "体验设计负责人" } : profile,
  );
  await page.evaluate((next) => window.patchFixture({ profiles: next }), renamedProfiles);
  const renamed = page.getByRole("button", { name: "查看当前数字人：体验设计负责人", exact: true });
  await renamed.waitFor();
  await page.evaluate(() => window.patchFixture({ disabled: true }));
  await renamed.click();
  for (const name of [labels.zh.change, labels.zh.default]) {
    const item = page.getByRole("menuitem", { name: new RegExp(`^${name}`) });
    assert.equal(
      await item.getAttribute("aria-disabled"),
      "true",
      "TopBar refreshes when only switching availability changes",
    );
  }
  await closeMenus();
  await page.evaluate(() => window.patchFixture({ disabled: false }));
  await renamed.click();
  assert.notEqual(
    await page
      .getByRole("menuitem", { name: labels.zh.change, exact: true })
      .getAttribute("aria-disabled"),
    "true",
  );
  await closeMenus();
  await page.evaluate(() => window.patchFixture({ readOnly: true }));
  await renamed.click();
  assert.equal(
    await page.getByRole("menuitem", { name: labels.zh.change, exact: true }).count(),
    0,
    "TopBar removes actions when only the mutation callback is removed",
  );
  await closeMenus();
  await page.evaluate(() => window.patchFixture({ readOnly: false }));
  await renamed.click();
  await page.getByRole("menuitem", { name: labels.zh.change, exact: true }).waitFor();
  await closeMenus();

  const topBarScreenshots = [];
  for (const width of [940, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await settle();
    const bounds = await page.locator("#topbar-host header").evaluate((element) => ({
      rect: element.getBoundingClientRect().toJSON(),
      viewportWidth: innerWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    assert.ok(
      bounds.rect.left >= 0 && bounds.rect.right <= bounds.viewportWidth,
      JSON.stringify(bounds),
    );
    assert.ok(
      bounds.scrollWidth <= bounds.clientWidth + 1,
      "complete TopBar has no horizontal overflow",
    );
    const screenshot = path.join(output, `topbar-bound-zh-${width}.png`);
    await page.screenshot({ path: screenshot });
    topBarScreenshots.push(screenshot);
  }
  assert.deepEqual(
    await page.evaluate(() => window.actions),
    [],
    "memo prop updates do not mutate identity",
  );
  assert.deepEqual(errors, [], "production identity menus have no browser errors");
  assert.deepEqual(externalRequests, [], "identity controls request no external resources");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { reports, missingScreenshot, topBarScreenshots, errors, externalRequests },
      null,
      2,
    ),
  );
  console.log(
    "Session digital-human browser smoke passed: ordinary, bound, missing, busy, navigation, keyboard, TopBar memo updates and zh/en narrow layouts.",
  );
  console.log(`Screenshots and report: ${output}`);
} finally {
  await context.close();
  await browser.close();
}
