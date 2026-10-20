/* Production app chrome geometry across frames, fullscreen, and sidebar drawers. */
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
const source = String.raw`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {AppShell,AppMainView} from './app/AppShell';
  import {TopBar} from './TopBar';
  import {ResponsiveSidebar,SIDEBAR_NAVIGATION_ID} from './app/ResponsiveSidebar';
  import {Sidebar} from './Sidebar';
  import {I18nProvider} from './i18n';
  import {ToastProvider} from './ui/ToastProvider';
  import {DialogProvider} from './ui/DialogProvider';
  import {saveUILanguage} from './uiLanguage';
  const noop=()=>{};
  window.codeshell={
    cloudAccount:{status:async()=>({state:'signed-out'}),onStatus:()=>noop},
    getUpdaterStatus:async()=>({kind:'idle'}),onUpdaterStatus:()=>noop,
    onWorkspaceChanged:()=>noop,onThemesChanged:()=>noop,
  };
  const recent=Date.now();
  const sidebarProps={
    projects:[],sessions:{__no_repo__:{sessions:[
      {id:'demo-1',title:'界面对齐检查',createdAt:recent-60000,updatedAt:recent-60000},
      {id:'demo-2',title:'整理项目工作区',createdAt:recent-120000,updatedAt:recent-120000},
      {id:'demo-3',title:'检查通知记录',createdAt:recent-180000,updatedAt:recent-180000},
    ]}},activeProjectId:null,activeSessionId:'demo-1',collapsedProjects:new Set(),
    activeProjectPath:null,viewMode:'chat',petPendingCount:0,petRunningCount:0,
    petWidgetVisible:false,sessionHistoryLoading:false,hasMoreSessionHistory:false,
    onSelectProject:noop,onSelectSession:noop,onToggleProject:noop,onAddProject:noop,
    onRemoveProject:noop,onPinProject:noop,onRenameProject:noop,onArchiveAllSessions:noop,
    onNewConversationForProject:noop,onNewConversation:noop,onOpenSearch:noop,
    onNavigate:noop,onOpenProjectConfig:noop,onOpenSettingsPage:noop,onOpenPetPage:noop,
    onTogglePetWidget:noop,onLoadMoreSessionHistory:noop,onRenameSession:noop,
    onPinSession:noop,onArchiveSession:noop,onDeleteSession:noop,
  };
  function Fixture({narrow,fullscreen,collapsed,panel,music}) {
    const [sidebarOpen,setSidebarOpen]=React.useState(!collapsed);
    const [panelOpen,setPanelOpen]=React.useState(panel);
    const [settingsOpen,setSettingsOpen]=React.useState(false);
    React.useEffect(()=>{window.setFixtureSettings=setSettingsOpen},[]);
    const toggleRef=React.useRef(null);
    return <AppShell platformClass="platform-mac" sidebarCollapsed={!sidebarOpen} sidebarIsDialog={narrow} isFullscreen={fullscreen}>
      <TopBar projectName="Demo" sessionTitle="界面对齐检查" busy={false}
        sidebarCollapsed={!sidebarOpen} onToggleSidebar={()=>setSidebarOpen(value=>!value)}
        sidebarToggleRef={toggleRef} sidebarControlsId={SIDEBAR_NAVIGATION_ID} sidebarIsDialog={narrow}
        panelOpen={panelOpen} onTogglePanel={()=>setPanelOpen(value=>!value)}
        isMac isFullscreen={fullscreen} statusAvailable={false}/>
      {music&&<div data-fixture-music className="h-9 shrink-0 border-b border-border/70 px-3 py-2 text-[11px] text-muted-foreground">演示音乐条</div>}
      <div data-app-body data-fixture-body className="relative flex min-h-0 flex-1">
        <ResponsiveSidebar narrow={narrow} open={sidebarOpen} onClose={()=>setSidebarOpen(false)} onAfterClose={noop} toggleRef={toggleRef}>
          <Sidebar {...sidebarProps}/>
        </ResponsiveSidebar>
        <AppMainView lifecycle={null} searchLayer={null}>
          <section data-fixture-chat data-theme-surface="chat" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
              <div className="mx-auto max-w-xl space-y-5 text-[13px] leading-6">
                <p className="ml-auto w-fit rounded-xl bg-muted/70 px-4 py-2">检查整个界面的边框和对齐。</p>
                <p>标题栏、侧边栏和内容区共享同一条内边界。<br/>这里是用于布局验证的演示消息。</p>
              </div>
            </div>
            <div data-theme-surface="composer" className="m-4 rounded-xl border border-border p-3 text-xs text-muted-foreground">发送消息…</div>
          </section>
        </AppMainView>
        {panelOpen&&!narrow&&<aside data-fixture-panel data-theme-surface="panel" className="flex w-64 shrink-0 flex-col border-l border-border/70">
          <div className="flex h-[var(--cs-titlebar-height,2.75rem)] shrink-0 items-center border-b border-border/70 px-3 text-xs">文件</div>
          <div className="p-3 text-xs text-muted-foreground">demo-project<br/><span className="pl-3">README.md</span></div>
        </aside>}
      </div>
      {settingsOpen&&<section data-fixture-settings className="absolute inset-0 bg-background p-6">演示设置页面</section>}
    </AppShell>;
  }
  const root=createRoot(window.document.getElementById('root'));
  window.renderFixture=config=>{
    const html=window.document.documentElement;
    html.classList.toggle('dark',config.dark);
    html.style.setProperty('--cs-frame-width',config.frame+'px');
    html.style.setProperty('--cs-frame-radius',config.radius+'px');
    html.style.setProperty('--cs-frame-color',config.image?'var(--cs-primary)':'var(--cs-border)');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g"><stop stop-color="#dbeafe"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1200v800H0z"/></svg>';
    html.style.setProperty('--cs-surface-window-image',config.image?'url("data:image/svg+xml,'+encodeURIComponent(svg)+'")':'none');
    html.style.setProperty('--cs-surface-window-opacity',config.image?'0.3':'0');
    saveUILanguage('zh');
    root.render(<React.StrictMode><I18nProvider><ToastProvider><DialogProvider>
      <Fixture key={JSON.stringify(config)} {...config}/>
    </DialogProvider></ToastProvider></I18nProvider></React.StrictMode>);
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  outfile: path.join(tmpdir(), "codeshell-app-shell-fixture.js"),
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".wav": "dataurl" },
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
const screenshots = await mkdtemp(path.join(tmpdir(), "codeshell-app-chrome-ui-"));
const cases = [
  { name: "mac-light", frame: 0, radius: 12, dark: false, panel: true },
  { name: "mac-image-frame-2", frame: 2, radius: 12, dark: false, panel: true, image: true },
  { name: "mac-dark-frame-3", frame: 3, radius: 16, dark: true, panel: true },
  { name: "mac-fullscreen", frame: 3, radius: 16, dark: true, fullscreen: true, panel: true },
  { name: "mac-collapsed", frame: 2, radius: 12, dark: false, collapsed: true, panel: false },
  {
    name: "narrow-drawer",
    frame: 3,
    radius: 16,
    dark: true,
    narrow: true,
    panel: false,
    music: true,
  },
];
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} should equal ${expected}`);
try {
  for (const config of cases) {
    const viewport = { width: config.narrow ? 390 : 1100, height: 720 };
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(`${config.name}: ${error.message}`);
    });
    await page.route("https://chrome.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await page.goto("https://chrome.test/");
    await page.addStyleTag({ content: css });
    for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css"))) {
      await page.addStyleTag({ content: file.text });
    }
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
    });
    await page.evaluate((props) => window.renderFixture(props), config);
    const header = page.locator('[data-theme-surface="titlebar"]');
    await header.waitFor();
    const inset = config.fullscreen ? 0 : config.frame;
    const head = await header.boundingBox();
    near(head.x, inset, `${config.name} titlebar left inset`);
    near(head.y, inset, `${config.name} titlebar top inset`);
    near(head.width, viewport.width - inset * 2, `${config.name} titlebar width`);
    near(head.height, 44, `${config.name} titlebar height`);
    const body = await page.locator("[data-fixture-body]").boundingBox();
    near(
      body.y,
      head.y + head.height + (config.music ? 36 : 0),
      `${config.name} body joins chrome separator`,
    );
    near(body.x, inset, `${config.name} body left inset`);
    near(body.x + body.width, viewport.width - inset, `${config.name} body right inset`);
    near(body.y + body.height, viewport.height - inset, `${config.name} body bottom inset`);
    const innerRadius = await page
      .locator("[data-app-shell-content]")
      .evaluate((element) =>
        Number.parseFloat(window.getComputedStyle(element).borderTopLeftRadius),
      );
    near(
      innerRadius,
      config.fullscreen ? 0 : Math.max(0, config.radius - inset),
      `${config.name} content radius follows frame inset`,
    );
    assert.equal(
      await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      `${config.name} titlebar does not overflow horizontally`,
    );
    const toggle = page.locator('[data-sidebar-action="toggle"]');
    const toggleBox = await toggle.boundingBox();
    assert.ok(
      config.fullscreen ? toggleBox.x < 40 : toggleBox.x >= 80,
      `${config.name} macOS traffic-light safe area follows fullscreen state`,
    );
    const chat = await page.locator("[data-fixture-chat]").boundingBox();
    const sidebar = page.locator('[data-theme-surface="sidebar"]');
    if (config.collapsed) {
      assert.equal(await sidebar.count(), 0, "collapsed sidebar releases its layout column");
      near(chat.x, inset, "collapsed chat starts at the inner frame");
      await toggle.click();
      await sidebar.waitFor();
      near((await sidebar.boundingBox()).width, 240, "opening sidebar uses the shared width");
    } else if (config.narrow) {
      const drawer = page.locator(`#codeshell-sidebar-navigation[role="dialog"]`);
      await drawer.waitFor();
      const box = await drawer.boundingBox();
      near(box.y, body.y, "drawer starts below titlebar and optional music strip");
      assert.ok(box.x >= inset, "drawer respects the left frame safe area");
      assert.ok(box.x + box.width <= viewport.width - inset, "drawer fits the narrow window");
      assert.ok(
        box.y + box.height <= viewport.height - inset + 1,
        "drawer respects the bottom frame",
      );
      near((await sidebar.boundingBox()).width, box.width, "drawer and sidebar share their width");
      assert.equal(
        await sidebar.evaluate((element) =>
          Number.parseFloat(window.getComputedStyle(element).borderRightWidth),
        ),
        0,
        "drawer child sidebar does not duplicate the host separator",
      );
      assert.equal(
        await drawer.evaluate((element) =>
          Number.parseFloat(window.getComputedStyle(element).borderRightWidth),
        ),
        1,
        "drawer host owns one vertical separator",
      );
      near(chat.x, inset, "modal drawer does not shift the chat column");
      const music = page.locator("[data-fixture-music]");
      async function drawerFollowsBody(label) {
        await page.waitForFunction(() => {
          const body = window.document.querySelector("[data-fixture-body]").getBoundingClientRect();
          const drawer = window.document
            .querySelector('#codeshell-sidebar-navigation[role="dialog"]')
            .getBoundingClientRect();
          return Math.abs(body.top - drawer.top) <= 1;
        });
        near(
          (await drawer.boundingBox()).y,
          (await page.locator("[data-fixture-body]").boundingBox()).y,
          label,
        );
      }
      await music.evaluate((element) => {
        element.style.height = "60px";
      });
      await drawerFollowsBody("open drawer follows a taller music strip without remounting");
      await music.evaluate((element) => {
        element.style.display = "none";
      });
      await drawerFollowsBody("open drawer follows a hidden music strip without remounting");
      await music.evaluate((element) => {
        element.style.height = "";
        element.style.display = "";
      });
      await drawerFollowsBody("open drawer follows the restored music strip");
    } else {
      const box = await sidebar.boundingBox();
      near(box.x, inset, `${config.name} sidebar left inset`);
      near(box.width, 240, `${config.name} sidebar shared width`);
      near(box.y, body.y, `${config.name} sidebar top separator`);
      near(box.x + box.width, chat.x, `${config.name} sidebar and chat separator`);
      const titlebarSidebar = await page.locator("[data-titlebar-sidebar]").boundingBox();
      near(
        titlebarSidebar.x + titlebarSidebar.width,
        box.x + box.width,
        `${config.name} titlebar and sidebar vertical separators align`,
      );
      near(box.y + box.height, body.y + body.height, `${config.name} sidebar bottom alignment`);
      if (config.panel) {
        const panel = await page.locator("[data-fixture-panel]").boundingBox();
        near(chat.x + chat.width, panel.x, `${config.name} chat and panel separator`);
        near(panel.x + panel.width, viewport.width - inset, `${config.name} panel right inset`);
      }
    }
    assert.equal(
      await page
        .locator('[data-theme-surface="window"]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      `${config.name} app shell does not overflow`,
    );
    if (config.name === "mac-image-frame-2") {
      await page.evaluate(() => window.setFixtureSettings(true));
      const settings = page.locator("[data-fixture-settings]");
      await settings.waitFor();
      const box = await settings.boundingBox();
      const content = await page.locator("[data-app-shell-content]").boundingBox();
      near(box.x, content.x, "settings overlay follows the inner frame left edge");
      near(box.y, content.y, "settings overlay follows the inner frame top edge");
      near(box.width, content.width, "settings overlay follows the inner frame width");
      near(box.height, content.height, "settings overlay follows the inner frame height");
      await page.evaluate(() => window.setFixtureSettings(false));
      await settings.waitFor({ state: "hidden" });
      await header.waitFor();
    }
    const output = path.join(screenshots, `${config.name}.png`);
    await page.screenshot({ path: output });
    if (config.narrow) {
      await page.keyboard.press("Escape");
      await page
        .locator('#codeshell-sidebar-navigation[role="dialog"]')
        .waitFor({ state: "hidden" });
      await page.waitForFunction(
        (element) => window.document.activeElement === element,
        await toggle.elementHandle(),
      );
      assert.equal(
        await toggle.evaluate((element) => window.document.activeElement === element),
        true,
        "drawer close restores the persistent titlebar trigger",
      );
    }
    assert.deepEqual(errors, [], `${config.name} has no browser page errors`);
    await page.close();
  }
  console.log(
    `AppShell browser smoke passed: ${cases.length} production chrome layouts; screenshots: ${screenshots}`,
  );
} finally {
  await browser.close();
}
