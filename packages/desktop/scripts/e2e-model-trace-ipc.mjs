/* Real model history preload → Electron IPC → fixed Host store, without model traffic. */
/* global window */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-model-trace-ipc-");
let app;
try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  const store = new ModelTraceStore({
    storageDir: join(isolated.codeShellHome, "sessions", ".model-traces"),
  });
  store.setConfig({ captureContent: true });
  const now = Date.now();
  store.write({
    version: 1,
    id: "fixture-record",
    traceId: "fixture-run",
    sessionId: "fixture-session",
    workspacePath: isolated.home,
    source: "fixture",
    purpose: "main",
    provider: "fixture",
    model: "fixture-model",
    startedAt: now,
    endedAt: now,
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: {
      systemPrompt: "Fixture system",
      messages: [{ role: "user", content: "Fixture submitted prompt" }],
      tools: [],
      parameters: {},
    },
    outputState: "recorded",
    output: { text: "Fixture response", stopReason: "stop" },
    attempts: [],
  });
  store.writeEvent({
    id: "fixture-tool",
    traceId: "fixture-run",
    sessionId: "fixture-session",
    workspacePath: isolated.home,
    kind: "tool",
    name: "Read",
    startedAt: now,
    endedAt: now,
    status: "completed",
    inputState: "not-recorded",
    outputState: "not-recorded",
  });
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: { CODE_SHELL_TEST_HOME: isolated.codeShellHome },
  });
  const win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  const page = await win.evaluate(() =>
    window.codeshell.modelTraces.list({ search: "fixture-model" }),
  );
  assert(
    page.items.length === 1 && page.items[0].id === "fixture-record",
    "Real preload reads persisted model metadata",
  );
  const detail = await win.evaluate(() => window.codeshell.modelTraces.get("fixture-record"));
  assert(
    detail?.record.input.systemPrompt === "Fixture system",
    "Real IPC returns captured request content",
  );
  assert(detail?.events[0]?.id === "fixture-tool", "Events use trace identity");
  const config = await win.evaluate(() =>
    window.codeshell.modelTraces.setConfig({ captureContent: false, includeEphemeral: true }),
  );
  assert(
    !config.captureContent && config.includeEphemeral,
    "Native IPC applies independent explicit capture settings",
  );
  assert(
    !store.getConfig().captureContent && store.getConfig().includeEphemeral,
    "Capture settings persist before IPC resolves",
  );
  const rejected = await win.evaluate(async () => {
    try {
      await window.codeshell.modelTraces.list({ storageDir: "/tmp/foreign-model-store" });
      return false;
    } catch {
      return true;
    }
  });
  assert(rejected, "Renderer cannot choose another Host store");
  const foreign = await app.evaluate(async ({ BrowserWindow }) => {
    const guest = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    try {
      await guest.loadURL("data:text/html,<title>Unregistered IPC caller</title>");
      return await guest.webContents.executeJavaScript(
        `require("electron").ipcRenderer.invoke("modelTraces:list").then(() => "unexpected success", error => error.message)`,
      );
    } finally {
      guest.destroy();
    }
  });
  assert(
    foreign.includes("application window"),
    "Unregistered Electron windows cannot inspect raw prompts",
  );
  assert(errors.length === 0, "No renderer exceptions");
  console.log(
    "PASS: real model trace preload/IPC, durable config, trace event identity and foreign-window rejection",
  );
} finally {
  await app?.close();
  await isolated.cleanup();
}
