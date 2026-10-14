/* Production menus under narrow windows, clipping ancestors and content changes. */
/* global window, document */
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
const tailwindRequire = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwindRequire("@tailwindcss/node");
const { Scanner } = tailwindRequire("@tailwindcss/oxide");
const source = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {ProjectPicker} from './chat/ProjectPicker';
  import {BranchPicker} from './chat/BranchPicker';
  import {PermissionPill} from './chat/PermissionPill';
  import {ContextRing} from './chat/ContextRing';
  import {ModelPill} from './chat/ModelPill';
  import {ContextMenu} from './ui/ContextMenu';
  import {FixtureSessionRow} from './Sidebar';
  import {TopBar} from './TopBar';
  import {ResponsiveSidebar} from './app/ResponsiveSidebar';
  import {saveUILanguage} from './uiLanguage';
  const projects=Array.from({length:30},(_,i)=>({id:String(i),path:'/projects/project-'+i,name:'Project '+i}));
  const branches={isRepo:true,current:'main',branches:['main',...Array.from({length:30},(_,i)=>'branch-'+i)]};
  window.codeshell={
    getProjectGitBranches:async()=>branches,
    getProjectGitStatus:async()=>({clean:false}),
    stashAndSwitchProjectGitBranch:async(_id,branch)=>{
      window.actions.push(branch);return {...branches,current:branch};
    },
  };
  window.actions=[];
  function Fixture({kind}) {
    const [selected,setSelected]=React.useState('0');
    const [goal,setGoal]=React.useState('Long objective '.repeat(40));
    const [contextOpen,setContextOpen]=React.useState(false);
    const toggleRef=React.useRef(null);
    if(kind==='context'||kind==='drawer-session') return <ResponsiveSidebar narrow open onClose={()=>window.actions.push('drawer-close')} onAfterClose={()=>{}} toggleRef={toggleRef}>
      <div className="w-full p-3">
        {kind==='context'?<><button id="context-trigger" onContextMenu={event=>{event.preventDefault();setContextOpen(true)}}>Open menu</button>
          {contextOpen&&<ContextMenu x={12} y={100} items={projects.map(p=>({label:p.name,onClick:()=>window.actions.push(p.id)}))} onClose={()=>setContextOpen(false)}/>}</>
          :<ul><FixtureSessionRow s={{id:'session',title:'Long session title '.repeat(100),updatedAt:1}} isActive={false} folderName="project" branch="main" showKbd={false} kbdIndex={0} onClick={()=>{}} onContextMenu={()=>{}}/></ul>}
      </div>
    </ResponsiveSidebar>;
    return <main className="fixed inset-0 bg-background" data-case={kind}>
      <div id="anchor-host" style={{position:'fixed',left:12,right:12,bottom:12,height:kind==='status'?44:52,transform:'translateZ(0)',backdropFilter:'blur(2px)',overflow:'hidden'}}>
        {kind==='project'&&<ProjectPicker projects={projects} activeProjectId={null} onSelect={id=>window.actions.push(id)} onAddProject={()=>window.actions.push('add')}/>}
        {kind==='branch'&&<BranchPicker projectId="0" cwd="/projects/project-0" clean={false}/>}
        {kind==='permission'&&<PermissionPill value="default" onChange={id=>window.actions.push(id)}/>}
        {kind==='ring'&&<ContextRing used={20000} singleTurnPromptTokens={20000} singleTurnCacheReadTokens={15000} cumulativePromptTokens={100000} cumulativeCacheReadTokens={80000}/>}
        {kind==='model'&&<ModelPill options={projects.map(p=>({key:p.id,label:p.name,provider:'mock'}))} activeKey={selected} onSelect={o=>{setSelected(o.key);window.actions.push(o.key)}}/>}
        {kind==='session'&&<ul><FixtureSessionRow s={{id:'session',title:'Long session title '.repeat(100),updatedAt:1}} isActive={false} folderName="project" branch="main" showKbd={false} kbdIndex={0} onClick={()=>{}} onContextMenu={()=>{}}/></ul>}
        {kind==='status'&&<TopBar projectName={null} sessionTitle={null} busy={true} sidebarCollapsed={true} onToggleSidebar={()=>{}} panelOpen={false} onTogglePanel={()=>{}} isMac={false} isFullscreen={false} panelAvailable={false}
          tasks={{kind:'task_list',id:'tasks',tasks:projects.map(p=>({id:p.id,subject:p.name,status:'pending'}))}}
          activeGoal={{objective:goal,round:1,paused:false}} onUpdateGoal={value=>{setGoal(value);window.actions.push('goal')}} onGoalPausedChange={()=>{}} onDeleteGoal={()=>{}}/>}
      </div>
    </main>;
  }
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=({kind,lang})=>{
    saveUILanguage(lang);window.actions=[];
    root.render(<Fixture key={kind+lang} kind={kind}/>);
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
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
  plugins: [
    {
      name: "expose-production-session-row-for-fixture",
      setup(build) {
        build.onLoad({ filter: /[/\\]Sidebar\.tsx$/ }, async ({ path: file }) => {
          const sidebar = await readFile(file, "utf8");
          // Compile the actual row/card functions without unrelated Sidebar
          // pages, account providers or theme media. No implementation is mocked.
          return {
            contents: `
            import React,{useRef,useState,useId,useEffect} from 'react';
            import {createPortal} from 'react-dom';
            import {Folder,GitBranch,Clock,UsersRound,Pin,Loader2,Wrench,Archive} from 'lucide-react';
            import {Button} from './components/ui/button';
            import {cn} from './lib/utils';
            import {useT} from './i18n';
            import {useAnchoredPopover} from './chat/useAnchoredPopover';
            ${sidebar.slice(sidebar.indexOf("function SessionHoverCard("))}
            export {SessionRow as FixtureSessionRow};
          `,
            loader: "tsx",
            resolveDir: path.dirname(file),
          };
        });
      },
    },
  ],
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
let cases = 0;
async function fits(popover, label) {
  await popover.waitFor();
  await popover.page().waitForFunction(
    (element) => {
      const box = element.getBoundingClientRect();
      return (
        box.left >= 9 &&
        box.top >= 9 &&
        box.right <= window.innerWidth - 9 &&
        box.bottom <= window.innerHeight - 9
      );
    },
    await popover.elementHandle(),
  );
  assert.equal(
    await popover.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
    `${label}: no horizontal clipping`,
  );
}
async function reachable(item, label) {
  await item.scrollIntoViewIfNeeded();
  assert.equal(
    await item.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return el === hit || el.contains(hit);
    }),
    true,
    `${label}: pointer reaches scrolled content`,
  );
}
try {
  for (const lang of ["zh", "en"]) {
    for (const kind of [
      "project",
      "branch",
      "permission",
      "ring",
      "model",
      "context",
      "status",
      "session",
      "drawer-session",
    ]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("http://anchored.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
      );
      await page.goto("http://anchored.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((props) => window.renderFixture(props), { kind, lang });
      const opener =
        kind === "ring"
          ? page.locator("[data-context-used]")
          : kind === "drawer-session"
            ? page.locator('[role="dialog"] li').first()
            : kind === "session"
              ? page.locator("#anchor-host li").first()
              : kind === "status"
                ? page.getByRole("button", {
                    name:
                      lang === "zh"
                        ? "查看会话状态与任务详情"
                        : "View session status and task details",
                  })
                : page.locator("#anchor-host button").first();
      if (kind === "context") await page.locator("#context-trigger").click({ button: "right" });
      else if (["ring", "session", "drawer-session", "status"].includes(kind)) await opener.hover();
      else if (kind !== "context") await opener.click();
      const popover =
        kind === "context"
          ? page.getByRole("menu")
          : kind === "drawer-session"
            ? page.getByRole("tooltip")
            : page.locator('body > [style*="position: fixed"]').last();
      await fits(popover, `${kind}/${lang} initial`);
      // Transfer hover to the portaled surface before scrolling or resizing.
      if (["ring", "session", "drawer-session", "status"].includes(kind)) {
        await popover.hover();
        await page.waitForTimeout(160);
        assert.ok(await popover.isVisible(), `${kind}: pointer transfer preserves hover`);
      }
      for (const viewport of [
        { width: 390, height: 320 },
        { width: 280, height: 200 },
        { width: 220, height: 200 },
        { width: 1280, height: 760 },
      ]) {
        // Keep hover panels open while the viewport moves their hit area.
        await page.setViewportSize(viewport);
        if (["ring", "session", "drawer-session", "status"].includes(kind)) {
          await popover.hover();
        }
        await fits(popover, `${kind}/${lang}/${viewport.width}`);
        if (kind === "model" && viewport.width === 1280) {
          assert.ok(
            (await popover.boundingBox()).height <= 320,
            "Model menu retains 20rem height cap",
          );
        }
        const last =
          kind === "project"
            ? popover.getByRole("button").last()
            : kind === "branch"
              ? popover.locator("li").last()
              : kind === "model" || kind === "permission"
                ? popover.getByRole("option").last()
                : kind === "context"
                  ? popover.getByRole("menuitem").last()
                  : kind === "status"
                    ? popover.locator("ol li").last()
                    : popover.locator("div").last();
        await reachable(last, `${kind}/${viewport.width}`);
        cases++;
      }
      if (kind === "project") {
        const before = await popover.boundingBox();
        await popover.getByRole("textbox").fill("Project 29");
        await page.waitForFunction(() => {
          const ul = document.querySelector('ul[role="listbox"]');
          return ul?.children.length === 1;
        });
        await fits(popover, "filtered project menu");
        await page.waitForFunction(() => {
          const menu = Array.from(document.body.children).find(
            (el) => el.style.position === "fixed",
          );
          const anchor = document.querySelector("#anchor-host button");
          return (
            menu &&
            anchor &&
            Math.abs(
              menu.getBoundingClientRect().bottom + 6 - anchor.getBoundingClientRect().top,
            ) <= 1
          );
        });
        const after = await popover.boundingBox();
        assert.ok(after.height < before.height, "Search content shrinks the open menu");
        const anchor = await opener.boundingBox();
        assert.ok(
          Math.abs(after.y + after.height + 6 - anchor.y) <= 1,
          "Content resize retains anchor alignment",
        );
        await page.locator("#anchor-host").evaluate((el) => {
          el.style.bottom = "112px";
        });
        await page.waitForFunction(() => {
          const menu = Array.from(document.body.children).find(
            (el) => el.style.position === "fixed",
          );
          const anchor = document.querySelector("#anchor-host button");
          return (
            menu &&
            anchor &&
            Math.abs(
              menu.getBoundingClientRect().bottom + 6 - anchor.getBoundingClientRect().top,
            ) <= 1
          );
        });
        await popover.getByRole("option", { name: "Project 29" }).click();
        assert.deepEqual(await page.evaluate(() => window.actions), ["29"]);
      } else if (kind === "branch") {
        await popover
          .locator("li")
          .filter({ hasText: /^branch-29$/ })
          .click();
        await fits(popover, "dirty branch confirmation");
        await page.setViewportSize({ width: 220, height: 200 });
        const confirm = popover.getByRole("button").last();
        await reachable(confirm, "stash action");
        await confirm.click();
        await popover.waitFor({ state: "hidden" });
        assert.deepEqual(await page.evaluate(() => window.actions), ["branch-29"]);
      } else if (["model", "permission", "context"].includes(kind)) {
        await popover
          .getByRole(kind === "context" ? "menuitem" : "option")
          .last()
          .click();
        await popover.waitFor({ state: "hidden" });
        assert.equal((await page.evaluate(() => window.actions)).length, 1);
        if (kind === "context") {
          assert.ok(
            await page.getByRole("dialog").isVisible(),
            "Menu action keeps the sidebar drawer open",
          );
          await page.locator("#context-trigger").click({ button: "right" });
          await popover.waitFor();
          await page.keyboard.press("Escape");
          await popover.waitFor({ state: "hidden" });
          assert.ok(
            await page.getByRole("dialog").isVisible(),
            "Escape closes the menu before its sidebar drawer",
          );
        }
      } else if (kind === "status") {
        const edit = popover.getByRole("button", {
          name: lang === "zh" ? "编辑" : "Edit",
          exact: true,
        });
        await edit.click();
        const input = popover.getByRole("textbox");
        await input.fill("Updated goal");
        await page.mouse.move(0, 0);
        await page.waitForTimeout(160);
        assert.ok(await popover.isVisible(), "Focused goal editor survives pointer leave");
        await fits(popover, "dynamic goal editor");
        await popover
          .getByRole("button", { name: lang === "zh" ? "保存" : "Save", exact: true })
          .click();
        assert.deepEqual(await page.evaluate(() => window.actions), ["goal"]);
        await edit.click();
        await input.focus();
        await page.keyboard.press("Escape");
        await popover.waitFor({ state: "hidden" });
        assert.ok(
          await opener.evaluate((el) => el === document.activeElement),
          "Escape from the goal editor restores its status trigger",
        );
      } else {
        await page.mouse.move(0, 0);
        await popover.waitFor({ state: "hidden" });
      }
      assert.deepEqual(errors, [], `${kind}/${lang}: browser errors`);
      await page.close();
    }
  }
  console.log(
    `PASS: ${cases} anchored-menu viewport cases, body portals, pointer actions, hover transfer, dynamic content and goal focus (zh/en)`,
  );
} finally {
  await browser.close();
}
