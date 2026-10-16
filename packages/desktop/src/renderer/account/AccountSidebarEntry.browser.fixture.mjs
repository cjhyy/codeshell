/* Real browser regression for the account menu, its Settings handoff and responsive layout. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
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
  import {AccountSidebarEntry} from './account/AccountSidebarEntry';
  import {SettingsPage} from './settings/SettingsPage';
  import {DialogProvider} from './ui/DialogProvider';
  import {ToastProvider} from './ui/ToastProvider';
  import {I18nProvider} from './i18n/I18nProvider';
  import {loadUILanguage, saveUILanguage} from './uiLanguage';
  const root=createRoot(document.getElementById('root'));
  const listeners=new Set();
  let current={state:'signed-out'};
  window.actions=[];
  window.actionSnapshots=[];
  window.requests={status:[],capabilities:[],logout:0,subscriptions:0,unsubscriptions:0};
  window.emitStatus=next=>{
    current=next;
    for(const listener of listeners) listener(next);
  };
  const snapshot=()=>({
    menuCount:document.querySelectorAll('[role="menu"]').length,
    dialogCount:document.querySelectorAll('[role="dialog"]').length,
    accountPageCount:document.querySelectorAll('[data-account-settings-page]').length,
    pointerEvents:document.body.style.pointerEvents,
  });
  const recordAction=action=>{
    window.actions.push(action);
    window.actionSnapshots.push({action,...snapshot()});
  };
  const unexpected=method=>async()=>{throw new Error('Unexpected account method: '+method)};
  window.codeshell={credentials:{list:async cwd=>{
    if(cwd!=='') throw new Error('Account form must read global credentials');
    return [];
  }},cloudAccount:{
    status:async()=>{window.requests.status.push(snapshot());return current;},
    onStatus:listener=>{
      listeners.add(listener);
      window.requests.subscriptions+=1;
      return ()=>{listeners.delete(listener);window.requests.unsubscriptions+=1;};
    },
    capabilities:async origin=>{
      window.requests.capabilities.push({origin,...snapshot()});
      return {registrationAllowed:true,githubEnabled:true,githubLinkEnabled:true,
        profileEnabled:false,linkManagementEnabled:false};
    },
    logout:async()=>{
      window.requests.logout+=1;
      await new Promise(resolve=>setTimeout(resolve,25));
      window.emitStatus({state:'signed-out'});
      return {state:'signed-out',revocation:'confirmed'};
    },
    login:unexpected('login'),register:unexpected('register'),
    signInWithGitHub:unexpected('signInWithGitHub'),linkGitHub:unexpected('linkGitHub'),
    cancelSignIn:unexpected('cancelSignIn'),profile:unexpected('profile'),
    manageLinks:unexpected('manageLinks'),
  }};
  window.fixtureLanguage=loadUILanguage;
  function Fixture(){
    const [accountOpen,setAccountOpen]=React.useState(false);
    return <>
      <main hidden={accountOpen} className="h-full bg-background text-foreground">
        <div className="fixed left-3 top-4 text-sm font-semibold">CodeShell</div>
        <button type="button" aria-label="Fixture outside" onClick={()=>recordAction('outside')}
          style={{position:'fixed',right:12,top:12}}>×</button>
        <div style={{position:'fixed',left:12,bottom:12,width:'min(264px,calc(100vw - 24px))'}}>
          <AccountSidebarEntry onOpenSettingsPage={()=>recordAction('settings')}
            onOpenAccountSettings={()=>{recordAction('account-settings');setAccountOpen(true);}}
            onNavigate={page=>recordAction(page)} petWidgetVisible={false}
            onTogglePetWidget={()=>recordAction('pet')}/>
        </div>
      </main>
      {accountOpen&&<div data-account-settings-page style={{position:'fixed',inset:0,overflow:'hidden'}}>
        <SettingsPage initialModule='account' activeProjectPath={null} projects={[]}
          sessionIndices={{}} onRestoreArchivedSession={()=>{}} onDeleteArchivedSession={()=>{}}
          isMac={false} isFullscreen={false}
          onBack={()=>{recordAction('back');setAccountOpen(false);}}/>
      </div>}
    </>;
  }
  window.renderFixture=({lang,status})=>{
    current=status;
    saveUILanguage(lang);
    root.render(<I18nProvider><DialogProvider><ToastProvider><Fixture/></ToastProvider></DialogProvider></I18nProvider>);
  };
  window.unmountFixture=()=>root.unmount();
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "empty", ".wav": "empty", ".css": "empty" },
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
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
const labels = {
  zh: {
    manage: "账号管理",
    signIn: "登录账号",
    settings: "设置",
    language: "切换语言",
    activity: "活动记录",
    logs: "诊断日志",
    credentials: "凭证",
    pet: "显示 Mimi",
    logout: "退出云账号",
  },
  en: {
    manage: "Manage account",
    signIn: "Sign in to CodeShell",
    settings: "Settings",
    language: "Switch language",
    activity: "Activity",
    logs: "Diagnostic logs",
    credentials: "Credentials",
    pet: "Show Mimi",
    logout: "Sign out",
  },
};
const signedIn = (username = "member.one", displayName = "Alex Chen") => ({
  state: "signed-in",
  origin: "https://accounts.example.test",
  account: { id: `account-${username}`, username, displayName },
});
const trigger = (page, lang, status) =>
  page.getByRole("button", {
    name: status.account
      ? `${labels[lang].manage}: ${status.account.displayName || status.account.username}`
      : labels[lang].signIn,
    exact: true,
  });
const menu = (page, lang) => page.getByRole("menu", { name: labels[lang].manage, exact: true });
const item = (parent, name) => parent.getByRole("menuitem", { name, exact: true });
const assertFocused = async (locator, message) => {
  assert.ok(await locator.evaluate((node) => node === document.activeElement), message);
};
const assertUnlocked = async (page) => {
  await page.waitForFunction(() => window.getComputedStyle(document.body).pointerEvents !== "none");
  await page.getByRole("button", { name: "Fixture outside", exact: true }).click();
  assert.equal(await page.evaluate(() => window.actions.at(-1)), "outside");
};
const assertWithinViewport = async (locator, { width, height }, message) => {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `${message}: has bounds`);
  assert.ok(bounds.x >= 0 && bounds.y >= 0, `${message}: starts inside the viewport`);
  assert.ok(bounds.x + bounds.width <= width + 1, `${message}: fits viewport width`);
  assert.ok(bounds.y + bounds.height <= height + 1, `${message}: fits viewport height`);
};
const screenshots = [];
const screenshotDir = process.env.CODESHELL_ACCOUNT_MENU_SCREENSHOT_DIR ?? tmpdir();
await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
try {
  for (const width of [1280, 390]) {
    for (const lang of ["zh", "en"]) {
      for (const authenticated of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 760 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        const blockedRequests = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // This fixture authorizes one synthetic document only. Production code
        // and compiled CSS are injected in memory; every other request is blocked.
        await page.route("**/*", (route) => {
          if (
            route.request().url() === "http://account.test/" &&
            route.request().method() === "GET"
          ) {
            return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
          }
          blockedRequests.push(route.request().url());
          return route.abort("blockedbyclient");
        });
        await page.goto("http://account.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        let status = authenticated ? signedIn() : { state: "signed-out" };
        await page.evaluate((options) => window.renderFixture(options), { lang, status });
        let opener = trigger(page, lang, status);
        await opener.waitFor();
        assert.ok((await opener.boundingBox()).width >= 240, "The full account row is clickable");
        await page.waitForTimeout(300); // Longer than account capability discovery's debounce.
        assert.equal(await page.evaluate(() => window.requests.capabilities.length), 0);
        const parentMenu = menu(page, lang);
        await opener.click();
        await parentMenu.waitFor();
        assert.equal(
          await page.getByRole("dialog").count(),
          0,
          "Opening the menu leaves forms lazy",
        );
        assert.equal(await page.evaluate(() => window.requests.capabilities.length), 0);
        await assertWithinViewport(parentMenu, { width, height: 760 }, "Account menu");
        const topItems = await parentMenu.getByRole("menuitem").allTextContents();
        assert.equal(topItems[0].trim(), labels[lang].settings);
        assert.equal(topItems[1].trim(), labels[lang].language);
        assert.equal(await item(parentMenu, labels[lang].logout).count(), authenticated ? 1 : 0);

        if (width === 390 && lang === "zh" && authenticated) {
          await page.mouse.move(width - 10, 10);
          const menuBounds = await parentMenu.boundingBox();
          // Radix hides the background row from the accessibility tree while
          // the menu is modal, but its rendered box still frames the preview.
          const rowBounds = await page.locator('button[aria-haspopup="menu"]').boundingBox();
          const left = Math.max(0, Math.floor(Math.min(menuBounds.x, rowBounds.x) - 16));
          const top = Math.max(0, Math.floor(Math.min(menuBounds.y, rowBounds.y) - 16));
          const right = Math.min(
            width,
            Math.ceil(
              Math.max(menuBounds.x + menuBounds.width, rowBounds.x + rowBounds.width) + 16,
            ),
          );
          const bottom = Math.min(
            760,
            Math.ceil(
              Math.max(menuBounds.y + menuBounds.height, rowBounds.y + rowBounds.height) + 16,
            ),
          );
          const clip = { x: left, y: top, width: right - left, height: bottom - top };
          for (const theme of ["light", "dark"]) {
            await page.evaluate(
              (value) => document.documentElement.classList.toggle("dark", value === "dark"),
              theme,
            );
            const screenshotPath = path.join(
              screenshotDir,
              `account-dropdown-preview-${theme}.png`,
            );
            await page.screenshot({ path: screenshotPath, clip, animations: "disabled" });
            screenshots.push({ theme, path: screenshotPath, ...clip });
          }
          await page.evaluate(() => document.documentElement.classList.remove("dark"));
        }

        await item(parentMenu, labels[lang].settings).click();
        await parentMenu.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => window.actions.at(-1)), "settings");
        const navigation = await page.evaluate(() => window.actionSnapshots.at(-1));
        assert.equal(navigation.menuCount, 0, "Settings executes after the menu unmounts");
        assert.notEqual(
          navigation.pointerEvents,
          "none",
          "Settings executes after pointer locks release",
        );
        await assertFocused(opener, "Settings returns focus to the account row");
        await assertUnlocked(page);

        await opener.click();
        await item(parentMenu, authenticated ? labels[lang].manage : labels[lang].signIn).click();
        const accountPage = page.locator("[data-account-settings-page]");
        await accountPage.waitFor();
        const accountHeading = accountPage.getByRole("heading", {
          name: labels[lang].manage,
          exact: true,
        });
        await accountHeading.waitFor();
        await assertFocused(
          accountHeading,
          "Account navigation moves keyboard focus to its heading",
        );
        await parentMenu.waitFor({ state: "hidden" });
        const accountNavigation = await page.evaluate(() => window.actionSnapshots.at(-1));
        assert.equal(accountNavigation.action, "account-settings");
        assert.equal(accountNavigation.menuCount, 0, "Account navigation waits for menu dismissal");
        assert.notEqual(
          accountNavigation.pointerEvents,
          "none",
          "Account navigation releases pointer locks",
        );
        await page.waitForFunction(() => window.requests.capabilities.length === 1);
        const capabilityRequest = await page.evaluate(() => window.requests.capabilities[0]);
        assert.equal(
          capabilityRequest.menuCount,
          0,
          "Account discovery runs after the menu closes",
        );
        assert.equal(capabilityRequest.dialogCount, 0, "Account management uses the Settings page");
        assert.equal(
          capabilityRequest.accountPageCount,
          1,
          "Discovery requires explicitly opened Settings",
        );
        await assertWithinViewport(accountPage, { width, height: 760 }, "Account settings page");
        assert.equal(await page.getByRole("dialog").count(), 0);
        if (!authenticated) {
          const username = accountPage.locator('input[name="username"]');
          await username.fill("draft-user");
          await username.dispatchEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
            isComposing: true,
          });
          await username.press("Escape");
          assert.ok(await accountPage.isVisible(), "Escape keeps account settings open");
          assert.equal(
            await username.inputValue(),
            "draft-user",
            "Escape preserves account drafts",
          );
        }
        if (lang === "zh" && authenticated) {
          for (const theme of ["light", "dark"]) {
            await page.evaluate(
              (value) => document.documentElement.classList.toggle("dark", value === "dark"),
              theme,
            );
            const screenshotPath = path.join(
              screenshotDir,
              `account-settings-${width}-${theme}.png`,
            );
            await page.screenshot({ path: screenshotPath, animations: "disabled" });
            screenshots.push({ theme, path: screenshotPath, width, height: 760 });
          }
          await page.evaluate(() => document.documentElement.classList.remove("dark"));
        }
        await accountPage.locator("[data-settings-back]:visible").click();
        await accountPage.waitFor({ state: "hidden" });
        await opener.waitFor();
        assert.equal(await page.evaluate(() => window.actions.at(-1)), "back");
        await assertUnlocked(page);

        await opener.click();
        const language = item(parentMenu, labels[lang].language);
        const languageMenu = page.getByRole("menu", { name: labels[lang].language, exact: true });
        await language.hover();
        await page.waitForTimeout(150); // Beyond Radix's hover-open delay.
        assert.equal(await languageMenu.isVisible(), false, "Language is explicitly opened");
        await language.focus();
        await language.press("ArrowRight");
        await languageMenu.waitFor();
        await languageMenu.getByRole("menuitemradio").first().focus();
        await page.keyboard.press("ArrowLeft");
        await languageMenu.waitFor({ state: "hidden" });
        await assertFocused(language, "ArrowLeft returns from the language submenu");
        await language.press("ArrowRight");
        await languageMenu.waitFor();
        await page.keyboard.press("Escape");
        await languageMenu.waitFor({ state: "hidden" });
        assert.ok(await parentMenu.isVisible(), "Escape closes the submenu first");
        await language.click();
        await languageMenu.waitFor();
        await item(parentMenu, labels[lang].pet).hover({ position: { x: 12, y: 12 } });
        await page.waitForTimeout(400); // Beyond Radix's pointer grace and exit animation.
        assert.ok(await languageMenu.isVisible(), "Language survives neighbouring pointer travel");
        const otherLang = lang === "zh" ? "en" : "zh";
        await languageMenu
          .getByRole("menuitemradio", {
            name: otherLang === "zh" ? "中文" : "English",
            exact: true,
          })
          .click();
        await parentMenu.waitFor({ state: "hidden" });
        await page.waitForFunction((value) => window.fixtureLanguage() === value, otherLang);
        const translatedOpener = trigger(page, otherLang, status);
        await translatedOpener.click();
        const translatedMenu = menu(page, otherLang);
        await item(translatedMenu, labels[otherLang].language).click();
        await page
          .getByRole("menu", { name: labels[otherLang].language, exact: true })
          .getByRole("menuitemradio", { name: lang === "zh" ? "中文" : "English", exact: true })
          .click();
        await translatedMenu.waitFor({ state: "hidden" });
        await page.waitForFunction((value) => window.fixtureLanguage() === value, lang);
        await assertFocused(opener, "Selecting a language returns to the account row");

        await opener.click();
        await item(parentMenu, labels[lang].activity).click();
        const activityMenu = page.getByRole("menu", { name: labels[lang].activity, exact: true });
        await item(activityMenu, labels[lang].logs).click();
        await parentMenu.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => window.actions.at(-1)), "logs");
        await opener.click();
        await item(parentMenu, labels[lang].credentials).click();
        await parentMenu.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => window.actions.at(-1)), "credentials");

        const longUsername = "very.long.account.name.".repeat(8);
        status = signedIn(longUsername, "");
        await page.evaluate((next) => window.emitStatus(next), status);
        opener = trigger(page, lang, status);
        await opener.waitFor();
        await assertWithinViewport(opener, { width, height: 760 }, "Long account row");
        await opener.click();
        await assertWithinViewport(parentMenu, { width, height: 760 }, "Long account menu");
        const header = parentMenu.getByText(longUsername, { exact: true });
        assert.equal(await header.getAttribute("title"), longUsername);
        assert.ok(
          await header.evaluate((node) => node.scrollWidth > node.clientWidth),
          "Long identities truncate",
        );

        // Resize an already-open menu to a very short viewport. Every action
        // remains reachable through the menu's own scrolling area.
        await page.setViewportSize({ width: 280, height: 200 });
        await page.waitForTimeout(100);
        await assertWithinViewport(parentMenu, { width: 280, height: 200 }, "Resized account menu");
        const logout = item(parentMenu, labels[lang].logout);
        await logout.scrollIntoViewIfNeeded();
        await assertWithinViewport(logout, { width: 280, height: 200 }, "Resized logout action");
        await logout.click();
        await parentMenu.waitFor({ state: "hidden" });
        await page.waitForFunction(() => window.requests.logout === 1);
        status = { state: "signed-out" };
        opener = trigger(page, lang, status);
        await opener.waitFor();
        assert.equal(await page.evaluate(() => window.requests.logout), 1, "Logout runs once");
        await opener.click();
        await parentMenu.waitFor();
        await item(parentMenu, labels[lang].signIn).click();
        await accountPage.waitFor();
        await assertWithinViewport(
          accountPage,
          { width: 280, height: 200 },
          "Resized account settings",
        );
        await accountPage
          .getByRole("heading", { name: labels[lang].manage, exact: true })
          .waitFor();
        assert.equal(await page.getByRole("dialog").count(), 0);
        await accountPage.locator("[data-settings-back]:visible").click();
        await accountPage.waitFor({ state: "hidden" });
        await opener.waitFor();
        await assertUnlocked(page);

        await page.evaluate(() => window.unmountFixture());
        const requests = await page.evaluate(() => window.requests);
        assert.equal(
          requests.subscriptions,
          requests.unsubscriptions,
          "Account listeners are released",
        );
        assert.deepEqual(errors, [], `${width}/${lang}/${authenticated}: browser errors`);
        assert.deepEqual(blockedRequests, [], "The fixture makes no external network requests");
        await page.close();
      }
    }
  }
  console.log(
    "PASS: account dropdown, Settings navigation, keyboard/language, logout and responsive bounds (zh/en, signed-out/in)",
  );
  console.log(JSON.stringify({ screenshots }));
} finally {
  await browser.close();
}
