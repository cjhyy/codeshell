/** Isolated local visual trial. Optional native trial controls its own test form. */
import { app, BrowserWindow, globalShortcut, ipcMain, protocol, screen } from "electron";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMimiCompanionHost } from "../src/main/computer-use/mimi-companion-host.js";
import { createComputerUseControl } from "../src/main/computer-use/computer-use-control.js";
import { resolveComputerUseBundle } from "../src/main/computer-use/cua-driver-host.js";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { CuaActivityChannel } from "../src/main/computer-use/cua-activity-proxy.js";
import { createMimiNativeTrial } from "./mimi-native-trial.js";

async function main() {
  if (process.argv.includes("--practice")) {
    throw new Error("浏览器逐键演示已移除：曾导致抢焦点和错误输入，禁止重新运行。");
  }
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
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('preview',{run:(displayId)=>ipcRenderer.invoke('preview:run',displayId),toggle:(enabled)=>ipcRenderer.invoke('preview:toggle',enabled),size:(size)=>ipcRenderer.invoke('preview:size',size),native:()=>ipcRenderer.invoke('preview:native'),stop:()=>ipcRenderer.invoke('preview:stop')});`,
  );
  const trialDisplay =
    (process.argv.includes("--right-display")
      ? screen
          .getAllDisplays()
          .find(({ bounds }) => bounds.x > 0 && bounds.width === 2560 && bounds.height === 1440)
      : undefined) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const control = new BrowserWindow({
    title: "Mimi 动作实验室",
    width: 940,
    height: 740,
    x: Math.round(trialDisplay.workArea.x + 60),
    y: Math.round(trialDisplay.workArea.y + 120),
    backgroundColor: "#f4f2ed",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const execution = await createComputerUseControl({
    appPath: desktopRoot,
    executablePath: process.execPath,
    log: (event, data) => console.log(event, data ?? ""),
  });
  const host = await createMimiCompanionHost({
    appPath: desktopRoot,
    resourcesPath: process.resourcesPath,
    userDataPath: join(temporary, "companion"),
    bus: execution.bus,
    gate: execution.gate,
    packaged: false,
    isMainWindow: (sender) => sender === control.webContents,
    holdForChat: false,
    openChat: async (request) => {
      control.show();
      control.focus();
      if (request) console.log("Chat draft:", request.prompt);
      await control.webContents.executeJavaScript(
        `document.querySelector('#result').textContent=${JSON.stringify(
          request
            ? `已打开聊天并放入草稿：${request.prompt}（需要你自己发送）`
            : "已触发聊天入口。主应用中会打开 Mimi 聊天；独立效果实验室不连接聊天服务。",
        )}`,
      );
    },
    log: (event, data) => console.log(event, data ?? ""),
  });
  const check = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== control.webContents || event.senderFrame !== control.webContents.mainFrame)
      throw new Error("Invalid preview window");
  };
  // The helper app owns the macOS grants; dev builds it into out/native.
  const nativeBundle = process.argv.includes("--native-cua")
    ? resolveComputerUseBundle({ isPackaged: false, appPath: desktopRoot })
    : undefined;
  if (process.argv.includes("--native-cua") && !nativeBundle)
    throw new Error("--native-cua needs the Computer Use helper; run the desktop dev build first");
  const nativeTrial = nativeBundle
    ? createMimiNativeTrial({
        companion: host,
        mcpProxy: execution.mcpProxy,
        bundle: nativeBundle,
        displayId: trialDisplay.id,
        onRunningChange: (running) => {
          globalShortcut.unregister("CommandOrControl+Shift+Escape");
          if (
            running &&
            !globalShortcut.register("CommandOrControl+Shift+Escape", () => {
              void nativeTrial?.cancel();
            })
          )
            throw new Error("无法注册停止快捷键，试填未开始");
        },
        status: (message) => {
          if (!control.isDestroyed())
            void control.webContents.executeJavaScript(
              `document.querySelector('#result').textContent=${JSON.stringify(message)}`,
            );
          console.log("Native trial:", message);
        },
      })
    : undefined;
  ipcMain.handle("preview:stop", async (event) => {
    check(event);
    await nativeTrial?.cancel();
  });
  control.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") void nativeTrial?.cancel();
  });
  ipcMain.handle("preview:native", async (event) => {
    check(event);
    if (!nativeTrial) throw new Error("未配置原生试填入口");
    try {
      await nativeTrial.run();
    } finally {
      if (!control.isDestroyed())
        await control.webContents.executeJavaScript(
          `document.querySelector('#enabled').checked=${host.status().enabled}`,
        );
    }
  });
  ipcMain.handle("preview:run", async (event, displayId: unknown) => {
    check(event);
    if (typeof displayId !== "number" || !Number.isInteger(displayId))
      throw new Error("请选择屏幕");
    await host.preview(displayId);
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
<p>${nativeTrial ? "原生 CUA 试填版 · 按钮会在此屏幕打开公开测试表单，并真实填写两个字段。" : "独立效果演示 · 当前没有自动连接 Codex 的 CUA 操作。"} 人的拖动和点击优先。</p>
<div class="bar"><label><input id="enabled" type="checkbox">显示角色</label><select id="display" aria-label="显示屏幕">${screen
    .getAllDisplays()
    .map(
      ({ id, bounds }) =>
        `<option value="${id}"${id === trialDisplay.id ? " selected" : ""}>${bounds.x > 0 ? "右侧扩展屏" : bounds.x < 0 ? "左侧扩展屏" : "内置屏"} ${bounds.width}×${bounds.height}</option>`,
    )
    .join(
      "",
    )}</select><label class="grow">大小<select id="size"><option>240</option><option selected>320</option><option>400</option><option>480</option></select></label><button id="preview" class="primary">在此屏幕演示</button></div>
<div class="grid"><section class="card"><h2>Mimi 图片动画集</h2><p class="small">当前效果 · 全身角色</p><p class="small">待机安静，工作时短暂响应。拖动后停在你放的位置，点击打开聊天入口，右键恢复跟随。</p></section><section class="card ghost"><h2>Live2D / 更多效果集</h2><p class="small">预留适配器位置</p><p class="small">使用相同的动作信号，替换角色渲染方式。此预览未加载 Live2D 模型。</p></section></div>
<div class="steps"><span>看向目标</span><span>靠近 · 点击反馈</span><span>输入反馈</span><span>滚动反馈</span><span>回到待机</span></div>
${nativeTrial ? '<button id="native" class="primary">用真实 CUA 试填表单</button><button id="stop">立即停止（⌘/Ctrl ⇧ Esc）</button>' : ""}
<p id="result"></p><footer>${nativeTrial ? "试填使用原生 CUA，只操作新开的公开测试表单窗口，不提交。此独立实验室仍没有真实聊天。" : "此窗口只演示动作，不会点击、输入或读取其他应用。"} 关闭窗口即退出预览。<br>正式联动入口：CodeShell 设置 → 电脑操控 → 显示 Mimi 操作角色。</footer>
<script>const result=document.querySelector('#result');document.querySelector('#stop')?.addEventListener('click',()=>window.preview.stop());async function run(action){try{result.textContent='';await action();}catch(error){result.textContent='预览未完成：'+String(error.message).replace(/^Error invoking remote method '[^']+': Error: /,'');}}document.querySelector('#preview').onclick=()=>run(()=>window.preview.run(Number(document.querySelector('#display').value)));document.querySelector('#enabled').onchange=e=>run(()=>window.preview.toggle(e.target.checked));document.querySelector('#size').onchange=e=>run(()=>window.preview.size(Number(e.target.value)));for(const name of ['native'])document.querySelector('#'+name)?.addEventListener('click',async(e)=>{e.target.disabled=true;try{await run(()=>window.preview[name]());}finally{e.target.disabled=false;}});</script></html>`;
  await control.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  console.log("Mimi companion: preview controls ready");
  if (process.argv.includes("--external-cua")) {
    await host.update({ enabled: true });
    await control.webContents.executeJavaScript("document.querySelector('#enabled').checked=true");
    const activity = createConnection(execution.mcpProxy.socketPath);
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
        // A background CUA action need not move the human's pointer. Only
        // explicit, authoritative global coordinates may move the character.
        activity.write(JSON.stringify({ ...event, token: execution.mcpProxy.token }) + "\n");
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
  if (process.argv.includes("--stage-demo")) {
    // Scripted presentation only: content-free events through the real
    // activity channel, using this lab window as the "target window". No
    // computer input, no driver, no other app is touched.
    await host.update({ enabled: true, size: 240 });
    const area = trialDisplay.workArea;
    control.setBounds({
      x: Math.round(area.x + 80),
      y: Math.round(area.y + 300),
      width: 940,
      height: Math.min(740, area.height - 340),
    });
    const frame = control.getBounds();
    const channel = createConnection(execution.mcpProxy.socketPath);
    await new Promise<void>((resolveConnect, reject) => {
      channel.once("connect", resolveConnect);
      channel.once("error", reject);
    });
    const send = (event: Record<string, unknown>) =>
      channel.write(JSON.stringify({ ...event, token: execution.mcpProxy.token }) + "\n");
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const actor = () =>
      BrowserWindow.getAllWindows().find((win) => win !== control && !win.isDestroyed());
    const report = async (label: string) => {
      const seen = await actor()?.webContents.executeJavaScript(
        `(() => { const body = document.querySelector('.mimi-companion'); const sprite = document.querySelector('.mimi-companion__sprite'); return body && { perch: body.dataset.perch, travel: body.dataset.travel, action: body.dataset.action, animation: sprite?.dataset.animation, transform: body.style.transform }; })()`,
      );
      console.log("Stage:", label, JSON.stringify(seen));
    };
    const window = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    const scenes = [
      { label: "button near the top", action: "click", element: "button", x: 0.62, y: 70 },
      { label: "text field", action: "click", element: "text", x: 0.3, y: 150 },
      { label: "lower in the window", action: "scroll", element: "list", x: 0.5, y: -40 },
      { label: "back near the top", action: "click", element: "link", x: 0.85, y: 90 },
      {
        label: "no window observed",
        action: "click",
        element: "button",
        x: 0.2,
        y: -120,
        bare: true,
      },
    ];
    await sleep(1_500);
    for (const [index, scene] of scenes.entries()) {
      const id = `stage-demo:${index}`;
      send({
        id,
        action: scene.action,
        phase: "start",
        capture: false,
        targetSource: "native-cursor",
        target: {
          x: frame.x + frame.width * scene.x,
          y: scene.y < 0 ? frame.y + frame.height + scene.y : frame.y + scene.y,
        },
        ...("bare" in scene ? {} : { window }),
        element: scene.element,
      });
      await sleep(120);
      await report(`${scene.label} @120ms`);
      await sleep(480);
      await report(`${scene.label} @600ms`);
      const snapshots = process.argv.find((arg) => arg.startsWith("--stage-snapshots="));
      const shot = snapshots && (await actor()?.webContents.capturePage());
      if (snapshots && shot)
        await writeFile(join(snapshots.slice(18), `stage-${index}.png`), shot.toPNG());
      await sleep(500);
      await report(`${scene.label} @1100ms`);
      send({ id, action: scene.action, phase: "end", capture: false });
      await sleep(1_000);
    }
    channel.destroy();
    console.log("Stage demo finished");
    if (process.argv.includes("--exit")) app.quit();
  }
  if (process.argv.includes("--interaction-demo")) {
    // Real pointer events on the character, the real window hit test and the
    // real gate; no computer input reaches any other app.
    await host.update({ enabled: true, size: 240 });
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const actor = () =>
      BrowserWindow.getAllWindows().find((win) => win !== control && !win.isDestroyed());
    const read = async () =>
      actor()?.webContents.executeJavaScript(
        `(() => { const box = document.querySelector('.mimi-companion'); const body = document.querySelector('.mimi-companion__body')?.getBoundingClientRect(); const offer = document.querySelector('.mimi-companion__handoff'); return box && { yield: box.classList.contains('mimi-companion--yield'), travel: box.dataset.travel, body: body && { x: body.x, y: body.y, width: body.width, height: body.height }, offer: offer?.textContent ?? null }; })()`,
      );
    const channel = createConnection(execution.mcpProxy.socketPath);
    await new Promise<void>((done, reject) => {
      channel.once("connect", done);
      channel.once("error", reject);
    });
    const send = (event: Record<string, unknown>) =>
      channel.write(JSON.stringify({ ...event, token: execution.mcpProxy.token }) + "\n");
    const area = trialDisplay.workArea;
    send({
      id: "interaction:place",
      action: "observe",
      phase: "start",
      capture: false,
    });
    send({
      id: "interaction:click",
      action: "click",
      phase: "start",
      capture: false,
      targetSource: "native-cursor",
      target: { x: area.x + area.width * 0.3, y: area.y + area.height * 0.5 },
    });
    await sleep(1_200);
    send({ id: "interaction:click", action: "click", phase: "end", capture: false });
    await sleep(900);
    execution.gate.setUserActive(true);
    await sleep(400);
    console.log("Interaction: user active", JSON.stringify(await read()));
    execution.gate.setUserActive(false);
    await sleep(400);
    console.log("Interaction: user idle", JSON.stringify(await read()));
    const others = screen.getAllDisplays().filter((item) => item.id !== trialDisplay.id);
    if (others[0]) {
      const far = others[0].workArea;
      send({
        id: "interaction:cross",
        action: "click",
        phase: "start",
        capture: false,
        targetSource: "native-cursor",
        target: { x: far.x + far.width * 0.5, y: far.y + far.height * 0.5 },
      });
      await sleep(60);
      console.log("Interaction: other display", JSON.stringify(await read()));
      send({ id: "interaction:cross", action: "click", phase: "end", capture: false });
      await sleep(1_000);
      send({
        id: "interaction:back",
        action: "click",
        phase: "start",
        capture: false,
        targetSource: "native-cursor",
        target: { x: area.x + area.width * 0.3, y: area.y + area.height * 0.5 },
      });
      await sleep(900);
      send({ id: "interaction:back", action: "click", phase: "end", capture: false });
      await sleep(900);
    }
    const before = await read();
    const win = actor();
    if (win && before?.body) {
      const start = {
        x: Math.round(before.body.x + before.body.width / 2),
        y: Math.round(before.body.y + before.body.height / 2),
      };
      const end = { x: Math.round(area.width * 0.55), y: Math.round(area.height * 0.4) };
      // DevTools input yields real pointer events (capture included).
      const input = win.webContents.debugger;
      if (!input.isAttached()) input.attach("1.3");
      const mouse = (type: string, point: { x: number; y: number }, buttons = 0) =>
        input.sendCommand("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: type === "mouseMoved" && !buttons ? "none" : "left",
          buttons,
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      await mouse("mouseMoved", start);
      await sleep(200);
      await mouse("mousePressed", start, 1);
      for (let step = 1; step <= 12; step++) {
        await mouse(
          "mouseMoved",
          {
            x: Math.round(start.x + ((end.x - start.x) * step) / 12),
            y: Math.round(start.y + ((end.y - start.y) * step) / 12),
          },
          1,
        );
        await sleep(25);
      }
      await mouse("mouseReleased", end);
      await sleep(1_200);
      const offered = await read();
      console.log("Interaction: after drop", JSON.stringify(offered));
      const snapshots = process.argv.find((arg) => arg.startsWith("--stage-snapshots="));
      const shot = snapshots && (await win.webContents.capturePage());
      if (snapshots && shot)
        await writeFile(join(snapshots.slice(18), "handoff.png"), shot.toPNG());
      if (offered?.offer)
        await win.webContents.executeJavaScript(
          "document.querySelector('.mimi-companion__handoff button')?.click()",
        );
      await sleep(600);
      console.log("Interaction: after answer", JSON.stringify(await read()));
    }
    channel.destroy();
    console.log("Interaction demo finished");
    if (process.argv.includes("--exit")) app.quit();
  }
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.allSettled([nativeTrial?.close(), host.close()]).finally(async () => {
      await execution.close().catch(() => {});
      await rm(temporary, { recursive: true, force: true });
      app.quit();
    });
  });
  control.on("closed", () => app.quit());
  if (process.argv.includes("--demo")) await host.preview(trialDisplay.id);
  if (process.argv.includes("--native-smoke")) {
    // Real driver acceptance: fill, refuse while stopped, fill again after resume.
    if (!nativeTrial) throw new Error("--native-smoke requires --native-cua");
    const attempt = async (label: string) => {
      const started = Date.now();
      const outcome = await nativeTrial.run().then(
        () => "filled",
        (error: Error) => error.message,
      );
      const focused = BrowserWindow.getFocusedWindow()?.getTitle() ?? "(none)";
      console.log(
        `Native smoke ${label}: ${outcome} [${Date.now() - started}ms, focused: ${focused}]`,
      );
      return outcome;
    };
    const results = [await attempt("open")];
    execution.stopInput("smoke");
    results.push(await attempt("stopped"));
    execution.resumeInput("smoke");
    results.push(await attempt("resumed"));
    const passed =
      results[0] === "filled" &&
      results[1].startsWith("computer_input_refused (user-stop)") &&
      results[2] === "filled";
    console.log(passed ? "Native smoke passed" : "Native smoke FAILED");
    process.exitCode = passed ? 0 : 1;
    app.quit();
  }
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
      const channel = new CuaActivityChannel(
        execution.mcpProxy.socketPath,
        execution.mcpProxy.token,
      );
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
      // Stop from the character reaches the execution gate, and its state is
      // reflected back to the character for the resume menu.
      await surface.webContents.executeJavaScript("window.mimiCompanion.stopComputer()");
      for (let i = 0; i < 50 && !execution.gate.status().stopped; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!execution.gate.status().stopped) throw new Error("Character stop did not hold input");
      if (!(await readState()).control?.stopped)
        throw new Error("Character did not show the stopped state");
      await surface.webContents.executeJavaScript("window.mimiCompanion.resumeComputer()");
      for (let i = 0; i < 50 && execution.gate.status().stopped; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (execution.gate.status().stopped) throw new Error("Character resume did not release");
      await channel.send({ id: "smoke-input", action: "click", phase: "end", capture: false });
      channel.close();
      await writeFile(
        join(desktopRoot, "out", "mimi-companion-preview.png"),
        (await actor.webContents.capturePage()).toPNG(),
      );
      await host.update({ enabled: false });
      if (!actor.isDestroyed()) throw new Error("Disabling did not destroy the companion surface");
      await host.preview(trialDisplay.id);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const replay = BrowserWindow.getAllWindows().find((win) => win !== control)!;
      const first = await replay.webContents.executeJavaScript("window.mimiCompanion.getState()");
      await host.preview(trialDisplay.id);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const second = await replay.webContents.executeJavaScript("window.mimiCompanion.getState()");
      const action = await replay.webContents.executeJavaScript(
        "document.querySelector('.mimi-companion').dataset.action",
      );
      if (first.activity.id === second.activity.id || action !== "observe")
        throw new Error("A repeated preview did not visibly restart its gesture");
      const box = replay.getContentBounds();
      if (Math.abs(box.x - trialDisplay.bounds.x) > 1)
        throw new Error("Preview used the wrong display");
      if (host.status().enabled) throw new Error("Preview persisted the switch");
      console.log(
        "Mimi companion smoke: human priority, drag, mixed-display placement, chat handoff, stop/resume gate, disable cleanup, repeatable preview on selected screen PASS",
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
