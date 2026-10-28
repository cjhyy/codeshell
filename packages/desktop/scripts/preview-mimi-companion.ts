/** Isolated local visual trial: no worker, CUA daemon, credentials, or real input. */
import { app, BrowserWindow, ipcMain, protocol, screen } from "electron";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMimiCompanionHost } from "../src/main/computer-use/mimi-companion-host.js";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { CuaActivityChannel } from "../src/main/computer-use/cua-activity-proxy.js";

async function main() {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log("Mimi companion: loading preview");
  const temporary = await mkdtemp(join(tmpdir(), "codeshell-mimi-preview-"));
  app.setPath("userData", join(temporary, "user-data"));
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "csmimi",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
  await app.whenReady();
  console.log("Mimi companion: Electron ready");
  const preload = join(temporary, "preview-preload.cjs");
  await writeFile(
    preload,
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('preview',{run:()=>ipcRenderer.invoke('preview:run'),toggle:(enabled)=>ipcRenderer.invoke('preview:toggle',enabled),size:(size)=>ipcRenderer.invoke('preview:size',size)});`,
  );
  const control = new BrowserWindow({
    title: "Mimi 动作实验室",
    width: 940,
    height: 680,
    backgroundColor: "#f4f2ed",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const host = await createMimiCompanionHost({
    appPath: desktopRoot,
    resourcesPath: process.resourcesPath,
    userDataPath: join(temporary, "companion"),
    executablePath: process.execPath,
    packaged: false,
    isMainWindow: (sender) => sender === control.webContents,
    openChat: async () => {
      control.show();
      control.focus();
      await control.webContents.executeJavaScript(
        "document.querySelector('#result').textContent='已触发聊天入口。主应用中会打开 Mimi 聊天；独立效果实验室不连接聊天服务。'",
      );
    },
    log: (event, data) => console.log(event, data ?? ""),
  });
  const check = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== control.webContents || event.senderFrame !== control.webContents.mainFrame)
      throw new Error("Invalid preview window");
  };
  ipcMain.handle("preview:run", async (event) => {
    check(event);
    await host.preview();
  });
  ipcMain.handle("preview:toggle", async (event, enabled: unknown) => {
    check(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid switch");
    await host.update({ enabled });
  });
  ipcMain.handle("preview:size", async (event, size: unknown) => {
    check(event);
    if (typeof size !== "number" || ![240, 320, 400, 480].includes(size))
      throw new Error("Invalid size");
    await host.update({ size });
  });
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Mimi 动作实验室</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f2ed;color:#252b30;font:15px -apple-system,BlinkMacSystemFont,sans-serif;padding:38px 44px}header{display:flex;justify-content:space-between;align-items:center}.tag{font-size:11px;letter-spacing:2px;color:#707b77}h1{font-size:34px;letter-spacing:-1px;margin:12px 0}p{color:#69736f;line-height:1.7;margin:8px 0}.pill{background:#e5ece5;color:#435a48;border-radius:20px;padding:8px 12px;font-size:12px}.bar{display:flex;gap:18px;align-items:center;background:white;border:1px solid #dddeda;border-radius:14px;padding:20px;margin-top:28px}button,select{font:inherit;border:1px solid #ced4ce;border-radius:9px;padding:10px 15px;background:white;cursor:pointer}button.primary{background:#344c42;color:white;border:0}label{display:flex;align-items:center;gap:8px}input{accent-color:#344c42}.grow{flex:1}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}.card{background:white;border:1px solid #dddeda;border-radius:14px;padding:23px}.card.ghost{background:transparent;border-style:dashed}h2{font-size:17px;margin:0 0 10px}.small{font-size:12px}.steps{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}.steps span{background:#e8e9e3;border-radius:7px;padding:9px 13px;font-size:12px}footer{font-size:12px;color:#7e8580;margin-top:26px}#result{height:22px;color:#435a48;font-size:13px}</style>
<header><div><div class="tag">MIMI / CHARACTER LAB</div><h1>让角色陪着电脑一起工作。</h1></div><span class="pill">本地效果预览</span></header>
<p>先是一只可以互动的宠物，再是工作的伙伴。图片动画和 Live2D 可以替换。</p>
<div class="bar"><label><input id="enabled" type="checkbox">显示角色</label><label class="grow">大小<select id="size"><option>240</option><option selected>320</option><option>400</option><option>480</option></select></label><button id="preview" class="primary">播放 10 秒动作预览</button></div>
<div class="grid"><section class="card"><h2>Mimi 图片动画集</h2><p class="small">当前效果 · 全身角色</p><p class="small">待机安静，工作时短暂响应。拖动后停在你放的位置，点击打开聊天入口，右键恢复跟随。</p></section><section class="card ghost"><h2>Live2D / 更多效果集</h2><p class="small">预留适配器位置</p><p class="small">使用相同的动作信号，替换角色渲染方式。此预览未加载 Live2D 模型。</p></section></div>
<div class="steps"><span>看向目标</span><span>靠近 · 点击反馈</span><span>输入反馈</span><span>滚动反馈</span><span>回到待机</span></div>
<p id="result"></p><footer>此窗口只演示动作，不会点击、输入或读取其他应用。关闭窗口即退出预览。<br>正式联动入口：CodeShell 设置 → 电脑操控 → 显示 Mimi 操作角色。</footer>
<script>const result=document.querySelector('#result');async function run(action){try{await action();result.textContent='';}catch(error){result.textContent='预览未完成：'+error.message;}}document.querySelector('#preview').onclick=()=>run(()=>window.preview.run());document.querySelector('#enabled').onchange=e=>run(()=>window.preview.toggle(e.target.checked));document.querySelector('#size').onchange=e=>run(()=>window.preview.size(Number(e.target.value)));</script></html>`;
  await control.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  console.log("Mimi companion: preview controls ready");
  if (process.argv.includes("--external-cua")) {
    await host.update({ enabled: true });
    await control.webContents.executeJavaScript("document.querySelector('#enabled').checked=true");
    const activity = createConnection(host.mcpProxy.socketPath);
    activity.on("error", (error) =>
      console.error("External CUA presentation channel:", error.message),
    );
    activity.on("data", () => {
      if (!process.argv.includes("--placement-log")) return;
      const actor = BrowserWindow.getAllWindows().find((win) => win !== control);
      if (actor)
        void actor.webContents.executeJavaScript("window.mimiCompanion.getState()").then((state) =>
          console.log(
            "Placement:",
            JSON.stringify({
              pointer: screen.getCursorScreenPoint(),
              bounds: actor.getBounds(),
              position: state.position,
              target: state.target,
            }),
          ),
        );
    });
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        // External adapters can omit coordinates when CUA has just moved the
        // real pointer. Electron supplies global DIP coordinates on every display.
        if (event.phase === "start" && event.capture === false && !event.target) {
          event.target = screen.getCursorScreenPoint();
        }
        activity.write(JSON.stringify({ ...event, token: host.mcpProxy.token }) + "\n");
      } catch {
        console.error("Expected a presentation event as JSON");
      }
    });
    control.on("closed", () => {
      input.close();
      activity.destroy();
    });
    console.log("Mimi companion: external CUA presentation channel ready");
    console.log(
      "Display bounds (logical points):",
      screen.getAllDisplays().map(({ bounds, scaleFactor }) => ({ ...bounds, scaleFactor })),
    );
  }
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void host.close().finally(async () => {
      await rm(temporary, { recursive: true, force: true });
      app.quit();
    });
  });
  control.on("closed", () => app.quit());
  if (process.argv.includes("--smoke")) {
    try {
      await host.update({ enabled: true, size: 320 });
      const deadline = Date.now() + 8000;
      let actor: BrowserWindow | undefined;
      while (Date.now() < deadline) {
        actor = BrowserWindow.getAllWindows().find((win) => win !== control);
        if (actor?.isVisible()) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!actor?.isVisible() || actor.isFocusable())
        throw new Error("Companion did not become visible without focus");
      const surface = actor;
      const readState = () =>
        surface.webContents.executeJavaScript("window.mimiCompanion.getState()");
      await surface.webContents.executeJavaScript("window.mimiCompanion.interaction('begin')");
      const display =
        screen.getAllDisplays().find((item) => item.bounds.x !== 0) ?? screen.getPrimaryDisplay();
      const moved = { x: display.workArea.x + 100, y: display.workArea.y + 100 };
      await surface.webContents.executeJavaScript(
        `window.mimiCompanion.move(${JSON.stringify(moved)})`,
      );
      const held = await readState();
      if (!held.humanActive || !held.pinned)
        throw new Error("Dragging did not acquire human priority");
      if (
        Math.abs(held.windowOrigin.x + held.position.x - moved.x) > 1 ||
        Math.abs(held.windowOrigin.y + held.position.y - moved.y) > 1
      )
        throw new Error("Extended display placement drifted");
      const channel = new CuaActivityChannel(host.mcpProxy.socketPath, host.mcpProxy.token);
      await channel.send({
        id: "smoke-input",
        action: "click",
        phase: "start",
        target: { x: 500, y: 500 },
        capture: false,
      });
      const during = await readState();
      if (during.activity.action !== "idle" || during.position.x !== held.position.x)
        throw new Error("CUA overrode a human drag");
      await channel.send({ id: "smoke-capture", action: "observe", phase: "start", capture: true });
      if (!surface.isVisible()) throw new Error("Capture hid the pet during human interaction");
      await channel.send({ id: "smoke-capture", action: "observe", phase: "end", capture: true });
      await surface.webContents.executeJavaScript("window.mimiCompanion.interaction('end')");
      await surface.webContents.executeJavaScript("window.mimiCompanion.openChat()");
      const receipt = await control.webContents.executeJavaScript(
        "document.querySelector('#result').textContent",
      );
      if (!receipt.includes("已触发聊天入口")) throw new Error("Chat handoff failed");
      await channel.send({ id: "smoke-input", action: "click", phase: "end", capture: false });
      channel.close();
      await writeFile(
        join(desktopRoot, "out", "mimi-companion-preview.png"),
        (await actor.webContents.capturePage()).toPNG(),
      );
      await host.update({ enabled: false });
      if (!actor.isDestroyed()) throw new Error("Disabling did not destroy the companion surface");
      await host.preview();
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (host.status().enabled) throw new Error("Preview persisted the switch");
      console.log(
        "Mimi companion smoke: human priority, drag, mixed-display placement, chat handoff, disable cleanup, preview opt-out PASS",
      );
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  }
}
// Electron emits ready after the entry module finishes evaluating. Keeping
// whenReady inside this detached async function avoids a top-level-await cycle.
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
