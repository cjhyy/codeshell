/** Manual native Electron gate; intentionally outside unit shards that lack a GUI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--receipt"))
  throw new Error("Usage: node scripts/test-account-device-bridge.mjs [--receipt path]");
const receiptPath = resolve(
  args[1] ?? join(repository, ".code-shell/artifacts/account-relay/account-device-bridge.json"),
);

/** Kill the whole owned fixture group, including Electron helpers, on timeout. */
function run(command, commandArgs, cwd, env, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      detached: grouped,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure;
    const kill = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The fixture may have exited between the deadline and group termination.
      }
    };
    const timer = setTimeout(() => {
      failure = new Error(`Fixture process exceeded ${timeoutMs}ms`);
      kill();
    }, timeoutMs);
    for (const [stream, append] of [
      [child.stdout, (chunk) => (stdout += chunk)],
      [child.stderr, (chunk) => (stderr += chunk)],
    ])
      stream.on("data", (chunk) => {
        append(chunk.toString());
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024) {
          failure = new Error("Fixture process output exceeded its bound");
          kill();
        }
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || signal)
        reject(new Error(`Fixture process failed (${signal ?? code}): ${stderr}`));
      else resolveResult({ stdout, stderr });
    });
  });
}

const temporary = mkdtempSync(join(tmpdir(), "codeshell-account-device-bridge-"));
const startedAt = new Date().toISOString();
try {
  const env = createBunTestEnvironment(process.env, temporary);
  const preloadSource = resolve(repository, "packages/desktop/src/preload/account-device-api.ts");
  const ipcSource = resolve(repository, "packages/desktop/src/main/account-device-ipc.ts");
  writeFileSync(
    join(temporary, "preload-entry.ts"),
    `import { contextBridge } from "electron";
import { accountDeviceApi } from ${JSON.stringify(preloadSource)};
contextBridge.exposeInMainWorld("deliveryFixture", accountDeviceApi);
`,
  );
  // Only these task sources are compiled. No workspace dependency dist is built or cleaned.
  await run(
    "bun",
    [
      "build",
      join(temporary, "preload-entry.ts"),
      ipcSource,
      "--target=node",
      "--format=cjs",
      "--external=electron",
      `--outdir=${temporary}`,
      "--entry-naming=[name].cjs",
    ],
    repository,
    env,
    15_000,
  );
  writeFileSync(
    join(temporary, "main.cjs"),
    String.raw`
const assert = require("node:assert/strict");
const { app, BrowserWindow, ipcMain, session, net: electronNet } = require("electron");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
let deniedNodeRequests = 0;
const denied = () => { deniedNodeRequests++; throw Error("Fixture denies all external network"); };
for (const module of [http, https]) { module.request = denied; module.get = denied; }
net.Socket.prototype.connect = denied;
globalThis.fetch = denied;
electronNet.request = denied;
electronNet.fetch = denied;
syncBuiltinESMExports();
// Install guards before importing the actual IPC implementation or evaluating preload.
const { registerAccountDeviceIpc } = require("./account-device-ipc.cjs");
app.setPath("userData", ${JSON.stringify(join(temporary, "profile"))});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
app.whenReady().then(async () => {
  try {
    let deniedBrowserRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const permitted = details.url.startsWith("data:") || details.url === "about:blank";
      if (!permitted) deniedBrowserRequests++;
      callback({ cancel: !permitted });
    });
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: ${JSON.stringify(join(temporary, "preload-entry.cjs"))},
      contextIsolation: true, sandbox: true,
    }});
    let calls = 0;
    const ipc = registerAccountDeviceIpc({ ipcMain, windows: () => [win], service: {
      setEventSink() {}, retireIdentity() {}, releaseOwner() {},
      send(_owner, input) {
        calls++;
        if (input.text === "preflight")
          throw Object.assign(Error("图片合计超过 1 MiB"), { delivery: "not-sent" });
        if (input.text === "transport")
          throw Object.assign(Error("发送结果未知"), { delivery: "unknown" });
      },
    }});
    await win.loadURL("data:text/html,<meta http-equiv=Content-Security-Policy content=\"default-src 'none'; connect-src 'none'\"><title>Isolated account delivery bridge</title>");
    const outcomes = await win.webContents.executeJavaScript(
      "Promise.all(['preflight','transport','success'].map(text => window.deliveryFixture.send({connectionId:'fixture',text})))"
    );
    ipcMain.removeHandler("accountDevice:send");
    outcomes.push(await win.webContents.executeJavaScript(
      "window.deliveryFixture.send({connectionId:'fixture',text:'ipc-rejected'})"
    ));
    assert.deepEqual(outcomes.map(value => value.ok ? "ok" : value.delivery), ["not-sent", "unknown", "ok", "unknown"]);
    assert.equal(calls, 3);
    assert.throws(() => https.get("https://external.fixture.invalid"), /denies all external network/);
    const browserNetworkDenied = await win.webContents.executeJavaScript(
      "fetch('https://external.fixture.invalid').then(() => false, () => true)"
    );
    assert.equal(browserNetworkDenied, true);
    console.log("ACCOUNT_DEVICE_BRIDGE_RECEIPT=" + JSON.stringify({
      ok: true, checks: 4, outcomes, mainSendCalls: calls,
      network: { policy: "deny-all-external", deniedNodeRequests, deniedBrowserRequests, browserNetworkDenied },
      electron: process.versions.electron,
      contextIsolation: true, sandbox: true,
    }));
    ipc.dispose();
    win.destroy();
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
`,
  );
  const requireDesktop = createRequire(resolve(repository, "packages/desktop/package.json"));
  const electron = requireDesktop("electron");
  const result = await run(electron, [join(temporary, "main.cjs")], temporary, env, 20_000);
  const receiptLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ACCOUNT_DEVICE_BRIDGE_RECEIPT="));
  assert.ok(receiptLine, "Native Electron did not produce its completion receipt");
  const receipt = JSON.parse(receiptLine.slice("ACCOUNT_DEVICE_BRIDGE_RECEIPT=".length));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.checks, 4);
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        ...receipt,
        startedAt,
        completedAt: new Date().toISOString(),
        command: "node scripts/test-account-device-bridge.mjs",
        sourceFiles: [
          "packages/desktop/src/preload/account-device-api.ts",
          "packages/desktop/src/main/account-device-ipc.ts",
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).ok, true);
  console.log(`Account delivery Electron bridge passed (4 cases): ${receiptPath}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
