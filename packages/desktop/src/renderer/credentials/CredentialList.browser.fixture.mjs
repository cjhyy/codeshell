/* Fixture-owned credential reads: real keyboard recovery and scoped late replies. */
/* global window, document, innerWidth */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const renderer = path.join(desktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tw = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tw("@tailwindcss/node");
const { Scanner } = tw("@tailwindcss/oxide");
const source = `
import React from'react';import{createRoot}from'react-dom/client';import{CredentialsPage}from'./credentials/CredentialsPage';import{I18nProvider}from'./i18n/I18nProvider';import{saveUILanguage}from'./uiLanguage';import{DialogProvider}from'./ui/DialogProvider';import{ToastProvider}from'./ui/ToastProvider';
const root=createRoot(document.getElementById('root'));
window.calls=[];window.codeshell={credentials:{list:cwd=>new Promise((resolve,reject)=>window.calls.push({cwd,resolve,reject}))}};
function Fixture({category}){const[cwd,setCwd]=React.useState('/first');window.setProject=setCwd;return <CredentialsPage activeProjectPath={cwd} initialTab={category}/>}
window.mountFixture=({category,language,dark})=>{saveUILanguage(language);document.documentElement.classList.toggle('dark',dark);root.render(<I18nProvider><ToastProvider><DialogProvider><Fixture category={category}/></DialogProvider></ToastProvider></I18nProvider>)};
window.reply=(index,label)=>window.calls[index].resolve(['cookie','token'].map(type=>({id:label+'-'+type,type,label:label+' '+type,hasSecret:true,meta:{platform:'owned'}})));
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: path.join(desktop, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
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
  for (const width of [1000, 390]) {
    for (const language of ["zh", "en"]) {
      for (const category of ["cookie", "token"]) {
        const page = await browser.newPage({ viewport: { width, height: 500 } });
        page.setDefaultTimeout(5000);
        const errors = [],
          blocked = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          if (route.request().url() === "http://credentials.test/")
            return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
          blocked.push(route.request().url());
          return route.abort();
        });
        await page.goto("http://credentials.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate((config) => window.mountFixture(config), {
          category,
          language,
          dark: language === "en",
        });
        await page.waitForFunction(() => window.calls.length === 1);
        assert.equal(await page.getByRole("article").count(), 0);
        await page.evaluate(() => window.calls[0].reject(Error("Owned_read_failure_".repeat(40))));
        await page.getByRole("alert").waitFor();
        assert.equal(await page.getByText(language === "zh" ? "加载中…" : "Loading…").count(), 0);
        const fits = await page.evaluate(() => {
          const page = document.querySelector("[data-credentials-page]");
          return (
            page.scrollWidth <= page.clientWidth + 1 && document.body.scrollWidth <= innerWidth + 1
          );
        });
        assert.equal(fits, true, "Long read errors wrap inside a narrow credentials page");
        const retry = page.getByRole("button", {
          name: language === "zh" ? "重试" : "Retry",
          exact: true,
        });
        await retry.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.calls.length === 2);
        assert.equal(await retry.isDisabled(), true, "Retry stays present and locks while pending");
        await page.evaluate(() => window.reply(1, "Saved"));
        await page.getByRole("article", { name: "Saved " + category }).waitFor();
        assert.equal(await page.getByRole("alert").count(), 0);
        await page.evaluate(() => window.setProject("/second"));
        await page.waitForFunction(() => window.calls.length === 3);
        assert.equal(
          await page.getByRole("article").count(),
          0,
          "A new project never shows the old snapshot",
        );
        await page.evaluate(() => window.setProject("/third"));
        await page.waitForFunction(() => window.calls.length === 4);
        await page.evaluate(() => window.reply(3, "Third"));
        await page.getByRole("article", { name: "Third " + category }).waitFor();
        await page.evaluate(() => window.reply(2, "Late second"));
        await page.waitForTimeout(50);
        assert.equal(
          await page.getByRole("article", { name: "Late second " + category }).count(),
          0,
        );
        assert.equal(await page.getByRole("article", { name: "Third " + category }).count(), 1);
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
        await page.close();
        console.log(
          `PASS ${width}/${language}/${category}: read error, keyboard retry, long text, stale scope`,
        );
      }
    }
  }
} finally {
  await browser.close();
}
