/*
 * Real Electron settings smoke.
 *
 * Boots the production main/preload/renderer stack in an isolated HOME, seeds
 * one tracked project, and exercises the settings information architecture at
 * desktop and mobile widths. Optional screenshots are written when
 * CODESHELL_SETTINGS_SCREENSHOT_DIR is set.
 */
/* global document, getComputedStyle, localStorage, window */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  openSettingsMenu,
} from "./electron-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const isolated = await makeIsolatedElectronHome("codeshell-settings-e2e-");
const projectPath = join(isolated.home, "settings-project");
const sourceFolder = join(isolated.home, "source-documents");
const sourceFile = join(sourceFolder, "settings-reference.txt");
const screenshotDir = process.env.CODESHELL_SETTINGS_SCREENSHOT_DIR;
const networkReceipt = join(isolated.home, "network-attempts.jsonl");
async function networkAttempts() {
  return (
    await readFile(networkReceipt, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  ).length;
}
let app;
let win;

async function seedFixture() {
  await mkdir(projectPath, { recursive: true });
  await mkdir(sourceFolder, { recursive: true });
  await writeFile(sourceFile, "Settings document collection fixture.\n");
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "desktop", "recents.json"),
    `${JSON.stringify(
      [
        {
          path: projectPath,
          name: basename(projectPath),
          lastOpenedAt: Date.now(),
          pinned: true,
        },
      ],
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    `${JSON.stringify({ autoUpdates: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(isolated.codeShellHome, "credentials.json"),
    JSON.stringify({
      version: 1,
      credentials: [
        ["github", "fine-grained-pat", "Fixture GitHub"],
        ["figma", "personal-access-token", "Fixture Figma"],
      ].map(([provider, method, label]) => ({
        id: `settings-fixture-${provider}`,
        type: "link",
        label,
        secret: "settings-e2e-synthetic-token",
        createdAt: new Date().toISOString(),
        meta: {
          linkProvider: provider,
          linkConnectionMethod: method,
          linkExecutionRuntime: "local",
          linkExecutionBackend: "http-token",
          linkAuthSource: "manual-token",
          linkCapabilityIds: [`${provider}.get_file`],
        },
      })),
    }),
    { mode: 0o600 },
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
}

/**
 * The first launch in an isolated home raises the trust prompt over a modal
 * overlay that swallows every click. This script already dismissed it, but only
 * inside a later helper — by then openSettings has already timed out waiting
 * for a button the overlay was covering.
 */
async function dismissTrustDialog(win) {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  const opened = await viewOnly
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) await viewOnly.click();
}

async function openSettings(win) {
  await dismissTrustDialog(win);
  const menu = await openSettingsMenu(win);
  const menuLabels = await menu.getByRole("menuitem").allTextContents();
  assert(
    /^(设置|Settings)$/.test(menuLabels[0]?.trim() ?? ""),
    "Settings is not the first menu action",
  );
  const language = menu.getByRole("menuitem", { name: /切换语言|Switch language/i });
  await language.hover();
  assert(
    (await win.getByRole("menuitemradio").count()) === 0,
    "Language submenu opened from hover instead of an explicit click",
  );
  await language.click();
  await win.getByRole("menuitemradio").first().waitFor({ state: "visible", timeout: 10_000 });
  await screenshot(win, "settings-menu-language.png");
  await language.click();
  await win.getByRole("menuitemradio").first().waitFor({ state: "hidden", timeout: 10_000 });
  await menu.getByRole("menuitem", { name: /^(设置|Settings)$/ }).click();
  await win.waitForFunction(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "settings_page"
      );
    } catch {
      return false;
    }
  });
  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .waitFor({ state: "visible", timeout: 20_000 });
}

async function openProjectSettings(win) {
  await win.getByRole("button", { name: /返回应用|Back to app/i }).click();
  await win.waitForFunction(() => {
    try {
      return JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "chat";
    } catch {
      return false;
    }
  });
  const project = win
    .locator("#codeshell-sidebar-navigation")
    .getByText(basename(projectPath), { exact: true });
  assert((await project.count()) === 1, "Seeded project entry is not unique");
  await project.click({ button: "right" });
  const open = win.getByRole("menuitem", { name: /项目配置|Project configuration/i });
  await open.waitFor({ state: "visible", timeout: 10_000 });
  await open.click();
  await win.waitForFunction(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode === "project_config"
      );
    } catch {
      return false;
    }
  });
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  const trustDialogOpened = await viewOnly
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (trustDialogOpened) await viewOnly.click();
}

