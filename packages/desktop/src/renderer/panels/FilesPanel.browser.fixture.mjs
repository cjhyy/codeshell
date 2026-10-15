/* Production React/CSS with fixture-owned file authority; every non-fixture request is denied. */
/* global document, window, KeyboardEvent, CompositionEvent, getComputedStyle */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const sourceDesktop =
  process.argv.find((arg) => arg.startsWith("--source-desktop="))?.slice(17) ||
  process.env.CODESHELL_FILES_SOURCE_ROOT ||
  desktop;
const renderer = path.join(sourceDesktop, "src/renderer");
const require = createRequire(path.join(desktop, "package.json"));
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const baseline = process.argv.includes("--baseline");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ||
  process.env.CODESHELL_FILES_QA_DIR ||
  "/tmp/codeshell-files-panel-qa";
await mkdir(output, { recursive: true });
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {FilesPanel} from './panels/FilesPanel';
  import {CommentBox} from './chat/CommentBox';
  const longName='long-'.repeat(24)+'report.ts';
  const file=(dir,name,isDirectory=false)=>({name,path:dir+'/'+name,isDirectory});
  const directories={
    '/fixture':[file('/fixture','README.md'),file('/fixture','src',true),file('/fixture','empty',true),file('/fixture','broken',true),file('/fixture','picture.png'),file('/fixture',longName)],
    '/fixture/src':[file('/fixture/src','deep',true)],
    '/fixture/src/deep':[file('/fixture/src/deep','nested.ts')],
    '/fixture/empty':[], '/fixture/broken':[file('/fixture/broken','recovered.ts')],
    '/shared':[file('/shared','secondary.txt')],
  };
  const failures=new Set(),held=new Set(),pending=new Map();
  const calls=[],attached=[],anchors=[];
  window.fixture={calls,attached,anchors,longName,failures,held,
    release(dir){held.delete(dir);const resolve=pending.get(dir);pending.delete(dir);resolve?.();},
    comment:{cancel:0,submit:[]}};
  window.addEventListener('codeshell:add-anchor',event=>anchors.push(event.detail.anchor));
  function check(rootId,target){
    const base=rootId==='primary'?'/fixture':rootId==='secondary'?'/shared':undefined;
    if(!base || !(target===base || target.startsWith(base+'/')))throw new Error('Fixture authority mismatch');
  }
  window.codeshell={
    readProjectDir:async(projectId,rootId,dir)=>{
      assertProject(projectId);check(rootId,dir);calls.push({kind:'directory',rootId,path:dir});
      if(held.has(dir))await new Promise(resolve=>pending.set(dir,resolve));
      if(failures.has(dir))throw new Error('Folder permission expired. Please retry.');
      return directories[dir]??[];
    },
    readProjectFileContent:async(projectId,rootId,target)=>{
      assertProject(projectId);check(rootId,target);calls.push({kind:'file',rootId,path:target});
      return {path:target,size:200,text:target.endsWith('.md')?'# CodeShell UI review\\n\\nRead the current layout and check alignment.\\n\\n- Chat and composer\\n- Sidebar and panels\\n- Settings and navigation\\n':'const review = "ready";\\nconst nested = true;\\n'};
    },
  };
  function assertProject(id){if(id!=='fixture-project')throw new Error('Unexpected fixture project');}
  const project={id:'fixture-project',name:'Fixture',path:'/fixture',primaryRootId:'primary',roots:[
    {id:'primary',name:'Primary',path:'/fixture',addedAt:1},
    {id:'secondary',name:'Secondary',path:'/shared',addedAt:2}]};
  const root=createRoot(document.getElementById('root'));
  let generation=0,props={width:480,mode:'files'};
  window.renderFixture=(next={},reset=true)=>{
    props={...props,...next};if(reset)generation++;
    root.render(<div id='qa-frame' style={{width:props.width,height:'100dvh',display:'flex',flexDirection:'column'}}>
      <header className='h-11 shrink-0 border-b border-border px-3 py-3 text-xs'>CodeShell · Files</header>
      <div className='flex min-h-0 min-w-0 flex-1'>
        {props.mode==='comment'?<CommentBox key={generation} title='nested.ts:1'
          onCancel={()=>window.fixture.comment.cancel++}
          onSubmit={value=>window.fixture.comment.submit.push(value)}/>:
          <FilesPanel key={generation} cwd='/fixture' project={project}
            revealFile={props.reveal} onAttachImage={target=>attached.push(target)}/>}
      </div>
    </div>);
  };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
  tsconfig: path.join(sourceDesktop, "tsconfig.json"),
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
const reports = [],
  errors = [],
  blocked = [];
