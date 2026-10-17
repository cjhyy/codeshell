/* Production personalization form; all Host calls and network are fixture-owned. */
/* global window, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const output = process.env.CODESHELL_PET_SETTINGS_QA_DIR || "/tmp/codeshell-pet-settings-qa";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PetPersonalizationPage} from './pet/PetSettingsPage';
import {I18nProvider} from './i18n/I18nProvider';
import {saveUILanguage} from './uiLanguage';
import {ToastProvider} from './ui/ToastProvider';
import {applyTheme} from './theme';
let reads=[],writes=[],settings={responseLanguage:'中文',userProfile:'Existing profile',communicationStyle:'Concise',customInstructions:'Existing instructions'};
window.fixture={
  get reads(){return reads.length},get writes(){return writes.map(({value})=>value)},
  finishRead(index,success){const operation=reads[index];if(!operation)throw new Error('Missing read');
    if(success)operation.resolve({pet:{personalization:structuredClone(settings)}});
    else operation.reject(new Error('Fixture settings read denied: '+'LongIdentifier'.repeat(40)));},
  finishWrite(index,success){const operation=writes[index];if(!operation)throw new Error('Missing write');
    if(success){settings=structuredClone(operation.value);operation.resolve();}else operation.reject(new Error('Fixture settings write denied'));},
};
window.codeshell={
  getSettings:scope=>{if(scope!=='user')throw new Error('Wrong settings scope');return new Promise((resolve,reject)=>reads.push({resolve,reject}));},
  updateSettings:(scope,patch)=>{if(scope!=='user')throw new Error('Wrong write scope');return new Promise((resolve,reject)=>writes.push({value:structuredClone(patch.pet.personalization),resolve,reject}));},
  log:()=>{},
};
const root=createRoot(document.getElementById('root'));
function Fixture(){
  const [open,setOpen]=React.useState(true);
  window.leaveFixture=()=>setOpen(false);window.reopenFixture=()=>setOpen(true);
  return <div className='flex h-full flex-col bg-background text-foreground'>
    {open?<PetPersonalizationPage onBack={()=>setOpen(false)}/>:<p id='left-page'>Left personalization</p>}
  </div>;
}
window.renderFixture=({lang,mode})=>{
  saveUILanguage(lang);applyTheme(mode);
  root.render(<React.StrictMode><I18nProvider><ToastProvider><Fixture/></ToastProvider></I18nProvider></React.StrictMode>);
};
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".png": "empty", ".webp": "empty", ".wav": "empty", ".css": "empty" },
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
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const errors = [],
  blocked = [],
  reports = [];
async function mount(width, lang, mode) {
  const page = await browser.newPage({
    viewport: { width, height: 600 },
    serviceWorkers: "block",
    colorScheme: mode,
  });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://pet-settings-fixture.test/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://pet-settings-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((options) => window.renderFixture(options), { lang, mode });
  await page.waitForFunction(() => window.fixture.reads === 2);
  return page;
}
async function geometry(page, phase) {
  const snapshot = await page.locator("[data-pet-personalization-fields]").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: window.innerWidth,
      left: rect.left,
      right: rect.right,
      client: element.clientWidth,
      scroll: element.scrollWidth,
    };
  });
  assert(
    snapshot.left >= 0 && snapshot.right <= snapshot.width + 1,
    `${phase}: form within viewport`,
  );
  assert(snapshot.scroll <= snapshot.client + 1, `${phase}: long text wraps`);
}
try {
  for (const width of [390, 1000])
    for (const lang of ["zh", "en"]) {
      const mode = lang === "zh" ? "light" : "dark";
      const page = await mount(width, lang, mode);
      const fields = page.locator("input,textarea");
      for (const field of await fields.all())
        assert(await field.isDisabled(), "Fields wait for the settings snapshot");
      await page.evaluate(() => window.fixture.finishRead(1, false));
      await page.getByRole("alert").first().waitFor();
      await geometry(page, "read-error");
      const retry = page.getByRole("button", {
        name: lang === "zh" ? "重试" : "Retry",
        exact: true,
      });
      await retry.click();
      await page.waitForFunction(() => window.fixture.reads === 3);
      for (const field of await fields.all())
        assert(await field.isDisabled(), "Retry keeps uninitialized fields disabled");
      await page.evaluate(() => window.fixture.finishRead(2, true));
      await page.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
      assert.equal(await page.locator("#pet-user-profile").inputValue(), "Existing profile");
      await page.locator("#pet-user-profile").fill("My latest profile");
      await page.locator("#pet-user-profile").blur();
      await page.waitForFunction(() => window.fixture.writes.length === 1);
      // A StrictMode read from the discarded mount cannot replace the edited form.
      await page.evaluate(() => window.fixture.finishRead(0, true));
      assert.equal(await page.locator("#pet-user-profile").inputValue(), "My latest profile");
      await page.evaluate(() => window.fixture.finishWrite(0, false));
      await page.locator('[data-pet-personalization-fields] [role="alert"]').waitFor();
      assert.equal(
        await page.locator("#pet-custom-instructions").inputValue(),
        "Existing instructions",
      );
      await retry.click();
      await page.waitForFunction(() => window.fixture.writes.length === 2);
      const retryDraft = await page.evaluate(() => window.fixture.writes[1]);
      assert.deepEqual(retryDraft, {
        responseLanguage: "中文",
        userProfile: "My latest profile",
        communicationStyle: "Concise",
        customInstructions: "Existing instructions",
      });
      // Save a newer draft while the previous write is still in flight.
      await page.locator("#pet-user-profile").fill("Newest profile");
      await page.locator("#pet-user-profile").blur();
      await page.waitForTimeout(650);
      assert.equal(
        await page.evaluate(() => window.fixture.writes.length),
        2,
        "Writes are serialized",
      );
      await page.evaluate(() => window.fixture.finishWrite(1, true));
      await page.waitForFunction(() => window.fixture.writes.length === 3);
      assert.equal(
        await page.evaluate(() => window.fixture.writes[2].userProfile),
        "Newest profile",
      );
      await page.evaluate(() => window.fixture.finishWrite(2, true));
      await page
        .locator('[data-pet-personalization-fields] [role="alert"]')
        .waitFor({ state: "hidden" });
      await geometry(page, "ready");
      await page.screenshot({
        path: path.join(output, `personalization-${width}-${lang}-${mode}.png`),
      });
      reports.push({
        width,
        lang,
        mode,
        readRecovery: true,
        draftPreserved: true,
        orderedWrites: true,
      });
      await page.close();
    }
  // Leaving the page flushes a debounce to its original draft and handles rejection.
  const page = await mount(390, "zh", "light");
  await page.evaluate(() => window.fixture.finishRead(1, true));
  await page.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
  await page.locator("#pet-user-profile").fill("Navigation draft");
  // Programmatic navigation avoids blur, so this exercises cleanup's flush.
  await page.evaluate(() => window.leaveFixture());
  await page.locator("#left-page").waitFor();
  await page.waitForFunction(() => window.fixture.writes.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.writes[0].userProfile), "Navigation draft");
  await page.evaluate(() => window.fixture.finishWrite(0, false));
  await page.getByRole("status").filter({ hasText: "个性化设置保存失败" }).waitFor();
  await page.close();

  // A reopened form waits for the previous instance's queued snapshots.
  const reopened = await mount(390, "zh", "light");
  await reopened.evaluate(() => window.fixture.finishRead(1, true));
  await reopened.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
  await reopened.locator("#pet-user-profile").fill("First pending draft");
  await reopened.locator("#pet-user-profile").blur();
  await reopened.waitForFunction(() => window.fixture.writes.length === 1);
  await reopened.locator("#pet-custom-instructions").fill("Latest pending instructions");
  await reopened.evaluate(() => window.leaveFixture());
  await reopened.locator("#left-page").waitFor();
  await reopened.evaluate(() => window.reopenFixture());
  await reopened.locator("#pet-user-profile").waitFor();
  assert(await reopened.locator("#pet-user-profile").isDisabled());
  assert.equal(
    await reopened.evaluate(() => window.fixture.reads),
    2,
    "New reads wait for the queue",
  );
  await reopened.evaluate(() => window.fixture.finishWrite(0, true));
  await reopened.waitForFunction(() => window.fixture.writes.length === 2);
  assert.equal(await reopened.evaluate(() => window.fixture.reads), 2);
  await reopened.evaluate(() => window.fixture.finishWrite(1, true));
  await reopened.waitForFunction(() => window.fixture.reads === 4);
  await reopened.evaluate(() => window.fixture.finishRead(3, true));
  await reopened.waitForFunction(() => !document.getElementById("pet-response-language").disabled);
  assert.equal(await reopened.locator("#pet-user-profile").inputValue(), "First pending draft");
  assert.equal(
    await reopened.locator("#pet-custom-instructions").inputValue(),
    "Latest pending instructions",
  );
  await reopened.close();
  assert.deepEqual(errors, [], "No unhandled renderer errors");
  assert.deepEqual(blocked, [], "No external network requests");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ reports, errors, blocked }, null, 2),
  );
  console.log(
    JSON.stringify(
      { result: "pass", scenarios: reports.length + 2, errors, blocked, output },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