async function assertNoHorizontalOverflow(win, label) {
  const metrics = await win.evaluate(() => {
    const navigation = document.querySelector(
      'nav[aria-label="设置导航"], nav[aria-label="Settings navigation"]',
    );
    // The chat workspace stays mounted (aria-hidden) behind Settings, so a
    // document-wide `querySelector("main")` can select the hidden chat main.
    // Resolve the settings main from the navigation's own shell instead.
    const main = navigation?.parentElement?.querySelector("main");
    return {
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      mainClient: main?.clientWidth ?? 0,
      mainContent: main?.scrollWidth ?? 0,
      mainOverflowY: main ? getComputedStyle(main).overflowY : "",
      navigationClient: navigation?.clientWidth ?? 0,
      navigationContent: navigation?.scrollWidth ?? 0,
    };
  });
  assert(
    metrics.content <= metrics.viewport + 1,
    `${label} overflowed horizontally: content=${metrics.content}, viewport=${metrics.viewport}`,
  );
  assert(
    metrics.mainContent <= metrics.mainClient + 1,
    `${label} main content overflowed horizontally: content=${metrics.mainContent}, client=${metrics.mainClient}`,
  );
  assert(
    metrics.navigationContent <= metrics.navigationClient + 1,
    `${label} navigation overflowed horizontally: content=${metrics.navigationContent}, client=${metrics.navigationClient}`,
  );
  assert(
    metrics.mainOverflowY === "auto" || metrics.mainOverflowY === "scroll",
    `${label} main content is not independently scrollable`,
  );
}

async function screenshot(win, filename) {
  if (!screenshotDir) return;
  const output = join(screenshotDir, filename);
  await win.screenshot({ path: output, fullPage: true, animations: "disabled", scale: "css" });
  console.log(`settings visual: ${output}`);
}

async function checkShortcuts(win) {
  await win.getByRole("button", { name: /键盘快捷键|Keyboard shortcuts/i }).click();
  const heading = win.getByRole("heading", { name: /键盘快捷键|Keyboard shortcuts/i, level: 1 });
  await heading.waitFor();
  const section = win.getByRole("region", { name: /快捷键|Keyboard shortcuts/i });
  await section.waitFor();
  for (const lang of ["zh", "en"]) {
    await win.evaluate((value) => {
      localStorage.setItem("codeshell.uiLanguage", value);
      window.dispatchEvent(new window.Event("codeshell:language-changed"));
    }, lang);
    await win
      .getByRole("heading", {
        name: lang === "zh" ? "键盘快捷键" : "Keyboard shortcuts",
        level: 1,
        exact: true,
      })
      .waitFor();
    assert(
      (await section.getByRole("heading", { level: 2 }).count()) >= 2,
      "Shortcuts are not grouped",
    );
    const keys = await section.locator("kbd").allTextContents();
    assert(
      keys.some((key) => key.includes(process.platform === "darwin" ? "⌘" : "Ctrl")),
      "Shortcut modifiers do not match the host platform",
    );
    for (const width of [1280, 820, 390]) {
      await win.setViewportSize({ width, height: 820 });
      const main = win.locator("main").filter({ has: section });
      await main.evaluate((node) => {
        node.scrollTop = 0;
      });
      for (const dark of [false, true]) {
        await win.evaluate(
          (value) => document.documentElement.classList.toggle("dark", value),
          dark,
        );
        await assertNoHorizontalOverflow(win, `shortcuts ${width} ${lang}`);
        const overflow = await section.evaluate((node) =>
          Array.from(node.querySelectorAll("div,section,dl,li")).some(
            (child) => child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1,
          ),
        );
        assert(!overflow, `Shortcut rows overflowed at ${width}px (${lang})`);
        await screenshot(win, `settings-shortcuts-${width}-${lang}${dark ? "-dark" : ""}.png`);
      }
    }
  }
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "zh");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
    document.documentElement.classList.remove("dark");
  });
  await win.setViewportSize({ width: 1440, height: 960 });
  console.log("PASS shortcuts: platform keys, grouped rows, three widths and two languages/themes");
}

