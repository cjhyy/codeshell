/** Real Link provider/Figma dialogs with owned account snapshots and forbidden network. */
/* global window, document, getComputedStyle, innerWidth, innerHeight, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer"),
  repo = path.resolve(desktop, "../..");
const sourceRef = process.argv.find((value) => value.startsWith("--source-ref="))?.slice(13);
const baseline = process.argv.includes("--expect-baseline");
const development = process.argv.includes("--development");
const authorizationOnly = process.argv.includes("--authorization-only");
assert.ok(!baseline || sourceRef, "Baseline requires an explicit source ref");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-link-provider-dialog-"));
const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright");
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node"),
  { Scanner } = tw("@tailwindcss/oxide");
const source = String.raw`
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{Figma}from'lucide-react';
import{LinkProviderCard,LinkConnectionRow}from'./credentials/LinkProviderCard';import{FigmaConnectionCard}from'./credentials/FigmaConnectionCard';
import{LinkConnectionOption}from'./credentials/LinkPresentation';import{I18nProvider}from'./i18n/I18nProvider';import{DialogProvider}from'./ui/DialogProvider';import{ToastProvider}from'./ui/ToastProvider';import{saveUILanguage}from'./uiLanguage';import{translate}from'./i18n/translate';
const clone=value=>structuredClone(value);const root=createRoot(document.getElementById('root'));let generation=0;
function Fixture({lang}){
 const[snapshot,setSnapshot]=React.useState(()=>clone(window.liveSnapshot));
 const reload=async()=>{window.calls.reload++;setSnapshot(clone(window.liveSnapshot))};
 const accounts=snapshot.connections.filter(item=>item.authSource==='remote-link');
 return <main className="fixed inset-0 overflow-auto bg-background p-4 text-foreground">
 <LinkProviderCard id="figma" name="Figma" description={lang==='zh'?'查看设计文件和评论，按需添加授权文件。':'View design files and comments; add authorized files when needed.'} icon={Figma} status={snapshot.connections.length?(lang==='zh'?'已连接':'Connected'):(lang==='zh'?'未连接':'Not connected')} accounts={accounts[0]?.account.label} connectionCount={snapshot.connections.length} primaryOption="remote-link" hasConnections={snapshot.connections.length>0} tone={snapshot.connections.length?'ready':'neutral'}>
 <FigmaConnectionCard cwd="/owned/project" snapshot={snapshot} loadError="" reload={reload} onChanged={()=>window.calls.changed++}
 localApi={<LinkConnectionOption optionId="method:token:owned-local"><LinkConnectionRow data-owned-local-api title={lang==='zh'?'本机 API':'Local API'} technical="PAT" description={lang==='zh'?'使用本机保存的令牌。':'Use a locally saved token.'}><p>{snapshot.connections.some(item=>item.authSource==='manual-token')?'Owned local token account':(lang==='zh'?'未连接':'Not connected')}</p></LinkConnectionRow></LinkConnectionOption>}/>
 </LinkProviderCard></main>
}
window.mountFixture=({lang,theme,empty=false,legacy=false,remoteCount=4})=>{
 localStorage.clear();saveUILanguage(lang);document.documentElement.classList.toggle('dark',theme==='dark');
 const provider={id:'figma',displayName:'Figma',icon:'figma',description:{zh:'读取设计文件与评论。',en:'Read design files and comments.'},tokenLabel:'Token',tokenPlaceholder:'Owned placeholder',actions:[],authModes:[{id:'remote-link',methodId:'remote-link',kind:'redirect',label:'Browser',available:true,preferred:true},{id:'mcp-oauth',methodId:'mcp',kind:'redirect',label:'MCP',available:true}]};
 const connections=Array.from({length:remoteCount},(_,index)=>({id:'figma-remote-'+index,providerId:'figma',methodId:'remote-link',label:'Owned designer '+(index+1),runtime:'server',authSource:'remote-link',status:'connected',account:{id:'owned-user-'+index,label:'Owned designer '+(index+1),resources:['OwnedDisplayLabel77'],resourceGroups:[{id:'files',items:[{id:'OwnedFileKey9xA7B8C9',label:'Owned design'}]}]},capabilityIds:['figma.get_file','figma.get_comments'],revision:'owned-revision-'+index,scope:'user',editable:true}));
 if(legacy)for(const connection of connections)delete connection.account.resourceGroups;
 connections.push({id:'figma-mcp',providerId:'figma',methodId:'mcp',label:'Owned design context',runtime:'local',authSource:'mcp-oauth',status:'connected',account:{id:'owned-mcp-user',label:'Owned context user',resources:[]},capabilityIds:['figma.get_design_context'],revision:'owned-mcp-revision',scope:'user',editable:true});
 connections.push({id:'figma-local-api',providerId:'figma',methodId:'token',label:'Owned local token',runtime:'local',authSource:'manual-token',status:'connected',account:{id:'owned-local-user',label:'Owned local token account',resources:[]},capabilityIds:['figma.get_file'],revision:'owned-local-revision',scope:'project',editable:true});
 if(empty)connections.length=0;
 window.liveSnapshot={providers:[provider],connections,capabilities:{token:true,cliBinding:false,deviceAuth:false,remoteAuth:true,authorizationSteps:1},remoteServer:{issuer:'https://owned-link.invalid'},remoteCatalog:{state:'ready'},revision:'owned-snapshot'};
 window.calls={unsafe:[],disconnect:[],rename:[],open:[],start:[],cancel:[],reload:0,changed:0};window.allowAuthorization=false;window.holdSnapshot=false;window.resolveSnapshot=null;
 const forbidden=name=>(...args)=>{window.calls.unsafe.push({name,args});throw Error('Forbidden owned action '+name)};
 let attempt;const links={remoteSnapshot:async()=>{if(window.holdSnapshot)await new Promise(resolve=>window.resolveSnapshot=resolve);return clone(window.liveSnapshot)},remoteDisconnect:async(...args)=>{window.calls.disconnect.push(args);window.liveSnapshot.connections=window.liveSnapshot.connections.filter(item=>item.id!==args[1])},remoteRename:async(...args)=>{window.calls.rename.push(args)},authorizationStart:async(...args)=>{if(!window.allowAuthorization)return forbidden('authorizationStart')(...args);window.calls.start.push(args);attempt={id:args[1],providerId:'figma',state:'pending',step:{id:'owned-step',kind:'credential-input',expiresAt:new Date(Date.now()+60000).toISOString(),purpose:'credential',fields:[{id:'token',label:'Owned authorization token',secret:true,required:true,placeholder:'Owned only'}]}};return clone(attempt)},authorizationGet:async()=>{if(!window.allowAuthorization)return forbidden('authorizationGet')();return clone(attempt)},authorizationRespond:forbidden('authorizationRespond'),authorizationCancel:async(...args)=>{if(!window.allowAuthorization)return forbidden('authorizationCancel')(...args);window.calls.cancel.push(args)},authorizationOpen:forbidden('authorizationOpen')};
 window.codeshell=new Proxy({links:new Proxy(links,{get(target,key){if(key in target)return target[key];return forbidden('links.'+String(key))}}),mcpOAuth:{refresh:forbidden('mcpOAuth.refresh')},openExternal:async url=>{window.calls.open.push(url)},log:()=>{}},{get(target,key){if(key in target)return target[key];throw Error('Unexpected bridge '+String(key))}});
 window.labels={manage:translate(lang,'ext.link.directory.manageConnection'),account:translate(lang,'ext.link.directory.accountActions'),disconnect:translate(lang,'ext.link.remoteDisconnect'),confirm:translate(lang,'ext.link.remoteConfirmDisconnect'),cancel:translate(lang,'ext.link.remoteCancel'),cancelDialog:translate(lang,'common.cancel'),reconnect:translate(lang,'ext.link.remoteReconnect'),add:translate(lang,'ext.link.remoteAdd')};
 flushSync(()=>root.render(<React.StrictMode><I18nProvider key={++generation}><DialogProvider><ToastProvider><Fixture lang={lang}/></ToastProvider></DialogProvider></I18nProvider></React.StrictMode>));
};`;
const built = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  loader: { ".css": "empty", ".png": "empty", ".webp": "empty", ".wav": "empty" },
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
  plugins: sourceRef
    ? [
        {
          name: "owned-old-link-layout",
          setup(builder) {
            builder.onLoad(
              {
                filter:
                  /\/credentials\/(LinkProviderCard|LinkPresentation|RemoteLinkSection|FigmaConnectionCard)\.tsx$/,
              },
              (args) => ({
                contents: execFileSync(
                  "git",
                  [
                    "show",
                    `${sourceRef}:packages/desktop/src/renderer/credentials/${path.basename(args.path)}`,
                  ],
                  { cwd: repo, encoding: "utf8" },
                ),
                loader: "tsx",
                resolveDir: path.dirname(args.path),
              }),
            );
          },
        },
      ]
    : [],
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
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce" });
const reports = [],
  screenshots = [],
  errors = [],
  blocked = [];
await context.route("**/*", (route) =>
  route.request().url() === "http://link-provider-owned.localhost/"
    ? route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
      })
    : (blocked.push(route.request().url()), route.abort()),
);
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://link-provider-owned.localhost/");
assert.equal(
  await page.evaluate(
    () => window.isSecureContext && typeof window.crypto.randomUUID === "function",
  ),
  true,
  "Owned localhost routing preserves the production authorization UUID prerequisite",
);
await page.addStyleTag({ content: css });
await page.addScriptTag({ content: built.outputFiles[0].text });
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const dialog = () => page.locator('[data-link-provider-dialog="figma"]');
const row = () => page.locator('[data-remote-link="figma-remote-3"]');
// The native Radix menu hides its surrounding dialog from accessibility while
// open. Keep the originating DOM locator valid during that intentional state.
const trigger = () =>
  row().locator('button[aria-haspopup="menu"],button[aria-expanded][aria-controls]');
