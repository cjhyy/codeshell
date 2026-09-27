/* Real Electron UI + OS safeStorage + native TLS/WSS; the directory is a controlled protocol fixture.
 * The separate Services candidate acceptance owns real directory implementation coverage. */
/* global window */
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-desktop-relay-ui-");
let app, server, wss;
const sockets = new Set(),
  controls = new Set();
const credential = randomBytes(32).toString("base64url"),
  ticket = randomBytes(32).toString("base64url"),
  hostId = randomUUID();
let identity,
  publicOrigin = `https://${hostId}.devices.test`,
  revoked = false;
async function openSettings(win) {
  const remote = win.getByRole("button", { name: /^(手机遥控|Mobile remote)$/i });
  if (
    await remote.waitFor({ state: "visible", timeout: 5000 }).then(
      () => true,
      () => false,
    )
  ) {
    await remote.click();
    return;
  }
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 1500 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await win
    .getByRole("button", { name: /设置|Settings/i })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /打开设置|Open settings/i }).click();
  await win.getByRole("button", { name: /^(手机遥控|Mobile remote)$/i }).click();
}
async function launch(origin) {
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: { NODE_EXTRA_CA_CERTS: join(isolated.home, "cert.pem") },
  });
  const win = await findCodeShellWindow(app);
  await win.setViewportSize({ width: 1280, height: 1000 });
  const errors = captureRendererErrors(win);
  const secure = await app.evaluate(
    ({ safeStorage }) =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  );
  assert(
    secure,
    "This real-Electron acceptance requires an unlocked OS keychain; plaintext fallback is forbidden.",
  );
  await openSettings(win);
  if (
    !(await win
      .getByLabel("目录地址")
      .isVisible()
      .catch(() => false))
  ) {
    await win.getByRole("combobox").click();
    await win.getByRole("option", { name: /自管中继|Self-hosted relay/ }).click();
  }
  await win.getByLabel("目录地址").fill(origin);
  return { win, errors };
}
try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=desktop-relay-ui",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(isolated.home, "key.pem"),
      "-out",
      join(isolated.home, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    {
      key: await readFile(join(isolated.home, "key.pem")),
      cert: await readFile(join(isolated.home, "cert.pem")),
    },
    async (req, res) => {
      let body = "";
      for await (const bytes of req) body += bytes;
      const data = JSON.parse(body);
      assert(
        req.url === "/api/v1/remote-hosts/enroll" && data.ticket === ticket,
        "Unexpected enrollment request",
      );
      identity = data.environmentId;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hostId,
          environmentId: identity,
          publicOrigin,
          credential,
          credentialEpoch: 1,
          protocolVersion: 1,
        }),
      );
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert(req.headers.authorization === `Bearer ${credential}`, "Unexpected computer credential");
    if (revoked) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      controls.add(ws);
      ws.on("error", () => {});
      ws.on("close", () => controls.delete(ws));
      ws.send(
        JSON.stringify({
          type: "welcome",
          v: 1,
          hostId,
          publicOrigin,
          leaseId: randomBytes(32).toString("base64url"),
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  let { win, errors } = await launch(origin);
  await win.getByLabel("电脑名称").fill("E2E 电脑");
  await win.getByLabel("一次性登记票据").fill(ticket);
  await win.getByRole("button", { name: "登记电脑", exact: true }).click();
  await win.getByText("已登记，连接已停止", { exact: true }).waitFor();
  assert(
    (await win.getByLabel("一次性登记票据").inputValue()) === "",
    "Ticket remains in the field",
  );
  assert(controls.size === 0, "Enrollment automatically opened a public connection");
  const snapshot = await win.evaluate(() => window.codeshell.mobileRemote.relay.status());
  assert(
    !JSON.stringify(snapshot).includes(credential),
    "Credential reached the renderer snapshot",
  );
  const stored = await readFile(join(isolated.userDataDir, "mobile-remote", "relay.enc"));
  assert(!stored.includes(Buffer.from(credential)), "Credential was saved in plaintext");
  assert(
    JSON.parse(await readFile(join(isolated.codeShellHome, "desktop", "environment.json"))).id ===
      identity,
    "Enrollment used a different environment identity",
  );
  const passcode = win.locator('input[type="password"]').last();
  await passcode.fill("123456");
  await win.getByRole("button", { name: "设置口令", exact: true }).click();
  await win.getByRole("button", { name: "连接中继", exact: true }).click();
  await win.getByText("电脑在线", { exact: true }).waitFor();
  await win.locator('img[alt*="二维码"]').waitFor();
  if (process.env.CODESHELL_RELAY_SCREENSHOT)
    await win.screenshot({ path: process.env.CODESHELL_RELAY_SCREENSHOT, animations: "disabled" });
  await win.getByRole("button", { name: "关闭", exact: true }).click();
  await win.getByText("已登记，连接已停止", { exact: true }).waitFor();
  assert(errors.length === 0, "Renderer errors before restart");
  await win.getByRole("button", { name: "连接中继", exact: true }).click();
  await win.getByText("电脑在线", { exact: true }).waitFor();
  await app.close();
  app = undefined;
  ({ win, errors } = await launch(origin));
  await win.getByText("已登记，连接已停止", { exact: true }).waitFor();
  assert(controls.size === 0, "Desktop restart automatically opened a connection");
  await win.getByRole("button", { name: "连接中继", exact: true }).click();
  await win.getByText("电脑在线", { exact: true }).waitFor();
  revoked = true;
  for (const ws of controls) ws.terminate();
  await win.getByText("登记已被撤销或替换，请重新登记。", { exact: true }).waitFor();
  await win.waitForFunction(async () => !(await window.codeshell.mobileRemote.status()).running);
  assert(
    !(await win.evaluate(() => window.codeshell.mobileRemote.relay.status())).registered,
    "Revoked credential still registered",
  );
  assert(errors.length === 0, "Renderer errors after restart");
  revoked = false;
  await win.getByLabel("电脑名称").fill("E2E 电脑");
  await win.getByLabel("一次性登记票据").fill(ticket);
  await win.getByRole("button", { name: "登记电脑", exact: true }).click();
  await win.getByText("已登记，连接已停止", { exact: true }).waitFor();
  await win.getByRole("button", { name: "移除本机登记", exact: true }).click();
  await win.getByRole("dialog").getByRole("button", { name: "移除本机登记", exact: true }).click();
  await win.getByText("尚未登记", { exact: true }).waitFor();
  await win.getByRole("combobox").click();
  await win.getByRole("option", { name: /局域网/ }).click();
  await win.getByRole("button", { name: /开启手机遥控/ }).click();
  await win.waitForFunction(
    async () => (await window.codeshell.mobileRemote.status()).mode === "lan",
  );
  await win.getByRole("button", { name: "关闭", exact: true }).click();
  console.log(
    "PASS actual Electron relay settings: UI enrollment, OS-encrypted main-only credential, stable environment ID, explicit start/passcode/QR, stop, default-off restart and directory rejection cleanup",
  );
} finally {
  await app?.close();
  for (const ws of controls) ws.terminate();
  for (const socket of sockets) socket.destroy();
  if (wss) await new Promise((resolve) => wss.close(resolve));
  if (server) await new Promise((resolve) => server.close(resolve));
  await isolated.cleanup();
}