async function checkDataSourceAdds(app, win) {
  await win.setViewportSize({ width: 1_280, height: 820 });
  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .getByRole("button", { name: /数据源|Data sources/i, exact: true })
    .click();
  const collections = win.locator("[data-source-collections]");
  for (const name of ["添加本地文件", "添加文件夹当前清单", "添加并检查链接"]) {
    await collections.getByRole("button", { name, exact: true }).waitFor({ state: "visible" });
  }
  await screenshot(win, "settings-data-source-add.png");
  assert(
    (await win.locator('[name="source-id"], [name="source-link-params"]').count()) === 0,
    "The material library exposed a technical creation form by default",
  );
  assert(
    (await win.getByRole("button", { name: "从 Link 选择文件", exact: true }).count()) === 0,
    "Global material management still implicitly adds files to a project",
  );

  // Keep the production IPC/service/manifest path. The native chooser returns
  // only this isolated fixture's explicit file or folder selection.
  await app.evaluate(
    ({ dialog }, fixture) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        return {
          canceled: false,
          filePaths: [options.properties.includes("openDirectory") ? fixture.folder : fixture.file],
        };
      };
    },
    { file: sourceFile, folder: sourceFolder },
  );

  for (const [opener, create, label] of [
    ["添加本地文件", "创建并选择文件", "Settings files"],
    ["添加文件夹当前清单", "创建并选择文件夹", "Settings folder"],
  ]) {
    await collections.getByRole("button", { name: opener, exact: true }).click();
    const name = collections.getByRole("textbox", { name: "资料集名称", exact: true });
    assert(
      await name.evaluate((node) => node === document.activeElement),
      "Collection name was not focused",
    );
    await name.fill(label);
    await collections.getByRole("button", { name: create, exact: true }).click();
    await collections
      .locator("[data-collection-entry]")
      .getByText(basename(sourceFile), { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await assertNoHorizontalOverflow(win, `data source add ${label}`);
    await collections.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await collections.getByRole("button", { name: "添加并检查链接", exact: true }).click();
  await collections
    .getByRole("textbox", { name: "静态文件链接", exact: true })
    .waitFor({ state: "visible" });
  await collections
    .getByRole("button", { name: "创建并添加链接", exact: true })
    .waitFor({ state: "visible" });
  await screenshot(win, "settings-data-source-url.png");
  await collections.getByRole("button", { name: "取消", exact: true }).click();

  // Exercise real renderer/preload/Main Link authority and project binding; no file read occurs.
  const attemptsBefore = await networkAttempts();
  await win.getByRole("combobox", { name: "选择要配置的项目", exact: true }).click();
  await win.getByRole("option", { name: basename(projectPath), exact: false }).click();
  await win.getByRole("button", { name: "管理项目数据源", exact: true }).click();
  await win.getByRole("button", { name: "从 Link 选择文件", exact: true }).click();
  let linked = win.getByRole("dialog", { name: "从 Link 选择文件", exact: true });
  assert(
    (await linked.getByRole("combobox", { name: "项目", exact: true }).count()) === 0,
    "The project file chooser still allows changing its destination",
  );
  await linked.getByRole("combobox", { name: "已连接服务", exact: true }).waitFor();
  await linked.locator('[name="linked-file-owner"]').fill("acme");
  await linked.locator('[name="linked-file-repo"]').fill("docs");
  await linked.locator('[name="linked-file-paths"]').fill("README.md\ndocs/guide.md");
  await linked.locator('[name="linked-file-ref"]').fill("release");
  await screenshot(win, "settings-linked-github.png");
  const before = await win.evaluate(async () =>
    (await window.codeshell.listSourceCatalog()).filter((item) => item.kind === "link"),
  );
  assert(before.length === 0, "Selecting linked files mutated the catalog before Add");
  await linked.getByRole("button", { name: "添加到数据源", exact: true }).click();
  await linked.waitFor({ state: "hidden", timeout: 10_000 });
  const references = await win.evaluate(async () => {
    const project = (await window.codeshell.projectRegistry.list())[0];
    return {
      catalog: await window.codeshell.listSourceCatalog(),
      access: await window.codeshell.projectSourceAccess(project.id),
    };
  });
  const github = references.catalog.filter(
    (item) => item.credentialRef === "settings-fixture-github",
  );
  assert(github.length === 2, "Linked GitHub batch was not saved through production IPC");
  assert(
    github.every((item) =>
      references.access.bindings.some(
        (binding) =>
          binding.sourceId === item.id &&
          binding.priority === "high" &&
          binding.readPolicy === "ask",
      ),
    ),
    "Linked references lost priority or read approval",
  );

  await win.getByRole("button", { name: "从 Link 选择文件", exact: true }).click();
  linked = win.getByRole("dialog", { name: "从 Link 选择文件", exact: true });
  await linked.getByRole("combobox", { name: "已连接服务", exact: true }).click();
  await win.getByRole("option", { name: "Fixture Figma", exact: false }).click();
  await linked
    .locator('[name="linked-file-figma"]')
    .fill("https://www.figma.com/design/fixtureFile/Product");
  for (const width of [1280, 390]) {
    await win.setViewportSize({ width, height: 820 });
    const overflow = await linked.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    assert(!overflow, `Linked file dialog overflowed at ${width}px`);
    await screenshot(win, `settings-linked-figma-${width}.png`);
  }
  await win.setViewportSize({ width: 1280, height: 820 });
  await linked.getByRole("button", { name: "添加到数据源", exact: true }).click();
  await linked.waitFor({ state: "hidden", timeout: 10_000 });
  const figma = await win.evaluate(async () =>
    (await window.codeshell.listSourceCatalog()).filter(
      (item) => item.credentialRef === "settings-fixture-figma",
    ),
  );
  assert(
    figma.length === 1 && figma[0].adapterConfig.params.file_url_or_key === "fixtureFile",
    "Figma reference did not retain exact file key",
  );
  assert(
    (await networkAttempts()) === attemptsBefore,
    "Linked selection attempted a network request",
  );
  await win.getByRole("button", { name: "添加或管理资料集", exact: true }).click();
  const online = win.locator("[data-connected-materials]");
  assert(
    (await online.locator("[data-source-definition]").count()) === 3,
    "Selected online files are hidden in advanced definitions",
  );
  await screenshot(win, "settings-online-materials.png");
  await win
    .getByRole("button", { name: `返回 ${basename(projectPath)} 数据源`, exact: true })
    .click();
  await win.getByRole("button", { name: "从 Link 选择文件", exact: true }).waitFor();
  assert(
    (await win.locator("[data-source-access]").count()) === 3,
    "Returning to the project lost its file references",
  );
  // Leave the remainder of this settings smoke in its original global context.
  await win.getByRole("button", { name: "添加或管理资料集", exact: true }).click();
  await win.getByRole("button", { name: "管理 Link 连接", exact: true }).click();
  const linkTab = win.getByRole("tab", { name: /Link/ });
  await linkTab.waitFor({ state: "visible", timeout: 10_000 });
  assert(
    (await linkTab.getAttribute("aria-selected")) === "true",
    "Link management opened the wrong category",
  );
  await screenshot(win, "settings-materials-link-destination.png");
  await openSettings(win);
  console.log(
    "PASS linked files: explicit project navigation, fixed destination, reusable online materials, return path and read approval",
  );
}

try {
  await seedFixture();
  const networkGuard = join(isolated.home, "deny-network.cjs");
  await writeFile(
    networkGuard,
    `const deny = () => { require("node:fs").appendFileSync(${JSON.stringify(networkReceipt)}, JSON.stringify({ pid: process.pid }) + "\\n", { mode: 0o600 }); throw new Error("Settings fixture forbids network"); };
globalThis.fetch = async () => deny();
for (const name of ["node:http", "node:https"]) {
  const transport = require(name);
  transport.request = deny;
  transport.get = deny;
}
require("node:module").syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: networkGuard,
    env: { NODE_OPTIONS: `--require ${networkGuard}` },
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1_440, height: 960 });
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });
  await openSettings(win);

  await win.getByRole("heading", { name: /常规|General/i }).waitFor({ state: "visible" });
  assert(
    (await win.getByRole("combobox", { name: /配置范围|Configuration scope/i }).count()) === 0,
    "Ordinary settings still rendered a page-wide project scope picker",
  );
  await win
    .getByText(/扩展能力|Extensions/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await win
    .getByText(/环境与连接|Environment|Connections/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await assertNoHorizontalOverflow(win, "global settings");
  await screenshot(win, "settings-global.png");

  const search = win.getByRole("searchbox", { name: /搜索设置|Search settings/i });
  await search.fill("MCP");
  await win.getByRole("button", { name: /MCP/i }).waitFor({ state: "visible" });
  assert(
    (await win.getByRole("button", { name: /外观|Appearance/i }).count()) === 0,
    "settings search did not filter unrelated navigation items",
  );
  await search.fill("");

  await win.setViewportSize({ width: 1_440, height: 560 });
  const main = win.locator("main").filter({ has: win.getByRole("heading", { level: 1 }) });
  await main.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .getByRole("button", { name: /能力总览|Capability overview/i })
    .click();
  const builtinGroup = win.getByRole("button", { name: /内置工具|Built-in tools/i });
  await builtinGroup.waitFor({ state: "visible", timeout: 10_000 });
  assert(
    (await main.evaluate((node) => node.scrollTop)) === 0,
    "Capability overview retained the previous settings module's scroll position",
  );
  await builtinGroup.click();
  await win.getByText("SwitchSessionWorkspace", { exact: true }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "global capability overview");
  await screenshot(win, "settings-capabilities.png");

  await checkDataSourceAdds(app, win);
  await checkShortcuts(win);

  await win.getByRole("button", { name: /外观|Appearance/i }).click();
  await win.getByRole("heading", { name: /外观|Appearance/i }).waitFor({ state: "visible" });
  await openProjectSettings(win);
  // Project navigation above remembered its data-sources module for this visit.
  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .getByRole("button", { name: /项目概览|Project overview/i, exact: true })
    .click();
  await win
    .getByRole("heading", { name: /项目概览|Project overview/i })
    .waitFor({ state: "visible", timeout: 10_000 });
  await win.getByText(projectPath, { exact: false }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "project settings");
  await screenshot(win, "settings-project.png");

  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .getByRole("button", { name: /数据源|Data sources/i, exact: true })
    .click();
  await win.getByRole("button", { name: "添加或管理资料集", exact: true }).click();
  await win
    .getByRole("button", { name: "添加本地文件", exact: true })
    .waitFor({ state: "visible" });
  await openProjectSettings(win);

  await win
    .getByRole("navigation", { name: /设置导航|Settings navigation/i })
    .getByRole("button", { name: /数字人|Digital humans/i })
    .click();
  await win
    .getByRole("heading", { name: /数字人|Digital humans/i, level: 1 })
    .waitFor({ state: "visible" });

  await win.setViewportSize({ width: 700, height: 900 });
  await win
    .getByRole("combobox", { name: /设置导航|Settings navigation/i })
    .waitFor({ state: "visible", timeout: 10_000 });
  assert(
    await win.getByRole("navigation", { name: /设置导航|Settings navigation/i }).isHidden(),
    "desktop settings navigation remained visible at the mobile breakpoint",
  );
  await assertNoHorizontalOverflow(win, "mobile settings");
  await screenshot(win, "settings-mobile.png");

  assert(rendererErrors.length === 0, `renderer emitted ${rendererErrors.length} page error(s)`);
  console.log("CodeShell Electron settings E2E: passed");
} catch (error) {
  if (win) {
    const headings = await win
      .locator("h1, h2, h3")
      .allTextContents()
      .catch(() => []);
    console.error("settings headings at failure:", headings);
    if (screenshotDir) {
      const failurePath = join(screenshotDir, "settings-failure.png");
      await win.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined);
      console.error(`settings failure visual: ${failurePath}`);
    }
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
