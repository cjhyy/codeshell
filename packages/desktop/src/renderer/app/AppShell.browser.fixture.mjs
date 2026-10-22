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
  import {WindowTitleBar} from './app/WindowTitleBar';
  import {TopBar} from './TopBar';
  import {ResponsiveSidebar,SIDEBAR_NAVIGATION_ID} from './app/ResponsiveSidebar';
  import {Sidebar} from './Sidebar';
  import {I18nProvider} from './i18n';
  import {ToastProvider} from './ui/ToastProvider';
  import {DialogProvider} from './ui/DialogProvider';
  import {saveUILanguage} from './uiLanguage';
  import {applyThemePack} from './theme';
  const noop=()=>{};
  window.codeshell={
    cloudAccount:{status:async()=>({state:'signed-out'}),onStatus:()=>noop},
    getUpdaterStatus:async()=>({kind:'idle'}),onUpdaterStatus:()=>noop,
    getWindowZoomFactor:()=>window.fixtureZoom??1,
    setWindowTitleBarOverlay:async()=>{},
    onWorkspaceChanged:()=>noop,onThemesChanged:()=>noop,
  };
  const recent=Date.now();
  const activeTasks={kind:'task_list',id:'titlebar-layout-tasks',tasks:[
    {id:'one',subject:'检查窗口安全区',status:'completed'},
    {id:'two',subject:'检查主题边框',status:'completed'},
    {id:'three',subject:'检查窄屏操作',status:'in_progress'},
  ]};
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
  function Fixture({platform,narrow,fullscreen,collapsed,panel,music,controlsLeft,controlsRight,viewportWidth,activeChat}) {
    const [sidebarOpen,setSidebarOpen]=React.useState(!collapsed);
    const [panelOpen,setPanelOpen]=React.useState(panel);
    const [settingsOpen,setSettingsOpen]=React.useState(false);
    React.useEffect(()=>{window.setFixtureSettings=setSettingsOpen},[]);
    React.useLayoutEffect(()=>{
      const shell=window.document.querySelector('[data-app-shell]');
      if(controlsLeft!==undefined||controlsRight!==undefined){
        shell.style.setProperty('--cs-native-titlebar-x',(controlsLeft??0)+'px');
        shell.style.setProperty('--cs-native-titlebar-width',(viewportWidth-(controlsLeft??0)-(controlsRight??138))+'px');
      }else{
        shell.style.removeProperty('--cs-native-titlebar-x');
        shell.style.removeProperty('--cs-native-titlebar-width');
      }
    },[controlsLeft,controlsRight,viewportWidth]);
    const toggleRef=React.useRef(null);
    return <AppShell platform={platform} platformClass={platform==='darwin'?'platform-darwin':''} sidebarCollapsed={!sidebarOpen} sidebarIsDialog={narrow} isFullscreen={fullscreen}>
      <TopBar projectName="Demo" sessionTitle="界面对齐检查" busy={!!activeChat}
        sidebarCollapsed={!sidebarOpen} onToggleSidebar={()=>setSidebarOpen(value=>!value)}
        sidebarToggleRef={toggleRef} sidebarControlsId={SIDEBAR_NAVIGATION_ID} sidebarIsDialog={narrow}
        panelOpen={panelOpen} onTogglePanel={()=>setPanelOpen(value=>!value)}
        isMac={platform==='darwin'} isFullscreen={fullscreen} statusAvailable={!!activeChat}
        contextSelectionAvailable={!!activeChat} onSelectContext={noop}
        tasks={activeChat?activeTasks:null}
        activeGoal={activeChat?{objective:'验证Windows标题栏',round:1,paused:false}:null}/>
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
      {settingsOpen&&<section data-fixture-settings className="absolute inset-0 flex flex-col overflow-hidden bg-background">
        <WindowTitleBar isFullscreen={fullscreen}/>
        <div data-fixture-settings-body className="min-h-0 flex-1 p-6">演示设置页面</div>
      </section>}
    </AppShell>;
  }
  const root=createRoot(window.document.getElementById('root'));
  window.applyFixtureTheme=config=>{
    const html=window.document.documentElement;
    html.classList.toggle('dark',config.dark);
    if(config.resetTheme){
      applyThemePack('default');
      html.style.removeProperty('--cs-surface-window-image');
      html.style.removeProperty('--cs-surface-window-opacity');
      return;
    }
    const color=config.image?'var(--cs-primary)':'var(--cs-border)';
    applyThemePack('app-shell-fixture',()=>({
      id:'app-shell-fixture',name:'App shell fixture',swatch:'340 75% 45%',
      colors:{light:{},dark:{}},
      frame:{light:config.frameLight??color,dark:config.frameDark??color,width:config.frame,radius:config.radius},
    }));
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g"><stop stop-color="#dbeafe"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1200v800H0z"/></svg>';
    html.style.setProperty('--cs-surface-window-image',config.image?'url("data:image/svg+xml,'+encodeURIComponent(svg)+'")':'none');
    html.style.setProperty('--cs-surface-window-opacity',config.image?'0.3':'0');
  };
  window.renderFixture=config=>{
    window.fixtureZoom=config.zoom??1;
    window.codeshell.platform=config.platform;
    window.codeshell.hasWindowTitleBarOverlay=config.platform==='win32';
    window.applyFixtureTheme(config);
    saveUILanguage('zh');
    root.render(<React.StrictMode><I18nProvider><ToastProvider><DialogProvider>
      <Fixture key={config.name} {...config}/>
    </DialogProvider></ToastProvider></I18nProvider></React.StrictMode>);
  };
  window.renderStandaloneTitlebar=hasOverlay=>{
    window.codeshell.hasWindowTitleBarOverlay=hasOverlay;
    root.render(<WindowTitleBar/>);
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
  ...[false, true].map((dark) => ({
    name: `mac-corner-fill-${dark ? "dark" : "light"}`,
    frame: 1,
    radius: 48,
    dark,
    panel: true,
    frameLight: "340 75% 45%",
    frameDark: "340 80% 70%",
    cornerPixels: "frame",
  })),
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
  { name: "windows-light", platform: "win32", frame: 2, radius: 14, dark: false, panel: true },
  {
    name: "windows-zoom-out",
    platform: "win32",
    frame: 2,
    radius: 14,
    dark: false,
    panel: true,
    zoom: 0.5,
  },
  {
    name: "windows-dark-scale-125",
    platform: "win32",
    frame: 3,
    radius: 16,
    dark: true,
    panel: true,
    scale: 1.25,
  },
  {
    name: "windows-max-frame-scale-150",
    platform: "win32",
    frame: 8,
    radius: 24,
    dark: false,
    panel: true,
    image: true,
    scale: 1.5,
  },
  {
    name: "windows-fullscreen-scale-200",
    platform: "win32",
    frame: 8,
    radius: 24,
    dark: true,
    fullscreen: true,
    panel: true,
    scale: 2,
  },
  {
    name: "windows-narrow-drawer",
    platform: "win32",
    frame: 2,
    radius: 16,
    dark: true,
    narrow: true,
    panel: false,
    music: true,
    scale: 1.25,
  },
  {
    name: "windows-narrow-350",
    platform: "win32",
    width: 350,
    frame: 2,
    radius: 16,
    dark: false,
    narrow: true,
    panel: false,
    music: true,
  },
  {
    name: "windows-custom-native-geometry",
    platform: "win32",
    frame: 3,
    radius: 16,
    dark: true,
    panel: true,
    controlsLeft: 140,
    controlsRight: 180,
  },
  ...[350, 390, 600, 601].map((width) => ({
    name: `windows-active-chat-${width}`,
    platform: "win32",
    width,
    frame: 2,
    radius: 14,
    dark: true,
    narrow: true,
    panel: false,
    music: true,
    activeChat: true,
  })),
  { name: "linux-rounded", platform: "linux", frame: 2, radius: 14, dark: true, panel: true },
  ...["win32", "linux"].map((platform) => ({
    name: `${platform}-corner-fill-excluded`,
    platform,
    frame: 1,
    radius: 48,
    dark: true,
    panel: true,
    frameLight: "340 75% 45%",
    frameDark: "340 80% 70%",
    cornerPixels: "not-frame",
  })),
].map((config) => ({ platform: "darwin", ...config }));
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} should equal ${expected}`);
async function assertCornerPixels(page, label, expected) {
  // CSS-scale screenshots keep the sampled coordinates independent of display DPR.
  // The points are outside the large theme radius, inside a native-sized corner.
  const screenshot = await page.screenshot({
    path: path.join(screenshots, `${label}-corners.png`),
    scale: "css",
  });
  const result = await page.evaluate(async (base64) => {
    const image = new window.Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = window.document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const points = [
      [5, 5],
      [image.width - 6, 5],
      [5, image.height - 6],
      [image.width - 6, image.height - 6],
    ];
    const pixels = points.map(([x, y]) => ({
      x,
      y,
      color: [...context.getImageData(x, y, 1, 1).data],
    }));
    const shell = window.document.querySelector("[data-app-shell]");
    const color = window.getComputedStyle(shell, "::after").borderTopColor;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const frame = [...context.getImageData(0, 0, 1, 1).data];
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = window.getComputedStyle(window.document.body).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const body = [...context.getImageData(0, 0, 1, 1).data];
    return { pixels, frame, body };
  }, screenshot.toString("base64"));
  for (const pixel of result.pixels) {
    const color = expected === "body" ? result.body : result.frame;
    const difference = Math.max(
      ...pixel.color.map((channel, index) => Math.abs(channel - color[index])),
    );
    assert.ok(
      expected === "not-frame" ? difference > 10 : difference <= 2,
      `${label} corner (${pixel.x},${pixel.y}) ${JSON.stringify(pixel.color)} should ${expected === "not-frame" ? "differ from" : "match"} ${expected === "body" ? "body" : "frame"} ${JSON.stringify(color)}`,
    );
  }
}
try {
  for (const config of cases) {
    const viewport = { width: config.width ?? (config.narrow ? 390 : 1100), height: 720 };
    const fixtureConfig = { ...config, viewportWidth: viewport.width };
    const page = await browser.newPage({ viewport, deviceScaleFactor: config.scale ?? 1 });
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
    await page.evaluate((props) => window.renderFixture(props), fixtureConfig);
    const header = page.locator('[data-theme-surface="titlebar"]');
    await header.waitFor();
    if (config.cornerPixels) await assertCornerPixels(page, config.name, config.cornerPixels);
    const expectedHeaderHeight = Math.max(44, 32 / (config.zoom ?? 1));
    if (config.zoom) {
      await page.waitForFunction(
        (height) =>
          window.document.querySelector("[data-window-titlebar]").getBoundingClientRect().height ===
          height,
        expectedHeaderHeight,
      );
    }
    const inset = config.fullscreen ? 0 : config.frame;
    const expectedRadius = config.fullscreen || config.platform === "win32" ? 0 : config.radius;
    const shell = page.locator("[data-app-shell]");
    assert.equal(await shell.getAttribute("data-platform"), config.platform);
    const frame = await shell.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const stroke = window.getComputedStyle(element, "::after");
      return {
        radius: Number.parseFloat(style.borderTopLeftRadius),
        strokeRadius: Number.parseFloat(stroke.borderTopLeftRadius),
        widths: [
          stroke.borderTopWidth,
          stroke.borderRightWidth,
          stroke.borderBottomWidth,
          stroke.borderLeftWidth,
        ].map(Number.parseFloat),
        pointerEvents: stroke.pointerEvents,
      };
    });
    near(frame.radius, expectedRadius, `${config.name} outer corner radius`);
    near(frame.strokeRadius, expectedRadius, `${config.name} decorative stroke corner radius`);
    assert.deepEqual(
      frame.widths,
      [inset, inset, inset, inset],
      `${config.name} frame stroke width`,
    );
    assert.equal(frame.pointerEvents, "none", `${config.name} frame leaves controls clickable`);
    const head = await header.boundingBox();
    near(head.x, inset, `${config.name} titlebar left inset`);
    near(head.y, inset, `${config.name} titlebar top inset`);
    near(head.width, viewport.width - inset * 2, `${config.name} titlebar width`);
    near(head.height, expectedHeaderHeight, `${config.name} titlebar height`);
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
      Math.max(0, expectedRadius - inset),
      `${config.name} content radius follows frame inset`,
    );
    assert.equal(
      await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      `${config.name} titlebar does not overflow horizontally`,
    );
    const toggle = page.locator('[data-sidebar-action="toggle"]');
    const toggleBox = await toggle.boundingBox();
    if (config.zoom) {
      near(
        toggleBox.y + toggleBox.height / 2,
        head.y + (head.height - 1) / 2,
        "zoomed-out controls remain vertically centered",
      );
    }
    const hasNativeGutter = config.platform === "darwin" && !config.fullscreen;
    const nativeLeft =
      config.platform === "win32" && !config.fullscreen ? (config.controlsLeft ?? 0) : 0;
    const nativeRight =
      config.platform === "win32" && !config.fullscreen ? (config.controlsRight ?? 138) : 0;
    const safeLeft = Math.max(inset, nativeLeft);
    const safeRight = Math.min(viewport.width - inset, viewport.width - nativeRight);
    assert.equal(
      await page.locator("[data-native-controls-gutter]").count(),
      hasNativeGutter ? 1 : 0,
      `${config.name} only macOS reserves traffic-light space`,
    );
    assert.ok(
      hasNativeGutter ? toggleBox.x >= 80 : toggleBox.x >= safeLeft && toggleBox.x < safeLeft + 40,
      `${config.name} toggle follows the platform native-control safe area`,
    );
    async function titlebarControlsFit(row, left, right, label, interactive = true) {
      assert.equal(
        await row.evaluate((element) =>
          window.getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        ),
        "drag",
        `${label} keeps a native drag surface`,
      );
      for (const button of await row.locator("button").all()) {
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        assert.ok(
          box.x >= left - 1 && box.x + box.width <= right + 1,
          `${label} keeps ${await button.getAttribute("aria-label")} outside native buttons: ${JSON.stringify({ x: box.x, width: box.width, left, right })}`,
        );
        if (interactive) {
          const reachability = await button.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = window.document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return {
              reachable: element === hit || element.contains(hit),
              hit: hit?.outerHTML.slice(0, 300),
            };
          });
          assert.equal(
            reachability.reachable,
            true,
            `${label} ${await button.getAttribute("aria-label")} remains reachable: ${reachability.hit}`,
          );
        }
      }
    }
    if (config.platform === "win32") {
      assert.notEqual(await header.getAttribute("data-window-titlebar"), null);
      await titlebarControlsFit(header, safeLeft, safeRight, config.name, !config.narrow);
      near(
        (await page.locator('[data-panel-action="toggle"]').boundingBox()).width,
        28,
        `${config.name} panel toggle remains visible`,
      );
      if (config.activeChat) {
        assert.equal(await header.locator('[data-context-action="open"]').count(), 1);
        assert.equal(await header.locator('[data-goal-marker="active"]').count(), 1);
        assert.equal(await header.locator('[data-context-action="open"]').isVisible(), true);
        assert.equal(await header.locator('[data-goal-marker="active"]').isVisible(), true);
        assert.equal(await header.locator(".status-dot").isVisible(), true);
        assert.equal(
          await header.locator("[data-titlebar-task-count]").isVisible(),
          viewport.width > 420,
          `${config.name} task count collapses before essential active-chat controls overlap`,
        );
        assert.ok(
          (await header.locator('button:has([data-goal-marker="active"])').textContent()).includes(
            "2/3",
          ),
          `${config.name} exercises the active goal and task-progress chip`,
        );
      }
    }
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
    if (
      config.name === "mac-image-frame-2" ||
      config.name === "windows-light" ||
      config.name === "windows-fullscreen-scale-200"
    ) {
      await page.evaluate(() => window.setFixtureSettings(true));
      const settings = page.locator("[data-fixture-settings]");
      await settings.waitFor();
      const box = await settings.boundingBox();
      const content = await page.locator("[data-app-shell-content]").boundingBox();
      near(box.x, content.x, "settings overlay follows the inner frame left edge");
      near(box.y, content.y, "settings overlay follows the inner frame top edge");
      near(box.width, content.width, "settings overlay follows the inner frame width");
      near(box.height, content.height, "settings overlay follows the inner frame height");
      const settingsTitlebar = settings.locator("[data-window-titlebar]");
      const settingsBody = await settings.locator("[data-fixture-settings-body]").boundingBox();
      if (config.platform === "win32") {
        await settingsTitlebar.waitFor();
        const row = await settingsTitlebar.boundingBox();
        near(row.x, content.x, "Windows settings titlebar follows the inner frame");
        near(row.width, content.width, "Windows settings titlebar spans the inner frame");
        near(row.height, 44, "Windows settings retains a drag row");
        near(
          settingsBody.y,
          row.y + row.height,
          "Windows settings content starts below native controls",
        );
        await titlebarControlsFit(settingsTitlebar, safeLeft, safeRight, `${config.name} settings`);
        await page.screenshot({ path: path.join(screenshots, `${config.name}-settings.png`) });
      } else {
        assert.equal(
          await settingsTitlebar.count(),
          0,
          "macOS settings keeps its native titlebar layout",
        );
        near(settingsBody.y, content.y, "macOS settings does not reserve a Windows drag row");
      }
      await page.evaluate(() => window.setFixtureSettings(false));
      await settings.waitFor({ state: "hidden" });
      await header.waitFor();
    }
    if (config.name === "windows-dark-scale-125") {
      const shellNode = await shell.elementHandle();
      for (const fullscreen of [true, false]) {
        await page.evaluate((props) => window.renderFixture(props), {
          ...fixtureConfig,
          fullscreen,
        });
        await page.waitForFunction(
          (state) =>
            window.document.querySelector("[data-app-shell]").dataset.windowState === state,
          fullscreen ? "fullscreen" : "windowed",
        );
        assert.equal(
          await shell.evaluate((element, previous) => element === previous, shellNode),
          true,
          "Windows fullscreen transition updates the mounted shell",
        );
        const transitionInset = fullscreen ? 0 : config.frame;
        const transitionFrame = await shell.evaluate((element) => {
          const stroke = window.getComputedStyle(element, "::after");
          const content = window.getComputedStyle(
            element.querySelector("[data-app-shell-content]"),
          );
          return {
            width: Number.parseFloat(stroke.borderTopWidth),
            outerRadius: Number.parseFloat(stroke.borderTopLeftRadius),
            innerRadius: Number.parseFloat(content.borderTopLeftRadius),
          };
        });
        assert.deepEqual(
          transitionFrame,
          { width: transitionInset, outerRadius: 0, innerRadius: 0 },
          "Windows fullscreen transition restores the theme width and keeps square corners",
        );
        const transitionHeader = await header.boundingBox();
        near(transitionHeader.x, transitionInset, "Windows transition titlebar left inset");
        near(transitionHeader.y, transitionInset, "Windows transition titlebar top inset");
        const transitionBody = await page.locator("[data-fixture-body]").boundingBox();
        near(
          transitionBody.y + transitionBody.height,
          viewport.height - transitionInset,
          "Windows transition body bottom inset",
        );
        await titlebarControlsFit(
          header,
          transitionInset,
          fullscreen ? viewport.width : viewport.width - 138,
          "Windows fullscreen transition",
        );
      }
      await shellNode.dispose();
    }
    if (config.name === "mac-corner-fill-light") {
      const shellNode = await shell.elementHandle();
      for (const transition of [
        { name: "dark", dark: true, frame: 1, expected: "frame" },
        { name: "zero-width", dark: true, frame: 0, expected: "body" },
        { name: "restored", dark: false, frame: 1, expected: "frame" },
        { name: "default-reset", dark: false, resetTheme: true, expected: "body" },
      ]) {
        await page.evaluate((props) => window.applyFixtureTheme(props), {
          ...fixtureConfig,
          ...transition,
        });
        assert.equal(
          await shell.evaluate((element, previous) => element === previous, shellNode),
          true,
          "theme changes update the mounted macOS shell",
        );
        await assertCornerPixels(page, `${config.name}-${transition.name}`, transition.expected);
      }
      for (const fullscreen of [true, false]) {
        await page.evaluate((props) => window.renderFixture(props), {
          ...fixtureConfig,
          fullscreen,
        });
        await page.waitForFunction(
          (state) =>
            window.document.querySelector("[data-app-shell]").dataset.windowState === state,
          fullscreen ? "fullscreen" : "windowed",
        );
        assert.equal(
          await shell.evaluate((element, previous) => element === previous, shellNode),
          true,
          "fullscreen changes update the mounted macOS shell",
        );
        await assertCornerPixels(
          page,
          `${config.name}-${fullscreen ? "fullscreen" : "windowed"}`,
          fullscreen ? "not-frame" : "frame",
        );
      }
      await shellNode.dispose();
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
      if (config.platform === "win32") {
        await titlebarControlsFit(header, safeLeft, safeRight, `${config.name} after drawer close`);
      }
      if (config.name === "windows-active-chat-350") {
        await header.locator('button:has([data-goal-marker="active"])').focus();
        const status = page.locator("[data-status-popover]");
        await status.waitFor();
        assert.equal(
          await status.getByText("检查窗口安全区", { exact: true }).isVisible(),
          true,
          "compact Windows status keeps task details accessible",
        );
        await page.screenshot({ path: path.join(screenshots, `${config.name}-status.png`) });
        await page.keyboard.press("Escape");
        await status.waitFor({ state: "hidden" });
      }
    }
    if (config.name === "windows-light") {
      await page.evaluate(() => window.renderStandaloneTitlebar(false));
      await page.locator("[data-window-titlebar]").waitFor({ state: "hidden" });
      assert.equal(
        await page.locator("[data-window-titlebar]").count(),
        0,
        "Windows pet and child windows without native overlays do not gain a startup titlebar",
      );
      await page.evaluate(() => window.renderStandaloneTitlebar(true));
      await page.locator("[data-window-titlebar]").waitFor();
      assert.equal(
        await page.locator("[data-window-titlebar]").count(),
        1,
        "main Windows startup retains the native overlay drag row",
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
