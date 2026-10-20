/* Real Files and theme-audio dropdowns, plus shared Select keyboard behavior. */
/* global document, window, FormData, requestAnimationFrame */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const output = "/tmp/codeshell-dropdown-qa";
const formOnly = process.argv.includes("--form-only");
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {FilesPanel} from './panels/FilesPanel';
  import {ThemeAudioSection} from './settings/ThemeAudioSection';
  import {SimpleSelect} from './components/ui/simple-select';
  import {I18nProvider} from './i18n/I18nProvider';
  import {translate} from './i18n/translate';
  import {saveUILanguage} from './uiLanguage';
  import {themeMusic} from './theme-music';
  const longPath='/Users/demo/Projects/design-system/'+('component-library-with-a-long-directory-name/'.repeat(5))+'reference';
  const roots=[
    {id:'root-main',name:'codeshell',path:'/Users/demo/Projects/codeshell',addedAt:1},
    {id:'root-design',name:'design-system',path:longPath,addedAt:2},
    ...['Reference materials','Research notes','Shared assets','Archive'].map((name,index)=>({
      id:'root-'+index,name,path:'/Users/demo/Documents/'+name.replaceAll(' ','-'),addedAt:index+3,
    })),
  ];
  const longArtist='CodeShell Studio / '+('A descriptive artist and collection name '.repeat(4));
  const playable=[
    {title:'Night Walk',artist:'CodeShell Studio',file:'cstheme://fixture/night-walk.wav'},
    {title:'Quiet Focus '+('ExtendedSession'.repeat(9)),artist:longArtist,file:'cstheme://fixture/quiet-focus.wav'},
    {title:'Soft Rain',artist:'Ambient collection',file:'cstheme://fixture/soft-rain.wav'},
    {title:'Warm Light',artist:'CodeShell Studio',file:'cstheme://fixture/warm-light.wav'},
  ];
  const external={title:'External-only fixture track',artist:'Unavailable outside the app',url:'https://external.invalid/listen'};
  window.codeshell={
    readProjectDir:async(projectId,rootId,dir)=>{
      window.actions.push(['readDir',projectId,rootId,dir]);
      return [{name:'src',path:dir+'/src',isDirectory:true},{name:'README.md',path:dir+'/README.md',isDirectory:false}];
    },
    readProjectFileContent:async()=>({text:'# Project notes',language:'markdown'}),
    readImageDataUrl:async()=>null,
    onThemesChanged:()=>()=>{},
    openExternal:async(url)=>window.actions.push(['external',url]),
  };
  window.musicState=()=>themeMusic.getSnapshot();
  function Fixture({kind,lang,pane,externalOnly,presentation,formRequired,formEmpty,formDisabled,formGrouped}) {
    const [selected,setSelected]=React.useState(kind==='form'?(formDisabled?'real':''):'alpha');
    window.clearForm=()=>setSelected('');
    const displayRoots=presentation?roots.map((item,index)=>index===1?{...item,path:'/Users/demo/Projects/design-system'}:item):roots;
    const displayTracks=presentation?playable.map((item,index)=>index===1?{...item,title:'Quiet Focus',artist:'CodeShell Studio · Ambient collection'}:item):playable;
    const pack={id:'dropdown-fixture-'+lang,name:'Quiet workspace',swatch:'25 65% 45%',colors:{light:{},dark:{}},
      music:externalOnly?[external]:[displayTracks[0],external,...displayTracks.slice(1)]};
    const project={id:'project',name:'codeshell',path:roots[0].path,primaryRootId:roots[0].id,roots:displayRoots};
    const formOptions=[...(formEmpty?[{value:'',label:'No selection'}]:[]),{value:'real',label:'Real option'}];
    return <main className="fixed inset-0 flex justify-center bg-muted/50 p-3">
      <section id="dropdown-fixture" className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm"
        style={{width:pane,height:'100%',transform:'translateZ(0)'}}>
        <header className="shrink-0 border-b border-border px-4 py-3 text-sm font-medium">
          {kind==='files'?(lang==='zh'?'文件':'Files'):kind==='music'?(lang==='zh'?'主题声音':'Theme audio'):(lang==='zh'?'偏好设置':'Preferences')}
        </header>
        {kind==='files'?<div className="flex min-h-0 min-w-0 flex-1"><FilesPanel cwd={roots[0].path} project={project}/></div>
          :<div id="dropdown-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
            {kind==='music'?<ThemeAudioSection pack={pack}/>:kind==='form'?<form id="select-form">
              <SimpleSelect value={selected} onChange={setSelected} ariaLabel="Form choice" name="choice"
                required={formRequired} disabled={formDisabled} placeholder="Choose an option"
                options={formGrouped?[{label:'Choices',options:formOptions}]:formOptions}/>
            </form>:<SimpleSelect value={selected} onChange={value=>{setSelected(value);window.actions.push(['select',value])}}
              ariaLabel="Example options" options={[
                {value:'alpha',label:'Alpha',description:'The current setting'},
                {value:'beta',label:'Beta unavailable',description:'This option is disabled',disabled:true},
                {value:'gamma',label:'Gamma',description:'Long description: '+('LongIdentifierWithoutSpaces'.repeat(12))},
                {value:'zulu',label:'Zulu',description:'The final available setting'},
              ]}/>}
          </div>}
      </section>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=props=>{
    themeMusic.dispose();
    saveUILanguage(props.lang);
    document.documentElement.classList.toggle('dark',props.theme==='dark');
    window.actions=[];
    window.labels={files:translate(props.lang,'panels.files.rootPicker'),
      music:translate(props.lang,'settingsX.appearance.audio.chooseTrack'),select:'Example options'};
    root.render(<I18nProvider key={JSON.stringify(props)}><Fixture {...props}/></I18nProvider>);
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
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
const reports = [];
const failures = [];
const errors = [];
let formCases = 0;

async function fits(menu, label) {
  await menu.waitFor();
  await menu.page().waitForTimeout(180);
  const box = await menu.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      rect: rect.toJSON(),
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      portaled: !document.getElementById("dropdown-fixture").contains(node),
    };
  });
  assert.ok(
    box.rect.left >= 8 &&
      box.rect.top >= 8 &&
      box.rect.right <= box.width - 8 &&
      box.rect.bottom <= box.height - 8,
    `${label}: dropdown fits viewport ${JSON.stringify(box)}`,
  );
  assert.ok(
    box.scrollWidth <= box.clientWidth + 1,
    `${label}: no horizontal dropdown overflow ${JSON.stringify(box)}`,
  );
  assert.ok(box.portaled, `${label}: dropdown escapes transformed clipping pane`);
  return box;
}

