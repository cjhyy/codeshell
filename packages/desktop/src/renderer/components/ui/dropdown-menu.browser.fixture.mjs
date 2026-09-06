/* Native geometry regression. Run with Node; source and Tailwind compile in memory. */
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
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
const recordOnly = process.argv.includes("--record-only");
const output = process.env.CODESHELL_MENU_QA_DIR || "/tmp/codeshell-ui-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {Button} from './components/ui/button';
  import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuSub,
    DropdownMenuSubTrigger,DropdownMenuSubContent,DropdownMenuItem,DropdownMenuLabel,
    DropdownMenuCheckboxItem,DropdownMenuRadioGroup,DropdownMenuRadioItem} from './components/ui/dropdown-menu';
  const token='provider/'+ 'VeryLongModelIdentifierWithoutSpaces'.repeat(5);
  function Fixture({lang,edge,short}) {
    const [selected,setSelected]=React.useState('');
    const provider=short?'Provider':(lang==='zh'?'模型服务商 · ':'Model provider · ')+token;
    return <main data-case={lang+'-'+edge+'-'+short} className={'min-h-screen p-3 flex '+(edge==='right'?'justify-end':'justify-start')}>
      <DropdownMenu><DropdownMenuTrigger asChild><Button id="opener">{lang==='zh'?'添加模型':'Add model'}</Button></DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Models" align={edge==='right'?'end':'start'}>
          <DropdownMenuLabel>{lang==='zh'?'可用模型':'Available models'}</DropdownMenuLabel>
          <DropdownMenuSub><DropdownMenuSubTrigger data-testid="provider">{provider}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label="Provider models">
              <DropdownMenuLabel>{lang==='zh'?'选择模型':'Choose a model'}</DropdownMenuLabel>
              {Array.from({length:28},(_,i)=><DropdownMenuItem key={i} onSelect={()=>setSelected(String(i))}>
                {i===0 ? (lang==='zh'?'完整模型名称：':'Full model name: ')+token : (lang==='zh'?'模型 ':'Model ')+i}
              </DropdownMenuItem>)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {!short&&<><DropdownMenuItem>{token}</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>{token}</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="long"><DropdownMenuRadioItem value="long">{token}</DropdownMenuRadioItem></DropdownMenuRadioGroup></>}
        </DropdownMenuContent>
      </DropdownMenu><output className="sr-only">{selected}</output>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=props=>root.render(<Fixture key={JSON.stringify(props)} {...props}/>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
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
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  for (const width of [390, 820]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const lang of ["zh", "en"]) {
      for (const edge of ["left", "right"]) {
        for (const short of [false, true]) {
          await page.evaluate((props) => window.renderFixture(props), { lang, edge, short });
          await page.locator(`[data-case="${lang}-${edge}-${short}"]`).waitFor();
          // Keep the previous mouse case from hovering a newly placed keyboard menu.
          await page.mouse.move(width - 1, 759);
          const opener = page.locator("#opener");
          await opener.focus();
          await page.keyboard.press("Enter");
          const provider = page.getByTestId("provider");
          await provider.waitFor();
          await provider.focus();
          await page.keyboard.press("ArrowRight");
          const submenu = page.locator('[role="menu"][aria-label="Provider models"]');
          await submenu.waitFor();
          await page.waitForTimeout(180); // Finish the menu's CSS entrance animation.
          const boxes = await page.locator('[role="menu"]').evaluateAll((elements) =>
            elements.map((element) => ({
              label: element.getAttribute("aria-label"),
              side: element.getAttribute("data-side"),
              rect: element.getBoundingClientRect().toJSON(),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              available: getComputedStyle(element).getPropertyValue(
                "--radix-dropdown-menu-content-available-width",
              ),
            })),
          );
          reports.push({ width, lang, edge, short, boxes });
          if (!short) {
            await page.screenshot({
              path: path.join(
                output,
                `dropdown-${recordOnly ? "before" : "after"}-${width}-${lang}-${edge}.png`,
              ),
            });
          }
          if (!recordOnly) {
            for (const box of boxes) {
              assert.ok(box.rect.left >= 10 && box.rect.right <= width - 10, JSON.stringify(box));
              assert.ok(box.scrollWidth <= box.clientWidth + 1, JSON.stringify(box));
              assert.ok(box.rect.width >= 150, "Submenus stay readable instead of collapsing");
            }
            await page.keyboard.press("End");
            await page.waitForFunction(() => /27$/.test(document.activeElement?.textContent ?? ""));
            const endScroll = await submenu.evaluate((element) => element.scrollTop);
            assert.ok(endScroll > 0, "Long lists scroll by keyboard");
            assert.match(await page.evaluate(() => document.activeElement?.textContent), /27$/);
            await page.keyboard.press("Home");
            await page.waitForFunction(() =>
              /^(完整模型名称|Full model name)/.test(document.activeElement?.textContent ?? ""),
            );
            assert.ok((await submenu.evaluate((element) => element.scrollTop)) < endScroll);
            const longItem = submenu.getByRole("menuitem").first();
            assert.ok(await longItem.evaluate((element) => element === document.activeElement));
            const text = await longItem.textContent();
            assert.ok(
              text.includes("VeryLongModelIdentifierWithoutSpaces".repeat(5)),
              "The whole label remains available",
            );
            await page.keyboard.press("ArrowLeft");
            await submenu.waitFor({ state: "hidden" });
            assert.ok(await provider.evaluate((element) => document.activeElement === element));
            await page.keyboard.press("ArrowRight");
            await submenu.waitFor();
          }
          // Standard Radix submenu Escape dismisses the complete menu family.
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 0);
          assert.ok(await opener.evaluate((element) => document.activeElement === element));
          if (!recordOnly && !short) {
            await opener.click();
            await provider.hover({ position: { x: 12, y: 12 } });
            await submenu.waitFor();
            await submenu.getByRole("menuitem").last().click();
            await page.waitForFunction(
              () => document.querySelector("output")?.textContent === "27",
            );
            await page.waitForFunction(
              () => document.querySelectorAll('[role="menu"]').length === 0,
            );
            assert.ok(await opener.evaluate((element) => document.activeElement === element));
          }
        }
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({ result: recordOnly ? "recorded" : "pass", reports }, null, 2));
} finally {
  await browser.close();
}
