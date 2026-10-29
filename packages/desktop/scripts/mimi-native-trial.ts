/** Manual acceptance fixture. Uses the production MCP observer and real native
 * input against its own public test-form window; never sends the form. */
import { BrowserWindow, screen } from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CuaDriverHost } from "../src/main/computer-use/cua-driver-host.js";
import type { MimiCompanionHost } from "../src/main/computer-use/mimi-companion-host.js";
import type { CuaDriverHostOptions } from "../src/main/computer-use/cua-driver-host.js";

export function createMimiNativeTrial(options: {
  companion: MimiCompanionHost;
  mcpProxy: NonNullable<CuaDriverHostOptions["mcpProxy"]>;
  bundle: { helperPath: string; driverPath: string };
  displayId: number;
  status(message: string): void;
  onRunningChange?(running: boolean): void;
  requestTimeoutMs?: number;
}) {
  let daemon: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  const driver = new CuaDriverHost({
    ...options.bundle,
    parentEnv: process.env,
    mcpProxy: options.mcpProxy,
    maxRestarts: 0,
    spawn: (command, args, config) => {
      if (stopped) throw new Error("本次试填已停止");
      daemon = spawn(command, args, config);
      return daemon;
    },
  });
  let form: BrowserWindow | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let sequence = 0;
  let running = false;
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const failPending = (message = "原生 CUA 连接已关闭") => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    pending.clear();
  };
  async function stop(message = "已停止本次试填；重新打开实验室后才可再次运行。") {
    stopped = true;
    failPending(message);
    // A rejected request does not cancel native input. Stop this fixture's
    // privately owned daemon immediately, before allowing any UI to restart it.
    const stopping = driver.stop();
    daemon?.kill("SIGKILL");
    child?.kill("SIGTERM");
    options.onRunningChange?.(false);
    options.status(message);
    await stopping;
  }
  async function request(method: string, params: unknown): Promise<any> {
    if (stopped) throw new Error("本次试填已停止，未发送输入");
    if (!child?.stdin || child.exitCode !== null) throw new Error("CUA 尚未连接");
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        void stop("CUA 操作超时，已终止本次输入驱动；不会重试。");
        reject(new Error("CUA 操作超时，已停止"));
      }, options.requestTimeoutMs ?? 20_000);
      pending.set(id, { resolve, reject, timer });
      child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await request("tools/call", { name, arguments: args });
    if (result?.isError)
      throw new Error(result.content?.find((part: any) => part.type === "text")?.text ?? name);
    return result;
  }
  async function connect() {
    if (child && child.exitCode === null) return;
    await driver.start();
    if (stopped) throw new Error("本次试填已停止");
    const declaration = driver.mcpDeclaration();
    child = spawn(declaration.command, declaration.args, {
      env: { ...process.env, ...declaration.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        const item = pending.get(value.id);
        if (!item) return;
        pending.delete(value.id);
        clearTimeout(item.timer);
        if (value.error) item.reject(new Error(value.error.message));
        else item.resolve(value.result);
      } catch {
        // Only complete JSON-RPC responses settle requests.
      }
    });
    child.on("error", () => failPending());
    child.on("close", () => {
      lines.close();
      failPending();
    });
    child.stderr!.on("data", () => {});
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mimi-native-acceptance", version: "1" },
    });
    child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }
  return {
    cancel: stop,
    async run() {
      if (stopped) throw new Error("本次试填已停止，请重新打开实验室");
      if (running) return;
      running = true;
      const deadline = setTimeout(() => void stop("试填超过 30 秒，已停止本次输入驱动。"), 30_000);
      try {
        options.onRunningChange?.(true);
        options.status("正在连接原生 CUA…");
        await connect();
        const display = screen.getAllDisplays().find((item) => item.id === options.displayId);
        if (!display) throw new Error("所选扩展屏已断开");
        if (!form || form.isDestroyed()) {
          form = new BrowserWindow({
            title: "Mimi CUA · Web form",
            show: false,
            x: display.workArea.x + 300,
            y: display.workArea.y + 130,
            width: Math.min(1600, display.workArea.width - 360),
            height: Math.min(1000, display.workArea.height - 180),
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
          });
          form.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          form.on("page-title-updated", (event) => event.preventDefault());
        }
        await form.loadURL("https://www.selenium.dev/selenium/web/web-form.html");
        if (stopped) throw new Error("本次试填已停止");
        // Background delivery must not depend on focus, so never take it.
        form.showInactive();
        await options.companion.update({ enabled: true });
        const actor = BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().includes("mimi-companion.html"),
        );
        await actor?.webContents.executeJavaScript("window.mimiCompanion.resumeFollowing()");
        const findWindows = async () => {
          const data = (await call("list_windows", { pid: process.pid })).structuredContent;
          return Array.isArray(data) ? data : data?.windows;
        };
        // WindowServer can redact titles. Match only this process and the
        // actual bounds of the window we just created, not a title or a guessed
        // initial display size (macOS can adjust the initial native frame).
        const bounds = form.getBounds();
        const matchWindow = (windows: any[] | undefined) => {
          const matches = windows?.filter(
            (item: any) =>
              item.pid === process.pid &&
              ["x", "y", "width", "height"].every(
                (key) => Math.abs(item.bounds?.[key] - bounds[key as keyof typeof bounds]) <= 1,
              ),
          );
          return matches?.length === 1 ? matches[0] : undefined;
        };
        // A just-shown window reaches WindowServer's list a moment later.
        let window = matchWindow(await findWindows());
        for (let attempt = 0; !window && attempt < 10 && !stopped; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          window = matchWindow(await findWindows());
        }
        const windowId = window?.window_id ?? window?.id;
        if (!Number.isInteger(windowId)) throw new Error("CUA 未找到本次测试窗口");
        const target = { pid: process.pid, window_id: windowId };
        const snapshot = async () =>
          (await call("get_window_state", { ...target, include_screenshot: false }))
            .structuredContent;
        const editableField = (state: any, label: string) =>
          state?.elements?.find(
            (item: any) => item.label === label && /text.?field|text.?area/i.test(item.role),
          );
        for (const [label, text] of [
          ["Text input", "Mimi native CUA"],
          ["Textarea", "Mimi works here. Human interaction comes first."],
        ]) {
          // Chromium builds a web page's AX tree only after the driver first
          // asks for it, so a fresh page can briefly expose just its frame.
          let field = editableField(await snapshot(), label);
          for (let attempt = 0; !field && attempt < 10 && !stopped; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            field = editableField(await snapshot(), label);
          }
          if (!field?.element_token) throw new Error(`CUA 未找到表单字段：${label}`);
          options.status(`真实 CUA 正在填写：${label}`);
          await call("click", {
            ...target,
            element_token: field.element_token,
          });
          const focusedField = editableField(await snapshot(), label);
          if (!focusedField?.element_token) throw new Error(`字段已变化：${label}`);
          // cua-driver refuses background keystrokes into Electron web content;
          // a whole-value AX write is the background route, as policy prefers.
          await call("set_value", {
            ...target,
            element_token: focusedField.element_token,
            value: text,
          });
          const cursor = (await call("get_agent_cursor_state")).structuredContent;
          const presentation = await actor?.webContents.executeJavaScript(
            "window.mimiCompanion.getState()",
          );
          if (
            !cursor?.position ||
            !presentation?.target ||
            Math.abs(presentation.target.x + presentation.windowOrigin.x - cursor.position.x) > 1 ||
            Math.abs(presentation.target.y + presentation.windowOrigin.y - cursor.position.y) > 1
          ) {
            throw new Error(
              `宠物操作落点与原生虚拟光标未对齐：${JSON.stringify({
                cursor: cursor?.position,
                target: presentation?.target,
                origin: presentation?.windowOrigin,
              })}`,
            );
          }
          console.log("Native placement verified:", {
            action: "type",
            cursor: cursor.position,
            overlayOrigin: presentation.windowOrigin,
            overlayTarget: presentation.target,
          });
          const fieldBox = focusedField.frame;
          const actorBox = {
            x: presentation.position.x + presentation.windowOrigin.x,
            y: presentation.position.y + presentation.windowOrigin.y,
            width: presentation.size * 0.7,
            height: presentation.size,
          };
          if (
            !presentation.avoidInput ||
            (actorBox.x < fieldBox.x + fieldBox.w &&
              actorBox.x + actorBox.width > fieldBox.x &&
              actorBox.y < fieldBox.y + fieldBox.h &&
              actorBox.y + actorBox.height > fieldBox.y)
          )
            throw new Error("宠物未避开完整输入框");
          console.log("Native field unobscured:", { field: fieldBox, actor: actorBox });
          const after = await snapshot();
          if (editableField(after, label)?.value !== text)
            throw new Error(`字段未通过原生回读：${label}`);
        }
        // DOM readback is an independent check of the real page effect. No
        // script writes values, dispatches events, or simulates input here.
        const values = await form.webContents.executeJavaScript(
          "[document.querySelector('[name=my-text]').value, document.querySelector('[name=my-textarea]').value]",
        );
        if (
          values[0] !== "Mimi native CUA" ||
          values[1] !== "Mimi works here. Human interaction comes first."
        )
          throw new Error("网页字段与 CUA 回读不一致");
        options.status("真实 CUA 已填好两个字段，并经网页回读核对。未提交表单。");
      } finally {
        clearTimeout(deadline);
        running = false;
        options.onRunningChange?.(false);
      }
    },
    async close() {
      await stop("实验室已关闭，输入驱动已停止。");
      if (form && !form.isDestroyed()) form.destroy();
    },
  };
}