async function reachable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  assert.ok(
    await locator.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return (
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight &&
        (hit === node || node.contains(hit))
      );
    }),
    `${label}: pointer reaches control`,
  );
}

try {
  const page = await browser.newPage({ viewport: { width: 560, height: 620 } });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://dropdown.test/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://dropdown.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const lang of formOnly ? [] : ["zh", "en"]) {
    for (const theme of ["light", "dark"]) {
      for (const viewport of [
        { width: 560, height: 620, pane: 520 },
        { width: 380, height: 260, pane: 260 },
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const kind of ["files", "music", "select"]) {
          const props = { lang, theme, kind, pane: viewport.pane };
          const label = `${kind}/${lang}/${theme}/${viewport.pane}x${viewport.height}`;
          try {
            await page.evaluate((props) => window.renderFixture(props), props);
            const labels = await page.evaluate(() => window.labels);
            const trigger = page.getByRole("combobox", { name: labels[kind], exact: true });
            await trigger.waitFor();
            await reachable(trigger, `${label}/trigger`);
            const pane = await page.locator("#dropdown-fixture").evaluate((node) => ({
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
            }));
            assert.ok(
              pane.scrollWidth <= pane.clientWidth + 1,
              `${label}: pane has no horizontal overflow ${JSON.stringify(pane)}`,
            );
            if (kind === "music") {
              const state = await page.evaluate(() => window.musicState());
              assert.equal(state.tracks.length, 4, `${label}: external-only tracks are excluded`);
              assert.ok(
                state.tracks.every((track) => track.file),
                `${label}: every available song can play locally`,
              );
              assert.equal(
                await page.locator("[data-theme-music-open]").count(),
                0,
                `${label}: no external-listening action`,
              );
            }
            await trigger.focus();
            await page.keyboard.press("Enter");
            const menu = page.getByRole("listbox");
            const geometry = await fits(menu, label);
            const text = await menu.textContent();
            assert.ok(
              kind !== "files" ||
                text.includes("component-library-with-a-long-directory-name/".repeat(5)),
              `${label}: full root path remains accessible`,
            );
            assert.ok(
              kind !== "music" ||
                text.includes("A descriptive artist and collection name ".repeat(4).trim()),
              `${label}: full track description remains accessible`,
            );
            assert.ok(
              !text.includes("External-only fixture track"),
              `${label}: external-only song is absent`,
            );
            await page.screenshot({
              path: path.join(
                output,
                `${kind}-${lang}-${theme}-${viewport.pane}x${viewport.height}-open.png`,
              ),
            });
            if (kind === "select") {
              assert.equal(
                await menu
                  .getByRole("option", { name: /Beta unavailable/ })
                  .getAttribute("data-disabled"),
                "",
                `${label}: disabled option stays disabled`,
              );
              await page.keyboard.press("Home");
              await page.waitForFunction(() =>
                document.activeElement?.textContent?.startsWith("Alpha"),
              );
              await page.keyboard.press("ArrowDown");
              await page.waitForFunction(() =>
                document.activeElement?.textContent?.startsWith("Gamma"),
              );
              await page.keyboard.press("z");
              await page.waitForFunction(() =>
                document.activeElement?.textContent?.includes("Zulu"),
              );
            }
            await page.keyboard.press("Escape");
            await menu.waitFor({ state: "hidden" });
            await page.waitForFunction(
              (node) => document.activeElement === node,
              await trigger.elementHandle(),
            );
            if (kind === "select")
              assert.deepEqual(
                await page.evaluate(() => window.actions),
                [],
                `${label}: Escape does not change selection`,
              );
            await trigger.press("Enter");
            await menu.waitFor();
            await page.keyboard.press("End");
            const last = menu.getByRole("option").last();
            await reachable(last, `${label}/last option`);
            if (kind === "select") await page.keyboard.press("Enter");
            else await last.click();
            await menu.waitFor({ state: "hidden" });
            if (kind === "files")
              await page.waitForFunction(() =>
                window.actions.some((action) => action[0] === "readDir" && action[2] === "root-3"),
              );
            if (kind === "select")
              assert.deepEqual(
                await page.evaluate(() => window.actions),
                [["select", "zulu"]],
                `${label}: keyboard commits selected option`,
              );
            if (kind === "music") {
              const state = await page.evaluate(() => window.musicState());
              assert.equal(state.selected, 3, `${label}: song selection updates shared player`);
              assert.equal(state.playing, false, `${label}: selecting music does not autoplay`);
              assert.ok(
                !(await page.evaluate(() => window.actions)).some(
                  (action) => action[0] === "external",
                ),
                `${label}: no external service is opened`,
              );
            }
            reports.push({ ...props, viewport, geometry });
          } catch (error) {
            const screenshot = path.join(
              output,
              `failure-${kind}-${lang}-${theme}-${viewport.pane}x${viewport.height}.png`,
            );
            await page.screenshot({ path: screenshot });
            failures.push({ ...props, viewport, error: error.message, screenshot });
            console.error(`${label}: ${error.message}`);
            if (process.argv.includes("--fail-fast")) throw error;
          }
        }
      }
      await page.evaluate((props) => window.renderFixture(props), {
        lang,
        theme,
        kind: "music",
        pane: 260,
        externalOnly: true,
      });
      await page.waitForFunction(() => window.musicState().tracks.length === 0);
      assert.equal(
        await page.locator("[data-theme-music-select], [data-theme-music-open]").count(),
        0,
        `${lang}/${theme}: legacy external-only pack has no song picker or external action`,
      );
    }
  }
  await page.setViewportSize({ width: 560, height: 620 });
  const formState = () =>
    page.locator("#select-form").evaluate((form) => ({
      valid: form.checkValidity(),
      data: Array.from(new FormData(form).entries()),
    }));
  for (const config of [
    { formRequired: true, formEmpty: false },
    { formRequired: true, formEmpty: true },
    { formRequired: false, formEmpty: true, formGrouped: true },
    { formRequired: true, formEmpty: false, formDisabled: true },
    { formRequired: true, formEmpty: true, formDisabled: true },
  ]) {
    await page.evaluate((props) => window.renderFixture(props), {
      lang: "en",
      theme: "light",
      kind: "form",
      pane: 520,
      ...config,
    });
    const trigger = page.getByRole("combobox", { name: "Form choice", exact: true });
    await trigger.waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const initial = await formState();
    const label = `native form ${JSON.stringify(config)}`;
    assert.equal(
      initial.valid,
      !config.formRequired || !!config.formDisabled,
      `${label}: initial native validity ${JSON.stringify(initial)}`,
    );
    assert.deepEqual(
      initial.data,
      config.formDisabled ? [] : [["choice", ""]],
      `${label}: native form serializes the public value`,
    );
    if (!config.formDisabled) {
      await trigger.click();
      await page.getByRole("option", { name: "Real option", exact: true }).click();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => new FormData(document.getElementById("select-form")).get("choice") === "real",
      );
      assert.deepEqual(
        await formState(),
        { valid: true, data: [["choice", "real"]] },
        `${label}: selecting a real option validates and serializes`,
      );
      if (config.formEmpty) {
        await trigger.click();
        await page.getByRole("option", { name: "No selection", exact: true }).click();
        await page.getByRole("listbox").waitFor({ state: "hidden" });
      } else {
        await page.evaluate(() => window.clearForm());
      }
      await page.waitForFunction(
        () => new FormData(document.getElementById("select-form")).get("choice") === "",
      );
      assert.deepEqual(
        await formState(),
        { valid: !config.formRequired, data: [["choice", ""]] },
        `${label}: clearing restores required validity and the public empty value`,
      );
    }
    formCases++;
  }
  for (const kind of ["files", "music"]) {
    await page.evaluate((props) => window.renderFixture(props), {
      lang: "zh",
      theme: "light",
      kind,
      pane: 520,
      presentation: true,
    });
    const labels = await page.evaluate(() => window.labels);
    const trigger = page.getByRole("combobox", { name: labels[kind], exact: true });
    await trigger.waitFor();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await fits(page.getByRole("listbox"), `${kind}/presentation`);
    await page.screenshot({ path: path.join(output, `preview-${kind}-light.png`) });
    await page.keyboard.press("Escape");
  }
  const result = {
    result: failures.length ? "fail" : "pass",
    cases: reports.length,
    externalOnlyCases: formOnly ? 0 : 4,
    formCases,
    failures,
    browserErrors: errors,
    output,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ ...result, reports }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], "No browser errors");
  assert.equal(failures.length, 0, "Dropdown surface browser fixture failed; see report.json");
} finally {
  await browser.close();
}
