/** Actual Workbench sidebar/media ownership; owned Link data, no authorization or writes. */
/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth, innerHeight, Event, PointerEvent, Node, Element */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownRepo = fileURLToPath(new URL("../../..", import.meta.url));
const sourceIndex = process.argv.indexOf("--source-repo");
const repo = sourceIndex < 0 ? ownRepo : path.resolve(process.argv[sourceIndex + 1]);
const development = process.argv.includes("--development");
const require = createRequire(path.join(ownRepo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-sidebar-focus-"));
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{Workbench}from'./Workbench';
const root=createRoot(document.getElementById('root')),noop=()=>{};window.unmountFixture=()=>root.render(null);window.selections=[];
function Fixture(){const[draft,setDraft]=React.useState('Owned retained task draft'),[workspace,setWorkspace]=React.useState('owned');window.changeWorkspace=()=>setWorkspace('other-owned');
const controller={host:'desktop',workspaceApi:true,connection:'open',activeId:'owned-session',chat:{items:[{kind:'assistant',id:'owned-output',text:'Owned transcript',done:true}],run:'idle'},sessions:[{sessionId:'owned-session',title:'Owned sidebar session',startedAt:1,status:'completed',turnCount:1}],workspaceCwd:'/owned',workspaceName:'Owned workspace',workspaceKey:workspace,title:'Owned conversation',configuration:null,configurationVersion:0,sessionsVersion:0,draft,files:[],uploading:false,uploadBusy:false,hasUnsent:false,uncertain:false,running:false,localDrafts:[],approvals:[],approvalCount:()=>0,approvalContent:null,error:'',clearError:noop,setDraft,removeFile:noop,selectSession:id=>window.selections.push(id),newSession:noop,send:()=>false,stop:noop,addFiles:noop,refreshSessions:noop,refreshConfiguration:noop,onAuthLost:()=>{throw Error('Unexpected auth loss')}};return <Workbench controller={controller}/>};root.render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.join(repo, "packages/web/app"), loader: "tsx" },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const origin = "http://sidebar-focus-owned.test";
const errors = [],
  blocked = [],
  reads = [],
  reports = [];
const provider = {
  id: "owned-service",
  displayName: "Owned service",
  category: "developer",
  description: { zh: "Owned synthetic service", en: "Owned synthetic service" },
  brandText: "O",
  icon: "github",
  accent: "neutral",
  actionIds: ["owned.read"],
  actions: [{ id: "owned.read", title: "Owned read", description: "Owned read", risk: "read" }],
  connectionMethods: [
    {
      id: "owned-token",
      displayName: { zh: "Owned token", en: "Owned token" },
      executionRuntime: "local",
      secretLocation: "device",
      authKind: "token",
      availability: "available",
    },
  ],
  authModes: [
    {
      id: "owned-credential",
      methodId: "owned-token",
      kind: "credential-input",
      label: "Owned token",
      preferred: true,
      available: true,
    },
  ],
};
const snapshot = {
  providers: [provider],
  connections: Array.from({ length: 12 }, (_, index) => ({
    id: "owned-" + index,
    providerId: provider.id,
    methodId: "owned-token",
    label: "Owned connection " + index,
    runtime: "local",
    authSource: "manual-token",
    status: "connected",
    account: { id: "owned-account-" + index, label: "Owned account " + index, resources: [] },
    capabilityIds: ["owned.read"],
    revision: String(index).padStart(64, "0"),
    scope: "project",
    editable: true,
  })),
  capabilities: { token: true, cliBinding: false, deviceAuth: false, authorizationSteps: 1 },
  revision: "owned-snapshot",
};
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
let context;
async function mount(
  width = 1280,
  height = 720,
  theme = "light",
  traceMedia = false,
  history = false,
) {
  await context?.close();
  context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    serviceWorkers: "block",
  });
  const url = origin + "/?view=links";
  await context.route("**/*", async (route) => {
    const request = route.request(),
      target = new URL(request.url()),
      method = request.method();
    if (request.url() === url)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><input id="outside-field" aria-label="Independent field" style="position:fixed;bottom:0;right:0;width:80px;z-index:2001;visibility:hidden"><div id="outside-blank" style="position:fixed;bottom:0;left:0;width:24px;height:24px;z-index:2001;visibility:hidden"><svg width="24" height="24"><rect width="24" height="24"/></svg></div>',
      });
    if (target.origin === origin && method === "GET") {
      reads.push(target.pathname);
      if (target.pathname === "/api/v1/environment")
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      if (target.pathname === "/api/v1/links")
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) });
      if (target.pathname === "/api/v1/sessions")
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            sessions: history
              ? [
                  {
                    cwd: "/owned",
                    sessionId: "owned-session",
                    title: "Owned history",
                    customTitle: "Owned history",
                    startedAt: 1,
                    lastActiveAt: 1,
                    model: "owned",
                    status: "idle",
                    turnCount: 1,
                    archivedAt: null,
                    running: false,
                  },
                ]
              : [],
            nextCursor: null,
          }),
        });
    }
    blocked.push(method + " " + request.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  if (traceMedia)
    await page.evaluate(() => {
      const native = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const media = native(query);
        if (query !== "(max-width: 760px)") return media;
        const add = media.addEventListener.bind(media),
          remove = media.removeEventListener.bind(media),
          listeners = new Map();
        media.addEventListener = (type, listener, options) => {
          if (type !== "change" || typeof listener !== "function")
            return add(type, listener, options);
          const wrapped = (event) => {
            listener.call(media, event);
            window.sidebarMediaHandoff?.(event);
          };
          listeners.set(listener, wrapped);
          add(type, wrapped, options);
        };
        media.removeEventListener = (type, listener, options) => {
          remove(type, listeners.get(listener) ?? listener, options);
          listeners.delete(listener);
        };
        return media;
      };
    });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text,
  });
  await page.locator(".links-connection").first().waitFor();
  await frames(page);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    theme,
  );
  return page;
}
const toggle = (page) => page.locator(".workbench-topbar button[aria-controls=workbench-sidebar]");
const mainInput = (page) => page.getByRole("textbox", { name: "任务内容", exact: true });
async function focusMatches(locator) {
  assert.equal(await locator.evaluate((node) => node === document.activeElement), true);
}
async function geometry(locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const hidden = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (
        (/hidden|clip/.test(style.overflowY) && parent.scrollTop !== 0) ||
        (/hidden|clip/.test(style.overflowX) && parent.scrollLeft !== 0)
      )
        hidden.push(parent.className);
    }
    return {
      box: box.toJSON(),
      hit: !!hit && node.contains(hit),
      hidden,
      viewport: [innerWidth, innerHeight],
      document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    };
  });
}
async function visible(locator) {
  const result = await geometry(locator);
  assert.ok(
    result.box.width > 0 &&
      result.box.height > 0 &&
      result.box.top >= -1 &&
      result.box.bottom <= result.viewport[1] + 1 &&
      result.box.left >= -1 &&
      result.box.right <= result.viewport[0] + 1 &&
      result.hit,
    JSON.stringify(result),
  );
  assert.deepEqual(result.hidden, []);
  assert.ok(
    result.document[0] <= result.viewport[0] + 1 && result.document[1] <= result.viewport[1] + 1,
  );
  return result;
}
async function resize(page, width, height) {
  await page.setViewportSize({ width, height });
  await frames(page);
  await frames(page);
}
async function openLinks(page) {
  await page.locator(".links-connection").first().getByRole("button", { name: "管理连接" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Owned service 连接设置", exact: true }).waitFor();
  await frames(page);
}
async function outside(page, kind, height) {
  if (kind === "field") {
    await page.locator("#outside-field").evaluate((node) => (node.style.visibility = "visible"));
    await page.locator("#outside-field").fill("Independent retained draft");
    return page.locator("#outside-field");
  }
  await page.locator("#outside-blank").evaluate((node) => {
    node.style.visibility = "visible";
    node.addEventListener(
      "pointerdown",
      (event) => (window.pointerNamespace = event.target.namespaceURI),
    );
  });
  await page.mouse.click(12, height - 12);
  assert.equal(await page.evaluate(() => window.pointerNamespace), "http://www.w3.org/2000/svg");
  await page.locator("body").evaluate((node) => {
    node.tabIndex = -1;
    node.focus();
  });
  return page.locator("body");
}
async function openDirtyPrompt(page) {
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await frames(page);
  await page.getByRole("button", { name: "历史对话", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .locator(".session-history-row")
    .first()
    .getByRole("button", { name: "重命名", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "对话标题", exact: true })
    .fill("Owned unsaved history title");
  await frames(page);
  await toggle(page).click();
  await frames(page);
  await page.getByRole("button", { name: "对话", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "还有未保存的修改", exact: true }).waitFor();
  await frames(page);
}
try {
  for (const theme of ["light", "dark"])
    for (const [width, height] of [
      [320, 240],
      [390, 360],
    ])
      for (const owner of ["link-save", "main", "field", "blank", "sidebar", "toggle"]) {
        const page = await mount(1280, 720, theme);
        let target;
        if (owner === "link-save") {
          await openLinks(page);
          const label = page.getByRole("textbox", { name: "连接名称", exact: true });
          await label.fill("Owned retained Link draft");
          target = page.getByRole("button", { name: "保存名称", exact: true });
          await target.focus();
        } else if (owner === "main") {
          await page.getByRole("button", { name: "对话", exact: true }).click();
          target = mainInput(page);
          await target.fill("Owned retained task draft after editing");
        } else if (owner === "field" || owner === "blank") {
          target = await outside(page, owner, 720);
        } else {
          target =
            owner === "sidebar"
              ? page.getByRole("button", { name: "Link", exact: true })
              : toggle(page);
          await target.focus();
        }
        await focusMatches(target);
        await resize(page, width, height);
        const destination = owner === "sidebar" ? toggle(page) : target;
        await focusMatches(destination);
        if (owner !== "link-save" && owner !== "blank") await visible(destination);
        if (owner === "link-save") {
          assert.equal(
            await page.getByRole("textbox", { name: "连接名称" }).inputValue(),
            "Owned retained Link draft",
          );
          assert.equal(await page.getByRole("dialog").count(), 1);
        }
        if (owner === "main")
          assert.equal(await target.inputValue(), "Owned retained task draft after editing");
        assert.equal(await page.locator(".rail").isVisible(), false);
        assert.equal(await page.locator(".workbench-main").getAttribute("inert"), null);
        const bounds = await geometry(destination);
        await page.screenshot({
          path: path.join(output, `${theme}-${width}x${height}-${owner}.png`),
        });
        // Going wide opens the sidebar without taking ownership from the destination.
        await resize(page, 1280, 720);
        await focusMatches(destination);
        reports.push({ label: "responsive-owner", theme, width, height, owner, bounds });
      }
  for (const kind of ["close", "escape", "backdrop", "navigation", "session", "toggle"]) {
    const page = await mount(390, 360);
    await toggle(page).focus();
    await page.keyboard.press("Enter");
    await frames(page);
    const close = page.locator(".sidebar-close");
    await focusMatches(close);
    assert.notEqual(await page.locator(".workbench-main").getAttribute("inert"), null);
    if (kind === "close") await page.keyboard.press("Enter");
    if (kind === "escape") {
      await page.getByRole("button", { name: "Link", exact: true }).focus();
      await page.keyboard.press("Escape");
    }
    if (kind === "backdrop")
      await page.locator(".sidebar-backdrop").click({ position: { x: 380, y: 10 } });
    if (kind === "navigation") {
      await page.getByRole("button", { name: "对话", exact: true }).focus();
      await page.keyboard.press("Enter");
    }
    if (kind === "session") {
      await page.locator(".sessions button").first().focus();
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.selections), ["owned-session"]);
    }
    if (kind === "toggle") {
      await page.keyboard.press("Escape");
      await focusMatches(toggle(page));
      await page.keyboard.press("Enter");
      await frames(page);
      await page.keyboard.press("Escape");
    }
    await frames(page);
    await focusMatches(toggle(page));
    await visible(toggle(page));
    assert.equal(await page.locator(".rail").isVisible(), false);
    reports.push({ label: "mobile-return", kind });
  }
  for (const owner of ["main", "sidebar", "blank"])
    for (const finalWidth of [320, 1280]) {
      const page = await mount();
      let target;
      if (owner === "main") {
        await page.getByRole("button", { name: "对话", exact: true }).click();
        target = mainInput(page);
        await target.focus();
      } else if (owner === "sidebar") {
        target = page.getByRole("button", { name: "Link", exact: true });
        await target.focus();
      } else target = await outside(page, "blank", 720);
      // No frame or refocus between viewport updates: coalesced media changes remain owned.
      for (const width of [320, 1280, 390, 1280, finalWidth])
        await page.setViewportSize({ width, height: 360 });
      await frames(page);
      await frames(page);
      if (owner === "sidebar" && finalWidth === 320) target = toggle(page);
      // A completed narrow transition already returned focus to the toggle; widening retains it.
      if (owner === "sidebar" && finalWidth === 1280) {
        const stillSidebar = await target.evaluate((node) => node === document.activeElement);
        if (!stillSidebar) target = toggle(page);
      }
      await focusMatches(target);
      reports.push({ label: "rapid-resize-owner", owner, finalWidth });
    }
  for (const action of ["stay", "leave"]) {
    const page = await mount(390, 360, "light", false, true);
    await toggle(page).focus();
    await page.keyboard.press("Enter");
    await frames(page);
    await page.getByRole("button", { name: "历史对话", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page
      .locator(".session-history-row")
      .first()
      .getByRole("button", { name: "重命名", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "对话标题", exact: true })
      .fill("Owned unsaved history title");
    await frames(page);
    await toggle(page).click();
    await frames(page);
    const destination = page.getByRole("button", { name: "对话", exact: true });
    await destination.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "还有未保存的修改", exact: true }).waitFor();
    assert.equal(await page.locator(".rail").isVisible(), true);
    await page
      .getByRole("button", { name: action === "stay" ? "留在此页" : "放弃修改并离开", exact: true })
      .click();
    await frames(page);
    await frames(page);
    assert.equal(await page.locator(".navigation-prompt").count(), 0);
    if (action === "stay") {
      await focusMatches(destination);
      assert.equal(await page.locator(".rail").isVisible(), true);
      assert.equal(
        await page.locator(".session-history-editor input").inputValue(),
        "Owned unsaved history title",
      );
      await page.keyboard.press("Escape");
      await frames(page);
    } else {
      assert.equal(await page.locator(".rail").isVisible(), false);
      assert.equal(await page.locator(".session-history-editor").count(), 0);
    }
    await focusMatches(toggle(page));
    await visible(toggle(page));
    reports.push({ label: "actual-dirty-mobile-navigation", action });
  }
  for (const kind of ["field", "pointer", "svg", "blur", "workspace", "unmount"])
    for (const timing of ["before-commit", "after-commit"]) {
      const page = await mount(1280, 720, "light", true);
      await page.getByRole("button", { name: "Link", exact: true }).focus();
      await page.evaluate(
        ({ kind, timing }) => {
          const field = document.getElementById("outside-field"),
            blank = document.getElementById("outside-blank");
          field.style.visibility = blank.style.visibility = "visible";
          const handoff = () => {
            if (kind === "field") field.focus();
            if (kind === "pointer" || kind === "svg") {
              const target = kind === "svg" ? blank.querySelector("rect") : blank;
              target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              document.body.tabIndex = -1;
              document.body.focus();
            }
            if (kind === "blur") window.dispatchEvent(new Event("blur"));
            if (kind === "workspace") window.changeWorkspace();
            if (kind === "unmount") window.unmountFixture();
          };
          // Keep the native media event; run before React can commit its captured close.
          window.sidebarMediaHandoff = (event) => {
            if (!event.matches) return;
            window.sidebarMediaHandoff = null;
            window.handoffSawOpenSidebar = !document.querySelector(".rail")?.hidden;
            if (timing === "before-commit") handoff();
            else requestAnimationFrame(handoff);
          };
        },
        { kind, timing },
      );
      await resize(page, 320, 240);
      assert.equal(await page.evaluate(() => window.handoffSawOpenSidebar), true);
      if (kind === "field") await focusMatches(page.locator("#outside-field"));
      if (
        kind === "pointer" ||
        kind === "svg" ||
        kind === "unmount" ||
        (kind === "workspace" && timing === "before-commit")
      )
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      if (kind === "blur" && timing === "before-commit")
        assert.equal(await toggle(page).evaluate((node) => node === document.activeElement), false);
      // The original media listener must not act after unmount, or replay a disposed intent.
      if (kind === "unmount") {
        await resize(page, 1280, 720);
        await resize(page, 320, 240);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      }
      reports.push({ label: "closing-source-handoff", kind, timing });
    }
  for (const kind of [
    "cancel",
    "backdrop",
    "closing-field",
    "closing-svg",
    "blur",
    "workspace",
    "unmount",
    "rapid",
  ]) {
    const page = await mount(390, 360, "light", false, true);
    await openDirtyPrompt(page);
    const source = page.getByRole("button", { name: "对话", exact: true });
    if (kind === "backdrop") {
      await page.evaluate(() => {
        document.addEventListener(
          "pointerdown",
          (event) => {
            window.nativeBackdropPointer =
              event.target === document.querySelector(".navigation-prompt");
          },
          { capture: true, once: true },
        );
      });
      await page.mouse.click(2, 2);
      assert.equal(await page.evaluate(() => window.nativeBackdropPointer), true);
    }
    if (kind === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (kind === "workspace") await page.evaluate(() => window.changeWorkspace());
    if (kind === "closing-field" || kind === "closing-svg") {
      await page.evaluate((kind) => {
        const remove = Node.prototype.removeChild;
        Node.prototype.removeChild = function (node) {
          const result = remove.call(this, node);
          if (node instanceof Element && node.matches("dialog.navigation-prompt")) {
            Node.prototype.removeChild = remove;
            if (kind === "closing-field") {
              const field = document.getElementById("outside-field");
              field.style.visibility = "visible";
              field.value = "Closing independent draft";
              field.focus();
            } else {
              const target = document.querySelector("#outside-blank rect");
              target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              document.body.tabIndex = -1;
              document.body.focus();
            }
            window.closingHandoffFired = !node.isConnected;
          }
          return result;
        };
      }, kind);
    }
    if (kind === "unmount") await page.evaluate(() => window.unmountFixture());
    else if (kind === "cancel") await page.keyboard.press("Escape");
    else await page.getByRole("button", { name: "留在此页", exact: true }).click();
    await frames(page);
    await frames(page);
    assert.equal(await page.locator(".navigation-prompt").count(), 0);
    if (kind === "cancel" || kind === "rapid") {
      await focusMatches(source);
      assert.equal(
        await page.locator(".session-history-editor input").inputValue(),
        "Owned unsaved history title",
      );
    } else if (kind === "closing-field") {
      assert.equal(await page.evaluate(() => window.closingHandoffFired), true);
      await focusMatches(page.locator("#outside-field"));
      assert.equal(await page.locator("#outside-field").inputValue(), "Closing independent draft");
    } else {
      if (kind === "closing-svg")
        assert.equal(await page.evaluate(() => window.closingHandoffFired), true);
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    }
    if (kind === "rapid") {
      const next = page.getByRole("button", { name: "文件", exact: true });
      await next.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "还有未保存的修改", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await frames(page);
      await frames(page);
      await focusMatches(next);
      assert.equal(
        await page.locator(".session-history-editor input").inputValue(),
        "Owned unsaved history title",
      );
    }
    reports.push({ label: "native-prompt-owned-return", kind });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
} catch (error) {
  await context
    ?.pages()[0]
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await context?.close();
  await browser.close();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ repo, development, reports, errors, blocked, reads }, null, 2),
  );
  console.log(JSON.stringify({ output, observations: reports.length, errors, blocked }));
}
