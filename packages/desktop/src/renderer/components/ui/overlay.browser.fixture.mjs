/* Native geometry regression. Production React and Tailwind compile in memory. */
/* global document, window, getComputedStyle */
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
const recordOnly = process.argv.includes("--record-only");
const output = process.env.CODESHELL_OVERLAY_QA_DIR || "/tmp/codeshell-overlay-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {Button} from './components/ui/button';
  import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from './components/ui/dialog';
  import {Popover,PopoverTrigger,PopoverContent} from './components/ui/popover';
  import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from './components/ui/select';
  import {Combobox} from './components/ui/combobox';
  const token='provider/'+ 'VeryLongIdentifierWithoutSpaces'.repeat(7);
  const options=Array.from({length:28},(_,i)=>({value:String(i),label:i===0?'完整模型名称 / Full model name: '+token:'模型 / Model '+i}));
  function Fields(){return <div className="grid gap-3">{Array.from({length:16},(_,i)=><label className="grid gap-1 text-sm" key={i}>设置 / Setting {i}<input aria-label={'Setting '+i} className="cs-control h-9 w-full rounded-md px-2" defaultValue={'Value '+i}/></label>)}</div>}
  function Fixture({kind}) {
    const [selected,setSelected]=React.useState('');
    return <main data-case={kind} className="fixed inset-0 z-50 bg-background p-3">
      <p>Settings layer (z-50)</p>
      <Dialog defaultOpen><DialogContent data-testid={kind==='dialog'?'overlay':'host'}>
        <DialogHeader><DialogTitle>页面设置 / Page settings</DialogTitle><DialogDescription>Small-window overlay regression</DialogDescription></DialogHeader>
        {kind==='dialog'?<><p className="text-sm">完整说明 / Complete description</p><Fields/><DialogFooter><Button id="last-action" onClick={()=>setSelected('saved')}>保存设置 / Save settings</Button></DialogFooter></>:<>
          {kind==='popover'&&<Popover><PopoverTrigger asChild><Button id="opener">更多设置 / More settings</Button></PopoverTrigger><PopoverContent data-testid="overlay" className="w-[34rem] p-3"><p>{token}</p><Fields/><Button id="last-action" onClick={()=>setSelected('saved')}>保存设置 / Save settings</Button></PopoverContent></Popover>}
          {kind==='select'&&<Select value={selected} onValueChange={setSelected}><SelectTrigger id="opener" aria-label="Choose model"><SelectValue placeholder="选择模型 / Choose model"/></SelectTrigger><SelectContent data-testid="overlay">{options.map(o=><SelectItem value={o.value} key={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>}
          {kind==='combobox'&&<Combobox options={options} value={selected} onChange={setSelected} ariaLabel="Search models" triggerClassName="w-full"/>}
        </>}
      </DialogContent></Dialog><output className="sr-only">{selected}</output>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=props=>root.render(<Fixture key={props.kind} {...props}/>);
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
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CODESHELL_TEST_CHROMIUM
    ? { executablePath: process.env.CODESHELL_TEST_CHROMIUM }
    : {}),
});
const reports = [];
const failures = [];
function check(condition, message, context) {
  if (!condition) failures.push({ message, ...context });
}
async function geometry(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.max(0, Math.min(window.innerWidth - 1, rect.x + rect.width / 2)),
      Math.max(0, Math.min(window.innerHeight - 1, rect.y + rect.height / 2)),
    );
    return {
      rect: rect.toJSON(),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      zIndex: getComputedStyle(element).zIndex,
      hit: hit === element || element.contains(hit),
      hitTag: hit?.tagName,
      hitText: hit?.textContent?.slice(0, 100),
      pointerEvents: getComputedStyle(element).pointerEvents,
    };
  });
}
async function inspect(page, kind, viewport, phase) {
  const context = { kind, viewport, phase };
  const overlay = kind === "combobox" ? page.locator("[cmdk-root]") : page.getByTestId("overlay");
  // Combobox's production Popover has no test-only attributes.
  const surface = kind === "combobox" ? overlay.locator("..") : overlay;
  const box = await geometry(surface);
  reports.push({ ...context, box });
  const { left, top, right, bottom } = box.rect;
  check(
    left >= 8 && top >= 8 && right <= viewport.width - 8 && bottom <= viewport.height - 8,
    "Overlay stays inside viewport with an inset",
    { ...context, box },
  );
  check(box.scrollWidth <= box.clientWidth + 1, "Content has no horizontal clipping", {
    ...context,
    box,
  });
  if (kind !== "dialog") {
    check(box.hit, "Child overlay receives pointer hits", { ...context, box });
  }
  if (kind === "dialog" || kind === "popover") {
    const action = page.locator("#last-action");
    await action.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    const end = await geometry(action);
    check(
      end.rect.top >= 8 && end.rect.bottom <= viewport.height - 8 && end.hit,
      "Final form action is reachable by scrolling",
      { ...context, action: end },
    );
    const lastField = page.getByRole("textbox", { name: "Setting 15", exact: true });
    await lastField.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    const field = await geometry(lastField);
    check(
      field.rect.top >= 8 && field.rect.bottom <= viewport.height - 8 && field.hit,
      "Last form field is reachable by scrolling",
      { ...context, field },
    );
    await surface.evaluate((element) => {
      element.scrollTop = 0;
    });
  } else {
    // End/Home exercise Radix/cmdk's keyboard scrolling, including after a live resize.
    if (kind === "combobox") await page.locator("[cmdk-input]").focus();
    await page.keyboard.press("End");
    await page.waitForTimeout(60);
    const lastOption =
      kind === "select" ? page.getByRole("option").last() : page.locator("[cmdk-item]").last();
    const selected = await lastOption.evaluate(
      (element) =>
        element === document.activeElement || element.getAttribute("aria-selected") === "true",
    );
    check(selected, "End selects the final list option by keyboard", context);
    if (!selected)
      reports.push({
        ...context,
        focus: await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          label: document.activeElement?.getAttribute("aria-label"),
          text: document.activeElement?.textContent?.slice(0, 100),
        })),
      });
    const end = await geometry(lastOption);
    check(
      end.rect.top >= 8 && end.rect.bottom <= viewport.height - 8 && end.hit,
      "Final list option is reachable by scrolling",
      { ...context, option: end },
    );
    if (kind === "combobox") {
      const search = await geometry(page.locator("[cmdk-input]"));
      const scrolled = await geometry(surface);
      check(
        search.rect.top >= scrolled.rect.top &&
          search.rect.bottom <= scrolled.rect.bottom &&
          search.hit,
        "Combobox search stays visible when results scroll",
        { ...context, search, scrolled },
      );
      check(
        scrolled.scrollTop === 0 && (await geometry(page.locator("[cmdk-list]"))).scrollTop > 0,
        "Combobox scrolls its results without scrolling away search",
        context,
      );
    }
    await page.keyboard.press("Home");
    const firstOption =
      kind === "select" ? page.getByRole("option").first() : page.locator("[cmdk-item]").first();
    check(
      (await firstOption.textContent()).includes("VeryLongIdentifierWithoutSpaces".repeat(7)),
      "The complete long option label remains in the accessible content",
      context,
    );
  }
  await page.screenshot({
    path: path.join(
      output,
      `${recordOnly ? "before" : "after"}-${kind}-${viewport.width}x${viewport.height}-${phase}.png`,
    ),
  });
}
try {
  for (const kind of ["dialog", "popover", "select", "combobox"]) {
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 800, height: 360 },
      { width: 390, height: 320 },
      ...(kind === "combobox" ? [{ width: 320, height: 200 }] : []),
    ]) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<div id="root" data-theme-surface="window"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((kind) => window.renderFixture({ kind }), kind);
      await page.getByTestId(kind === "dialog" ? "overlay" : "host").waitFor();
      if (kind !== "dialog") {
        const trigger =
          kind === "combobox"
            ? page.getByRole("combobox", { name: "Search models" })
            : page.locator("#opener");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await (
          kind === "combobox" ? page.locator("[cmdk-root]") : page.getByTestId("overlay")
        ).waitFor();
      }
      await page.waitForTimeout(220);
      await inspect(page, kind, viewport, "open");
      if (viewport.width === 1024) {
        const resized = { width: 390, height: 320 };
        await page.setViewportSize(resized);
        await page.waitForTimeout(220);
        // Radix Select deliberately dismisses on window resize; reopening must
        // calculate its bounds from the new viewport rather than stale space.
        if (kind === "select") {
          reports.push({
            kind,
            viewport: resized,
            phase: "resize-dismiss",
            closed: (await page.getByTestId("overlay").count()) === 0,
          });
          await page.locator("#opener").focus();
          await page.keyboard.press("Enter");
          await page.getByTestId("overlay").waitFor();
          await page.waitForTimeout(220);
        }
        await inspect(page, kind, resized, "resize");
      }
      if (
        !recordOnly &&
        !failures.some((failure) => failure.kind === kind && failure.viewport === viewport)
      ) {
        if (kind === "dialog" || kind === "popover") {
          await page.locator("#last-action").click();
          await page.waitForFunction(
            () => document.querySelector("output")?.textContent === "saved",
          );
        } else {
          if (kind === "combobox") await page.locator("[cmdk-input]").focus();
          await page.keyboard.press("End");
          const lastOption =
            kind === "select"
              ? page.getByRole("option").last()
              : page.locator("[cmdk-item]").last();
          await lastOption.click();
          await page.waitForFunction(() => document.querySelector("output")?.textContent === "27");
        }
        if (kind === "select") {
          await page.locator("#opener").click();
          await page.getByTestId("overlay").waitFor();
        }
        if (kind === "combobox") {
          await page.getByRole("combobox", { name: "Search models" }).click();
          const input = page.locator("[cmdk-input]");
          await input.click();
          await input.pressSequentially("Model 27");
          await page.waitForFunction(() => document.querySelectorAll("[cmdk-item]").length === 1);
          check(
            (await page.locator("[cmdk-item]").textContent()).includes("Model 27"),
            "Nested Combobox accepts search typing",
            { kind, viewport },
          );
        }
        await page.keyboard.press("Escape");
        if (kind === "dialog") {
          await page.getByTestId("overlay").waitFor({ state: "hidden" });
        } else {
          await (
            kind === "combobox" ? page.locator("[cmdk-root]") : page.getByTestId("overlay")
          ).waitFor({ state: "hidden" });
          check(
            await page.getByTestId("host").isVisible(),
            "Escape dismisses only the child overlay",
            { kind, viewport },
          );
          // FocusScope restores focus in a deferred unmount callback.
          const focusRestored = await page
            .waitForFunction(
              (selector) => document.querySelector(selector) === document.activeElement,
              kind === "combobox" ? '[aria-label="Search models"]' : "#opener",
              { timeout: 1000 },
            )
            .then(
              () => true,
              () => false,
            );
          check(focusRestored, "Escape restores focus to the child trigger", { kind, viewport });
        }
      }
      check(errors.length === 0, "No browser runtime errors", { kind, viewport, errors });
      await page.close();
    }
  }
  const result = {
    result: recordOnly ? "recorded" : failures.length ? "fail" : "pass",
    reports,
    failures,
  };
  const reportPath = path.join(output, recordOnly ? "before.json" : "after.json");
  await writeFile(reportPath, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify(
      {
        result: result.result,
        geometrySnapshots: reports.filter((report) => report.box).length,
        failures: failures.length,
        reportPath,
      },
      null,
      2,
    ),
  );
  if (!recordOnly) assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
} finally {
  await browser.close();
}