const filter = (page) => page.getByRole("textbox", { name: "筛选文件…" });
const back = (page) => page.getByRole("button", { name: "返回文件列表", exact: true });
async function mount(width = 480, height = 540, touch = false) {
  // A wide browser window proves that the dock's own width drives the layout.
  const page = await browser.newPage({
    viewport: { width: 1100, height },
    hasTouch: touch,
    isMobile: touch,
    serviceWorkers: "block",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://codeshell-files-fixture.test/")
      return route.fulfill({
        contentType: "text/html",
        body: '<html class="dark"><div id="root"></div></html>',
      });
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://codeshell-files-fixture.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((width) => window.renderFixture({ width }), width);
  await page.getByRole("button", { name: "README.md", exact: true }).waitFor();
  return page;
}
async function screenshot(page, name) {
  await page.locator("#qa-frame").screenshot({ path: path.join(output, `${name}.png`) });
}
async function inspect(page, locator, name) {
  const result = await locator.evaluate((element) => ({
    rect: element.getBoundingClientRect().toJSON(),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    opacity: getComputedStyle(element).opacity,
  }));
  reports.push({ name, ...result });
  assert.ok(result.scrollWidth <= result.clientWidth + 1, `${name} has no horizontal clipping`);
  return result;
}
try {
  for (const [width, height] of [
    [320, 540],
    [390, 540],
    [480, 540],
    [760, 540],
    [390, 320],
  ]) {
    const page = await mount(width, height);
    await page.getByRole("button", { name: "README.md", exact: true }).click();
    await page.getByRole("heading", { name: "CodeShell UI review" }).waitFor();
    await screenshot(page, `${baseline ? "before" : "after"}-preview-${width}x${height}`);
    if (width === 480) {
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await screenshot(page, `${baseline ? "before" : "after"}-preview-light-480x540`);
      await page.evaluate(() => document.documentElement.classList.add("dark"));
    }
    if (!baseline) {
      const preview = await inspect(
        page,
        page.getByRole("heading", { name: "CodeShell UI review" }).locator(".."),
        `preview-${width}x${height}`,
      );
      assert.ok(
        preview.rect.width >= (width <= 640 ? width - 40 : 400),
        "Preview retains readable width",
      );
      if (width <= 640) {
        assert.equal(await filter(page).isVisible(), false);
        await back(page).click();
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("data-files-path") === "/fixture/README.md",
        );
        assert.ok(
          await page
            .getByRole("button", { name: "README.md", exact: true })
            .evaluate((el) => document.activeElement === el),
        );
        await filter(page).fill("no-such-file");
        await page.getByText("当前目录没有匹配的项目", { exact: true }).waitFor();
        await filter(page).fill("");
      } else {
        assert.equal(await filter(page).isVisible(), true);
        await page.getByRole("button", { name: "README.md", exact: true }).focus();
        await page.evaluate(() => window.renderFixture({ width: 480 }, false));
        await back(page).waitFor();
        await page.waitForFunction(() => document.activeElement?.hasAttribute("data-files-back"));
        await page.evaluate(() => window.renderFixture({ width: 760 }, false));
        await filter(page).waitFor();
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("data-files-path") === "/fixture/README.md",
        );
        await page.evaluate(() => {
          const outside = document.createElement("button");
          outside.id = "outside-focus";
          outside.textContent = "Other action";
          outside.style.cssText = "position:fixed;left:900px;top:0";
          document.body.appendChild(outside);
          outside.focus();
          window.renderFixture({ width: 480 }, false);
        });
        await back(page).waitFor();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(
          await page.evaluate(() => document.activeElement?.id),
          "outside-focus",
          "Panel resize preserves focus elsewhere",
        );
        await page.evaluate(() => document.getElementById("outside-focus").remove());
        await page.evaluate(() => window.renderFixture({ width: 760 }, false));
        await page.getByRole("button", { name: "README.md", exact: true }).focus();
        await page.evaluate(() => {
          const outside = document.createElement("div");
          outside.id = "outside-pointer";
          outside.textContent = "Other content";
          outside.style.cssText = "position:fixed;left:900px;top:20px;width:150px;height:24px";
          document.body.appendChild(outside);
        });
        await page.locator("#outside-pointer").click();
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        await page.evaluate(() => window.renderFixture({ width: 480 }, false));
        await back(page).waitFor();
        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "Resize respects a pointer move to non-focusable content outside the panel");
        await page.evaluate(() => document.getElementById("outside-pointer").remove());
      }
      await inspect(page, page.locator("#qa-frame"), `frame-${width}x${height}`);
    }
    await page.close();
  }
  const page = await mount();
  await page.evaluate(() => {
    window.fixture.failures.add("/fixture");
    window.renderFixture();
  });
  if (baseline) {
    await page.waitForTimeout(50);
    await screenshot(page, "before-directory-failure");
  } else {
    await page.getByRole("alert").waitFor();
    await screenshot(page, "after-directory-failure");
    await page.evaluate(() => {
      window.fixture.failures.delete("/fixture");
      window.fixture.held.add("/fixture");
    });
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "加载" }).waitFor();
    await page.evaluate(() => window.fixture.release("/fixture"));
    await page.getByRole("button", { name: "README.md", exact: true }).waitFor();
    await page.getByRole("button", { name: "empty", exact: true }).click();
    await page.getByText("此文件夹为空", { exact: true }).waitFor();
    await page.evaluate(() => window.fixture.failures.add("/fixture/broken"));
    await page.getByRole("button", { name: "broken", exact: true }).click();
    await page.getByRole("alert").waitFor();
    const callsBefore = await page.evaluate(
      () => window.fixture.calls.filter((c) => c.path === "/fixture").length,
    );
    await page.evaluate(() => window.fixture.failures.delete("/fixture/broken"));
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByRole("button", { name: "recovered.ts", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.fixture.calls.filter((c) => c.path === "/fixture").length),
      callsBefore,
      "Local retry leaves ancestor reads alone",
    );
    const longName = await page.evaluate(() => window.fixture.longName);
    await page.getByRole("button", { name: longName, exact: true }).focus();
    await inspect(page, page.getByRole("button", { name: longName, exact: true }), "long-file-row");
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "deep", exact: true }).click();
    await page.getByRole("button", { name: "nested.ts", exact: true }).click();
    await page.getByText("const nested = true;", { exact: true }).waitFor();
    await back(page).click();
    await page.getByRole("button", { name: "nested.ts", exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新", exact: true }).first().click();
    await page.getByRole("button", { name: "nested.ts", exact: true }).waitFor();
    // A new reveal selects and expands the deep path without changing roots.
    await page.evaluate(() =>
      window.renderFixture(
        { reveal: { path: "/fixture/src/deep/nested.ts", cwd: "/fixture", nonce: 1 } },
        false,
      ),
    );
    await back(page).waitFor();
    await back(page).click();
    // Root selection while an old directory read is held must never show old rows.
    await page.evaluate(() => window.fixture.held.add("/fixture/src"));
    await page.getByRole("button", { name: "刷新", exact: true }).first().click();
    await page.getByRole("combobox", { name: "项目文件夹" }).click();
    await page.getByRole("option", { name: /Secondary/ }).click();
    await page.getByRole("button", { name: "secondary.txt", exact: true }).waitFor();
    await page.evaluate(() => window.fixture.release("/fixture/src"));
    assert.equal(await page.getByRole("button", { name: "nested.ts", exact: true }).count(), 0);
    await screenshot(page, "after-secondary-root");
    await page.evaluate(() => window.renderFixture({ reveal: undefined }));
    const picture = page.getByRole("button", { name: "picture.png", exact: true }).locator("..");
    const attach = picture.getByRole("button", { name: "添加到输入框" });
    await attach.focus();
    assert.equal((await inspect(page, attach, "keyboard-attach")).opacity, "1");
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.fixture.attached), ["/fixture/picture.png"]);
    const openWith = picture.getByRole("button", { name: "打开方式" });
    await openWith.focus();
    assert.equal((await inspect(page, openWith, "keyboard-open-with")).opacity, "1");
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "deep", exact: true }).click();
    await page.getByRole("button", { name: "nested.ts", exact: true }).click();
    const comment = page.getByRole("button", { name: "评论此行", exact: true }).first();
    await comment.focus();
    assert.equal((await inspect(page, comment, "keyboard-line-comment")).opacity, "1");
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "本地评论 · nested.ts:1", exact: true });
    await input.fill("保留中文评论");
    await input.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          isComposing: true,
        }),
      );
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true }),
      );
    });
    assert.equal(await input.inputValue(), "保留中文评论");
    assert.equal(await page.evaluate(() => window.fixture.anchors.length), 0);
    await input.press("Control+Enter");
    assert.equal(await page.evaluate(() => window.fixture.anchors[0].comment), "保留中文评论");
    assert.ok(await comment.evaluate((el) => document.activeElement === el));
    await comment.press("Enter");
    await input.fill("取消本条评论");
    await input.press("Escape");
    assert.equal(await input.count(), 0);
    assert.ok(await comment.evaluate((el) => document.activeElement === el));
    await screenshot(page, "after-keyboard-preview");
    const touch = await mount(390, 540, true);
    const touchActions = touch
      .locator("[data-file-row]")
      .filter({ has: touch.getByRole("button", { name: "picture.png", exact: true }) });
    assert.equal(
      await touchActions
        .getByRole("button", { name: "添加到输入框" })
        .evaluate((el) => getComputedStyle(el).opacity),
      "1",
    );
    await screenshot(touch, "after-touch-actions");
    await touch.close();
  }
  await page.close();
  assert.deepEqual(errors, [], "No renderer exceptions");
  assert.deepEqual(blocked, [], "No component attempts network access");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ baseline, reports, errors, blocked }, null, 2),
  );
  console.log(
    `PASS FilesPanel ${baseline ? "baseline captures" : "responsive, directory recovery, root identity, keyboard, touch and IME"}: ${output}`,
  );
} finally {
  await browser.close();
}
