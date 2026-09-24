import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { openCloudWorkbench } from "../src/main/cloud-workbench-window.js";
import { cloudWorkbenchPartition } from "../src/main/cloud-workbench-policy.js";

async function main(): Promise<void> {
  const timeout = setTimeout(() => {
    console.error("Cloud window smoke timed out");
    app.exit(1);
  }, 30_000);
  const directory = mkdtempSync(join(tmpdir(), "codeshell-cloud-window-"));
  app.setPath("userData", directory);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const servers: ReturnType<typeof createServer>[] = [];
  async function fixture(label: string): Promise<string> {
    const server = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "Set-Cookie": `fixture=${label}; Path=/; SameSite=Lax`,
      });
      res.end(
        `<!doctype html><title>Remote page title</title><body><h1>${label}</h1><a id="inside" href="/project">Project</a><script>localStorage.setItem('fixture','${label}')</script></body>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    return `http://127.0.0.1:${address.port}/`;
  }
  const windowAt = (address: string) =>
    BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(address))!;
  let exitCode = 0;
  try {
    const first = await fixture("cloud-one"),
      second = await fixture("cloud-two");
    await openCloudWorkbench(first);
    let win = windowAt(first);
    assert.ok(win);
    win.hide();
    assert.deepEqual(
      await win.webContents.executeJavaScript(
        "({bridge: typeof window.codeshell, require: typeof require, process: typeof process})",
      ),
      { bridge: "undefined", require: "undefined", process: "undefined" },
    );
    assert.ok(win.getTitle().includes(new URL(first).host));
    assert.equal(win.getTitle().includes("Remote page title"), false);
    await openCloudWorkbench(first);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    win.hide();
    const navigated = new Promise<void>((resolve) =>
      win.webContents.once("did-finish-load", () => resolve()),
    );
    await win.webContents.executeJavaScript("document.getElementById('inside').click()");
    await navigated;
    assert.equal(win.webContents.getURL(), `${first}project`);
    const blocked = new Promise<void>((resolve) =>
      win.webContents.once("will-navigate", () => resolve()),
    );
    await win.webContents.executeJavaScript(`location.href=${JSON.stringify(second)}`);
    await blocked;
    assert.equal(win.webContents.getURL(), `${first}project`);
    await win.webContents.executeJavaScript(`window.open(${JSON.stringify(second)})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await openCloudWorkbench(second);
    const other = windowAt(second);
    assert.ok(other);
    other.hide();
    assert.notEqual(win.webContents.session, other.webContents.session);
    assert.notEqual(win.webContents.session, session.defaultSession);
    assert.equal(
      (await win.webContents.session.cookies.get({ name: "fixture" }))[0].value,
      "cloud-one",
    );
    assert.equal(
      (await other.webContents.session.cookies.get({ name: "fixture" }))[0].value,
      "cloud-two",
    );
    assert.equal((await session.defaultSession.cookies.get({ name: "fixture" })).length, 0);
    win.destroy();
    await openCloudWorkbench(first);
    win = windowAt(first);
    win.hide();
    assert.equal(
      (
        await session.fromPartition(cloudWorkbenchPartition(first)).cookies.get({ name: "fixture" })
      )[0].value,
      "cloud-one",
    );
    await assert.rejects(openCloudWorkbench(`${first}#setup=secret`));
    console.log(
      "PASS: real Electron cloud window has no local bridge, enforces same-origin navigation, isolates sessions, preserves login and reuses each environment window",
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    // Chromium still owns cache handles until exit; this directory is test-only.
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    clearTimeout(timeout);
    app.exit(exitCode);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
