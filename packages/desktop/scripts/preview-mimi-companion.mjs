/* Local renderer preview only: its fixture emits presentation states, never computer input. */
/* global window, document, getComputedStyle */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(desktop, "out/mimi-companion-preview");
// The isolated smoke runner sets NODE_ENV=test; build every React module consistently.
process.env.NODE_ENV = "production";
await build({
  configFile: false,
  root: resolve(desktop, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: out,
    emptyOutDir: true,
    rollupOptions: { input: resolve(desktop, "src/renderer/mimi-companion.html") },
  },
});
const fixture = `
const listeners = new Set();
let sequence = 0;
let state = { enabled: true, visible: true, appearance: "mimi-sprite", size: 320,
  modelUrl: "csmimi://assets/Hiyori/Hiyori.model3.json", coreUrl: "csmimi://assets/Core/live2dcubismcore.min.js",
  position: { x: 620, y: 230 }, windowOrigin: { x: 1440, y: -100 }, target: { x: 520, y: 333 },
  activity: { id: "preview-0", action: "idle", phase: "start", startedAt: Date.now() }, preview: true };
window.previewReceipts = [];
window.previewInteractions = [];
window.previewMoves = [];
window.previewChats = 0;
window.previewResumes = 0;
window.preview = (patch) => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
window.mimiCompanion = {
  getState: async () => state,
  onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  ready: (result) => window.previewReceipts.push(result || { ready: true }),
  interaction: (phase) => window.previewInteractions.push(phase),
  move: (position) => { window.previewMoves.push(position); window.preview({ position: { x: position.x - state.windowOrigin.x, y: position.y - state.windowOrigin.y }, pinned: true }); },
  openChat: async () => { window.previewChats++; },
  resumeFollowing: () => { window.previewResumes++; window.preview({ pinned: false }); },
};
document.querySelectorAll("[data-preview-action]").forEach((button) => button.addEventListener("click", () => {
  const action = button.dataset.previewAction;
  window.preview({ activity: { id: "preview-" + ++sequence, action, phase: "start", startedAt: Date.now() } });
}));
`;
await writeFile(resolve(out, "fixture.js"), fixture);
const original = await readFile(resolve(out, "mimi-companion.html"), "utf8");
const backdrop = `<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
.preview-backdrop { position: fixed; inset: 0; background: #e9edf2; color: #26364a; pointer-events: auto; }
.preview-bar { height: 55px; background: #fff; border-bottom: 1px solid #dbe1e8; display: flex; align-items:center; padding:0 30px; gap:20px; }
.preview-bar small { color:#7b8798; }
.preview-card { position:absolute; top:135px; left:100px; width:440px; border-radius:18px; padding:30px; background:white; box-shadow:0 12px 45px #24364c0a; }
.preview-card h1 { font-size:24px; margin:0 0 12px; }
.preview-card p { color:#778398; font-size:14px; line-height:1.7; }
.preview-field { padding:14px; border:1px solid #dbe2e9; border-radius:9px; margin:20px 0; color:#66768a; }
.preview-card button { background:#2c705a; color:white; border:0; border-radius:8px; padding:11px 24px; }
.preview-controls { position:absolute; left:30px; bottom:26px; display:flex; gap:8px; }
.preview-controls button { padding:8px 14px; border:1px solid #cfd7e0; background:white; color:#4d5c6e; border-radius:8px; cursor:pointer; }
</style>
<div class="preview-backdrop">
 <div class="preview-bar"><strong>Mimi 工作角色</strong><small>渲染预览 · 模拟动作</small></div>
 <div class="preview-card"><h1>让角色陪你完成操作</h1><p>这一页只演示角色与动作提示。正式桌面窗口由真实 CUA 执行动作驱动。</p><div class="preview-field">整理本周的项目进展…</div><button>保存记录</button></div>
 <div class="preview-controls"><button data-preview-action="observe">观察</button><button data-preview-action="click">点击</button><button data-preview-action="type">输入</button><button data-preview-action="scroll">滚动</button><button data-preview-action="error">失败</button><button data-preview-action="idle">空闲</button></div>
</div>`;
await writeFile(
  resolve(out, "preview.html"),
  original.replace(
    '<div id="root"></div>',
    `${backdrop}<div id="root"></div><script src="./fixture.js"></script>`,
  ),
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const path = resolve(out, `.${pathname === "/" ? "/preview.html" : pathname}`);
    if (!path.startsWith(out + sep)) throw new Error("Outside preview");
    response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/preview.html`;
console.log(`Preview: ${url}`);
if (!process.argv.includes("--serve")) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.MIMI_CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1000, height: 650 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("Preview page error:", error.message);
    });
    await page.route("**/*", (route) => {
      const requestUrl = route.request().url();
      requests.push(requestUrl);
      if (!requestUrl.startsWith(new URL(url).origin + "/")) return route.abort();
      return route.continue();
    });
    await page.goto(url);
    await page.waitForFunction(() => window.previewReceipts.length === 1);
    await page.getByRole("button", { name: "观察", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-animation="review"]'));
    await page.screenshot({ path: resolve(out, "mimi-observe.png") });
    await page.getByRole("button", { name: "输入", exact: true }).click();
    await page.waitForSelector(".mimi-keyboard");
    await page.screenshot({ path: resolve(out, "mimi-typing.png") });
    await page.getByRole("button", { name: "点击", exact: true }).click();
    await page.waitForSelector(".mimi-target--click");
    await page.screenshot({ path: resolve(out, "mimi-click.png") });
    await page.waitForSelector('[data-animation="idle"]');
    assert.equal(
      await page.locator(".mimi-target").count(),
      0,
      "click feedback expires without a host idle event",
    );
    const idleStyle = await page.locator(".mimi-companion__sprite").getAttribute("style");
    await page.waitForTimeout(260);
    assert.equal(
      await page.locator(".mimi-companion__sprite").getAttribute("style"),
      idleStyle,
      "idle stays on frame zero",
    );
    await page.screenshot({ path: resolve(out, "mimi-idle.png") });
    await page.evaluate(() =>
      window.preview({
        humanActive: true,
        activity: { id: "human-priority", action: "type", phase: "start", startedAt: Date.now() },
      }),
    );
    assert.equal(await page.locator(".mimi-keyboard").count(), 0);
    assert.equal(await page.locator('[data-animation="idle"]').count(), 1);
    await page.evaluate(() => window.preview({ humanActive: false }));
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator(".mimi-keyboard").count(),
      0,
      "suppressed work does not resume after human interaction",
    );
    const body = page.getByRole("button", { name: "打开 Mimi 聊天，拖动可移动" });
    await body.click();
    assert.equal(await page.evaluate(() => window.previewChats), 1, "click opens chat once");
    assert.equal(await page.evaluate(() => window.previewMoves.length), 0);
    const box = await body.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 1);
    await page.mouse.up();
    assert.equal(
      await page.evaluate(() => window.previewChats),
      2,
      "sub-threshold jitter remains a click",
    );
    assert.equal(await page.evaluate(() => window.previewMoves.length), 0);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 70, y - 35, { steps: 4 });
    await page.waitForSelector('[data-animation="left"]');
    await page.mouse.up();
    await page.waitForSelector('[data-animation="idle"]');
    assert.equal(await page.evaluate(() => window.previewChats), 2, "drag must not open chat");
    assert.deepEqual(
      await page.evaluate(() => window.previewMoves.at(-1)),
      { x: 1990, y: 95 },
      "drag sends global logical coordinates including window origin",
    );
    await body.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.equal(
      await page.evaluate(() => window.previewChats),
      4,
      "keyboard activation opens chat once per key",
    );
    await body.click({ button: "right" });
    await page.getByRole("menuitem", { name: "恢复跟随工作" }).click();
    assert.equal(await page.evaluate(() => window.previewResumes), 1);
    assert.equal(
      await page.evaluate(() => window.previewChats),
      4,
      "menu and drag never trigger chat",
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.previewInteractions.includes("begin") &&
          window.previewInteractions.includes("end"),
      ),
      true,
    );
    await page.mouse.move(20, 80);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForSelector(".mimi-scene--still");
    const first = await page.locator(".mimi-companion__sprite").getAttribute("style");
    await page.waitForTimeout(260);
    assert.equal(
      await page.locator(".mimi-companion__sprite").getAttribute("style"),
      first,
      "reduced motion pauses sprite frames",
    );
    await page.evaluate(() => window.preview({ enabled: false, visible: true, preview: true }));
    assert.equal(
      await page.locator(".mimi-scene").evaluate((element) => getComputedStyle(element).visibility),
      "visible",
      "one-shot preview does not require enabling the companion",
    );
    await page.evaluate(() => window.preview({ enabled: false, visible: true, preview: false }));
    assert.equal(
      await page.locator(".mimi-scene").evaluate((element) => getComputedStyle(element).visibility),
      "hidden",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      requests.some((request) => /Live2DActor|cubism|pixi-/u.test(request)),
      false,
      "default sprite must not load Live2D or Core",
    );
    console.log(
      "PASS: one-shot cues, static idle, human priority, click/drag separation, global drag coordinates, keyboard/menu, reduced motion, hide, no Core request.",
    );
    console.log(`Screenshots: ${out}`);
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