const focused = (locator) => locator.evaluate((node) => node === document.activeElement);
async function waitFocused(locator) {
  await page.waitForFunction(
    (node) => node === document.activeElement,
    await locator.elementHandle(),
  );
  assert.equal(await focused(locator), true);
}
async function geometry(locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        bounds = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left);
        clip.right = Math.min(clip.right, bounds.right);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top);
        clip.bottom = Math.min(clip.bottom, bounds.bottom);
      }
    }
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      text: node.textContent,
      box: box.toJSON(),
      clip,
      full:
        box.width > 0 &&
        box.height > 0 &&
        box.left >= clip.left - 1 &&
        box.right <= clip.right + 1 &&
        box.top >= clip.top - 1 &&
        box.bottom <= clip.bottom + 1,
      hit: node === hit || node.contains(hit),
    };
  });
}
async function screenshot(name) {
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file });
  screenshots.push(file);
}
async function open(config) {
  await page.setViewportSize({ width: config.width, height: config.height });
  await page.evaluate((config) => window.mountFixture(config), config);
  const opener = page.locator('[data-link-provider-toggle],[data-link-primary-connect="figma"]');
  await opener.click();
  await dialog().waitFor();
  await frames();
  await page.waitForFunction(
    (node) =>
      node.getAnimations().every((animation) => ["finished", "idle"].includes(animation.playState)),
    await dialog().elementHandle(),
  );
  await frames();
  return opener;
}
async function menu() {
  await trigger().click();
  const id = await trigger().getAttribute("aria-controls");
  assert.ok(id);
  const content = page.locator(`[id=${JSON.stringify(id)}]`);
  await content.waitFor();
  await page.waitForFunction(
    (node) =>
      node.getAnimations().every((animation) => ["finished", "idle"].includes(animation.playState)),
    await content.elementHandle(),
  );
  await frames();
  if (!baseline) await menuLabel(content, trigger());
  return content;
}
async function menuLabel(content, source) {
  const labelId = await content.getAttribute("aria-labelledby");
  assert.ok(labelId, "The account menu has an accessible name from its actual launcher");
  assert.equal(await source.getAttribute("id"), labelId);
  assert.equal(
    await source.evaluate((node, id) => document.getElementById(id) === node, labelId),
    true,
    "The menu label IDREF resolves to the connected More button",
  );
}
async function noAuthority({ allowExternal = false } = {}) {
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(
    calls.unsafe,
    [],
    "Managing, disclosures and menus never authorize or read provider data",
  );
  if (!allowExternal)
    assert.deepEqual(calls.open, [], "Management never opens an external provider");
  assert.deepEqual(calls.start, [], "Management never starts authorization");
  return calls;
}
try {
  const configs = baseline
    ? [{ width: 800, height: 480, lang: "zh", theme: "light" }]
    : authorizationOnly
      ? []
      : [800, 320].flatMap((width) =>
          ["zh", "en"].flatMap((lang) =>
            ["light", "dark"].map((theme) => ({
              width,
              height: width === 800 ? 480 : 360,
              lang,
              theme,
            })),
          ),
        );
  for (const config of configs) {
    const opener = await open(config);
    assert.equal(await dialog().locator("[data-remote-link]").count(), 4);
    assert.equal(await dialog().locator('[data-figma-channel="mcp"]').isVisible(), false);
    const file = row().locator('[data-link-authorized-file="OwnedFileKey9xA7B8C9"]');
    if (!baseline) {
      assert.equal(await file.count(), 1);
      assert.equal(await file.locator("button").count(), 1);
      assert.equal(await file.locator("code").isVisible(), false);
      assert.equal(
        (await row().innerText()).includes("OwnedFileKey9xA7B8C9"),
        false,
        "Raw file keys stay in advanced details",
      );
      assert.equal(
        await row().getByText("Owned designer 4", { exact: true }).count(),
        1,
        "The account name is not duplicated within its row",
      );
    }
    const content = await menu();
    const items = content.locator("button");
    assert.ok((await items.count()) >= 3);
    const measurements = [];
    for (const item of await items.all()) measurements.push(await geometry(item));
    if (baseline) {
      assert.ok(
        measurements.some((item) => !item.full || !item.hit),
        "Old menu is clipped or occluded beside the real footer",
      );
      await screenshot("before-footer-menu-800-zh-light");
      reports.push({ phase: "baseline", config, measurements });
      break;
    }
    for (const item of measurements) {
      assert.equal(item.full, true, JSON.stringify(item));
      assert.equal(item.hit, true, JSON.stringify(item));
    }
    const first = items.first(),
      last = items.last();
    await page.keyboard.press("Home");
    await waitFocused(first);
    await page.keyboard.press("ArrowDown");
    await waitFocused(items.nth(1));
    await page.keyboard.press("End");
    await waitFocused(last);
    const lastBounds = await geometry(last);
    assert.equal(lastBounds.full && lastBounds.hit, true);
    await screenshot(`after-menu-${config.width}-${config.lang}-${config.theme}`);
    await page.keyboard.press("Escape");
    await content.waitFor({ state: "hidden" });
    assert.equal(
      await dialog().isVisible(),
      true,
      "Escape closes the account menu without closing the parent dialog",
    );
    await waitFocused(trigger());
    await noAuthority();
    await dialog().locator('[data-link-advanced-toggle="figma"]').click();
    assert.equal(await dialog().locator('[data-figma-channel="mcp"]').isVisible(), true);
    assert.equal(await dialog().locator("[data-owned-local-api]").isVisible(), true);
    assert.equal(await file.locator("code").isVisible(), true);
    assert.equal(await dialog().locator("[data-link-service-diagnostics]").isVisible(), true);
    await noAuthority();
    await screenshot(`after-advanced-${config.width}-${config.lang}-${config.theme}`);
    await dialog().locator('[data-link-dialog-close="figma"]').click();
    await dialog().waitFor({ state: "hidden" });
    assert.equal(await focused(opener), true);
    reports.push({ phase: "layout-menu-keyboard-advanced", config, measurements });
  }
  if (!baseline) {
    if (!authorizationOnly) {
      await open({ width: 320, height: 360, lang: "zh", theme: "light" });
      const labels = await page.evaluate(() => window.labels);
      let content = await menu();
      await content.getByText(labels.disconnect, { exact: true }).click();
      const confirm = row().getByRole("button", { name: labels.confirm, exact: true });
      await confirm.waitFor();
      assert.deepEqual((await noAuthority()).disconnect, []);
      await row().getByRole("button", { name: labels.cancel, exact: true }).click();
      assert.deepEqual((await noAuthority()).disconnect, [], "Cancel does not disconnect");
      content = await menu();
      await content.getByText(labels.disconnect, { exact: true }).click();
      await confirm.click();
      await row().waitFor({ state: "hidden" });
      assert.deepEqual((await noAuthority()).disconnect, [
        ["/owned/project", "figma-remote-3", "owned-revision-3"],
      ]);
      assert.equal(await dialog().locator("[data-remote-link]").count(), 3);
      assert.equal(
        await page.evaluate(() =>
          window.liveSnapshot.connections.some((item) => item.id === "figma-mcp"),
        ),
        true,
        "Disconnecting API leaves MCP untouched",
      );
      reports.push({ phase: "disconnect-cancel-and-confirm-exact-identity" });
      await open({ width: 800, height: 480, lang: "en", theme: "dark" });
      const resizeLabels = await page.evaluate(() => window.labels);
      content = await menu();
      await page.evaluate(() => {
        const spinner = document.createElement("span");
        spinner.className = "animate-spin";
        spinner.style.position = "absolute";
        spinner.setAttribute("data-owned-busy-spinner", "");
        document.querySelector("[data-link-provider-dialog]").append(spinner);
      });
      await page.setViewportSize({ width: 320, height: 240 });
      await content.waitFor({ state: "hidden" });
      assert.equal(await dialog().isVisible(), true, "Resize closes only the anchored menu");
      await waitFocused(trigger());
      await page.waitForFunction(
        (node) => {
          const bounds = node.getBoundingClientRect();
          const clip = node.closest("[data-link-provider-details]").getBoundingClientRect();
          return (
            bounds.top >= clip.top && bounds.bottom <= clip.bottom && bounds.bottom <= innerHeight
          );
        },
        await trigger().elementHandle(),
      );
      const anchor = await geometry(trigger());
      assert.equal(anchor.full && anchor.hit, true, JSON.stringify(anchor));
      content = await menu();
      await page.keyboard.press("End");
      await waitFocused(content.locator("button").last());
      const active = page.locator(":focus");
      const data = await geometry(active);
      assert.equal(data.full && data.hit, true, JSON.stringify(data));
      await screenshot("after-menu-live-resize-320-240-en-dark");
      await active.click();
      await content.waitFor({ state: "hidden" });
      await row().getByRole("button", { name: resizeLabels.confirm, exact: true }).waitFor();
      await row().getByRole("button", { name: resizeLabels.cancel, exact: true }).click();
      assert.equal(await dialog().isVisible(), true);
      await noAuthority();
      reports.push({ phase: "menu-live-resize-close-and-reopen-320-240", anchor, data });
      await open({ width: 800, height: 480, lang: "en", theme: "dark" });
      content = await menu();
      await page.setViewportSize({ width: 320, height: 240 });
      await content.waitFor({ state: "hidden" });
      await waitFocused(trigger());
      const other = dialog().locator('[data-link-dialog-close="figma"]');
      await other.focus();
      await page.waitForTimeout(350);
      assert.equal(await focused(other), true, "Resize recovery preserves newer dialog focus");
      await noAuthority();
      reports.push({ phase: "menu-resize-preserves-newer-focus" });
      for (const lang of ["zh", "en"]) {
        await open({ width: 320, height: 240, lang, theme: "light", empty: true });
        const footer = dialog().locator('[data-link-advanced-toggle="figma"]').locator("..");
        assert.equal(await footer.locator("button").count(), 3);
        const controls = [];
        for (const button of await footer.locator("button").all()) {
          const bounds = await geometry(button);
          assert.equal(bounds.full && bounds.hit, true, JSON.stringify(bounds));
          controls.push(bounds);
        }
        await noAuthority();
        await screenshot(`after-unconnected-footer-320-${lang}`);
        reports.push({ phase: "unconnected-footer", lang, controls });
      }
      await open({ width: 320, height: 360, lang: "en", theme: "light" });
      await row().locator("[data-link-authorized-file] button").click();
      assert.deepEqual(
        (await noAuthority({ allowExternal: true })).open,
        ["https://www.figma.com/design/OwnedFileKey9xA7B8C9"],
        "Explicit file entry opens only the reviewed synthetic URL without reading the provider",
      );
      reports.push({ phase: "explicit-file-entry-owned-external-only" });
      await open({ width: 320, height: 360, lang: "en", theme: "light", legacy: true });
      assert.equal(
        await row().locator("[data-link-authorized-files] button").count(),
        0,
        "Legacy display labels never become guessed file URLs",
      );
      await noAuthority();
      reports.push({ phase: "legacy-display-label-is-not-a-file-authority" });
      await open({ width: 800, height: 480, lang: "zh", theme: "light", remoteCount: 1 });
      assert.equal(await dialog().locator("[data-remote-link]").count(), 1);
      assert.equal(await page.evaluate(() => window.liveSnapshot.connections.length), 3);
      await noAuthority();
      await screenshot("after-default-overview-800-zh-light-three-connections");
      reports.push({ phase: "default-overview-three-connections" });
    }
    for (const kind of ["reconnect", "add", "mcp"]) {
      let content;
      await open({ width: 800, height: 480, lang: "en", theme: "light" });
      const labels = await page.evaluate(() => window.labels);
      await page.evaluate(() => {
        window.allowAuthorization = true;
      });
      let sourceTrigger;
      if (kind === "mcp") {
        await dialog().locator('[data-link-advanced-toggle="figma"]').click();
        sourceTrigger = dialog().locator(
          '[data-figma-mcp-connection="figma-mcp"] button[aria-haspopup="menu"]',
        );
        await sourceTrigger.click();
        const mcpMenu = page.getByRole("menu");
        await menuLabel(mcpMenu, sourceTrigger);
        await page.evaluate(() => {
          window.holdSnapshot = true;
        });
        await mcpMenu.getByText(labels.reconnect, { exact: true }).click();
        await page.waitForFunction(() => typeof window.resolveSnapshot === "function");
        await mcpMenu.waitFor({ state: "hidden" });
        // Exercise the transient BODY focus seen during async menu teardown.
        // The eventual dialog must retain the launcher captured at activation.
        await page.evaluate(() => {
          document.activeElement.blur();
          window.holdSnapshot = false;
          window.resolveSnapshot();
        });
      } else {
        content = await menu();
        sourceTrigger = trigger();
        await content.getByText(labels[kind], { exact: true }).click();
      }
      const authorization = page.locator(".link-authorization-dialog");
      await authorization.waitFor();
      try {
        await authorization.getByLabel("Owned authorization token").waitFor();
      } catch (cause) {
        await screenshot(`authorization-failure-${kind}`);
        await writeFile(
          path.join(output, "authorization-failure.json"),
          JSON.stringify(
            await page.evaluate(() => ({
              text: document.body.innerText,
              calls: window.calls,
              activeTag: document.activeElement.tagName,
              activeText: document.activeElement.textContent,
              dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => ({
                className: node.className,
                text: node.textContent,
              })),
            })),
            null,
            2,
          ),
        );
        throw cause;
      }
      await page.waitForFunction(() =>
        document.querySelector(".link-authorization-dialog")?.contains(document.activeElement),
      );
      await page.evaluate(async () => {
        for (let frame = 0; frame < 12; frame++)
          await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      assert.equal(
        await authorization.evaluate((node) => node.contains(document.activeElement)),
        true,
        "Closing the menu cannot reclaim focus from the newly opened authorization dialog",
      );
      const start = await page.evaluate(() => window.calls.start);
      assert.equal(start.length, 1);
      assert.equal(start[0][0], "/owned/project");
      const input = start[0][2];
      assert.equal(input.providerId, "figma");
      if (kind === "mcp") {
        assert.equal(input.connectionId, "figma-mcp");
        assert.equal(input.expectedRevision, "owned-mcp-revision");
        assert.equal(start[0][3], "mcp-oauth");
      } else if (kind === "reconnect") {
        assert.equal(input.connectionId, "figma-remote-3");
        assert.equal(input.expectedRevision, "owned-revision-3");
        assert.equal(start[0][3], "remote-link");
      } else {
        assert.equal(input.connectionId, undefined);
        assert.equal(input.expectedRevision, null);
      }
      await authorization.getByRole("button", { name: labels.cancelDialog, exact: true }).click();
      await authorization.waitFor({ state: "hidden" });
      try {
        await waitFocused(sourceTrigger);
      } catch (cause) {
        const failure = await sourceTrigger.evaluate((node) => ({
          sourceConnected: node.isConnected,
          sourceLabel: node.getAttribute("aria-label"),
          sourceFocused: node === document.activeElement,
          activeTag: document.activeElement.tagName,
          activeLabel: document.activeElement.getAttribute("aria-label"),
          activeText: document.activeElement.textContent?.slice(0, 80),
          insideProvider: !!document.activeElement.closest("[data-link-provider-dialog]"),
          calls: window.calls,
        }));
        reports.push({ phase: "authorization-cancel-focus-failure", kind, failure });
        await screenshot(`authorization-cancel-focus-failure-${kind}`);
        console.log("AUTHORIZATION_CANCEL_FOCUS", JSON.stringify(failure));
        throw cause;
      }
      assert.equal(await dialog().isVisible(), true);
      const calls = await page.evaluate(() => window.calls);
      assert.deepEqual(calls.unsafe, []);
      assert.deepEqual(calls.disconnect, []);
      assert.ok(
        calls.cancel.some((args) => args[0] === "/owned/project" && args[1] === start[0][1]),
      );
      reports.push({ phase: "menu-to-owned-authorization", kind, start, cancel: calls.cancel });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} finally {
  await context.close();
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { sourceRef, baseline, development, reports, screenshots, errors, blocked },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, observations: reports.length, screenshots, errors, blocked }),
  );
}
