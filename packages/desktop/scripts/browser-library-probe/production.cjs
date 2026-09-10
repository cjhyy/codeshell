/* global require, document, requestAnimationFrame, Image */
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron main-process CJS fixture. */
const { app, BrowserWindow } = require("electron");
const {
  getElectronBrowser,
  acquireElectronBrowser,
  releaseElectronBrowser,
} = require("./electron-puppeteer.js");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "production-profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.commandLine.appendSwitch("site-per-process");
app.on("window-all-closed", () => {});
const failTimer = setTimeout(() => app.exit(2), 30000);
let server;
const wins = [];
(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      req.url.startsWith("/frame")
        ? '<button id="child" onclick="document.body.dataset.clicked=\'yes\'">Frame button</button>'
        : `<body style="margin:0"><input aria-label="Name"><button id="button" onclick="window.hits=(window.hits||0)+1">Main button</button><iframe src="http://localhost:${server.address().port}/frame" style="height:200px"></iframe><div style="height:1300px"></div><button id="far" onclick="window.farHits=(window.farHits||0)+1">Far button</button><div style="height:1100px"></div></body>`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await app.whenReady();
  for (let i = 0; i < 2; i++) {
    const w = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: { partition: "production-" + i, backgroundThrottling: false, sandbox: true },
    });
    wins.push(w);
    await w.loadURL(`http://127.0.0.1:${server.address().port}/?tab=${i}`);
    w.webContents.setZoomFactor(i ? 1.25 : 1);
    await w.webContents.session.cookies.set({
      url: `http://127.0.0.1:${server.address().port}`,
      name: "fixtureLogin",
      value: "window-" + i,
      httpOnly: true,
    });
  }
  const [a, b] = wins.map((w) => w.webContents);
  const ids = [a.id, b.id],
    sessions = [a.session, b.session];
  const [da, db] = await Promise.all([getElectronBrowser(a), getElectronBrowser(b)]);
  assert.notEqual(da, db);
  const [sa, sb] = await Promise.all([da.snapshot(), db.snapshot()]);
  assert(sa.elements.length > 0);
  assert(sb.elements.length > 0);
  const ra = sa.elements.find((e) => e.name === "Main button").ref;
  const rb = sb.elements.find((e) => e.name === "Far button").ref;
  assert.equal(await getElectronBrowser(a), da);
  assert.equal(await getElectronBrowser(b), db);
  assert.equal((await da.click(ra)).ok, true);
  assert.equal((await db.click(rb)).ok, true);
  assert.equal(await a.executeJavaScript("window.hits"), 1);
  assert.equal(await b.executeJavaScript("window.farHits"), 1);
  assert.equal(await b.executeJavaScript("window.hits"), undefined);
  assert.equal((await db.click(ra)).ok, false);
  const child = sb.elements.find((e) => e.name === "Frame button");
  assert(child);
  const childResult = await db.click(child.ref);
  assert.equal(childResult.ok, true, childResult.detail);
  const frame = db.page.frames().find((f) => f.url().includes("/frame"));
  await frame.waitForFunction(() => document.body.dataset.clicked === "yes", { timeout: 1500 });
  const pixelChecks = [];
  for (const driver of [da, db]) {
    await driver.page.evaluate(() => {
      const box = document.createElement("div");
      box.id = "pixel-fixture";
      box.style =
        "position:fixed;inset:0;z-index:999;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr";
      for (const color of ["red", "lime", "blue", "yellow"]) {
        const part = document.createElement("div");
        part.style.background = color;
        box.appendChild(part);
      }
      document.body.appendChild(box);
    });
    await driver.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const image = await driver.screenshot();
    assert(image.ok, image.detail);
    assert(image.base64);
    const pixels = await driver.page.evaluate(async (base64) => {
      const image = new Image();
      image.src = "data:image/jpeg;base64," + base64;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return {
        width: image.width,
        height: image.height,
        corners: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.1, 0.9],
          [0.9, 0.9],
        ].map(([x, y]) => [...ctx.getImageData(image.width * x, image.height * y, 1, 1).data]),
      };
    }, image.base64);
    assert(pixels.width <= 1568 && pixels.height <= 1568);
    for (const [index, color] of [
      [0, [255, 0, 0]],
      [1, [0, 255, 0]],
      [2, [0, 0, 255]],
      [3, [255, 255, 0]],
    ])
      color.forEach((v, j) => assert(Math.abs(pixels.corners[index][j] - v) < 8));
    pixelChecks.push(pixels);
    await driver.page.evaluate(() => document.querySelector("#pixel-fixture").remove());
  }
  // DevTools is embedded in an invisible fixture window. Its takeover must
  // revoke only that target; closing DevTools does not silently resume.
  const opened = once(a, "devtools-opened");
  a.openDevTools({ mode: "right", activate: false });
  await opened;
  assert(!a.debugger.isAttached());
  await assert.rejects(getElectronBrowser(a), /paused/);
  assert.equal(await getElectronBrowser(b), db);
  a.closeDevTools();
  await new Promise((r) => setTimeout(r, 100));
  const resumed = await acquireElectronBrowser(a);
  assert.notEqual(resumed, da);
  assert.equal((await resumed.click(ra)).ok, false);
  assert.equal((await da.click(ra)).ok, false);
  // External detach cancels a pending library wait promptly without reattaching.
  const pending = resumed.page.waitForSelector("#never-appears", { timeout: 20000 }).then(
    () => false,
    () => true,
  );
  a.debugger.detach();
  assert(await pending);
  await assert.rejects(getElectronBrowser(a), /paused/);
  const again = await acquireElectronBrowser(a);
  const fresh = await again.snapshot();
  assert.equal(
    (await again.click(fresh.elements.find((e) => e.name === "Main button").ref)).ok,
    true,
  );
  releaseElectronBrowser(a);
  releaseElectronBrowser(b);
  for (let i = 0; i < 2; i++) {
    const wc = wins[i].webContents;
    assert.equal(wc.id, ids[i]);
    assert.equal(wc.session, sessions[i]);
    assert.equal((await wc.session.cookies.get({ name: "fixtureLogin" }))[0].value, "window-" + i);
    assert(!wc.debugger.isAttached());
    assert(!wins[i].isVisible());
    assert.equal(wc.debugger.listenerCount("message"), 0);
    assert.equal(wc.debugger.listenerCount("detach"), 0);
    assert(!wc.isDestroyed());
  }
  console.log(
    JSON.stringify({
      passed: true,
      electron: process.versions.electron,
      concurrentTargets: 2,
      zooms: [1, 1.25],
      snapshotRefs: true,
      crossTargetRejected: true,
      oopif: true,
      nativeScreenshots: pixelChecks,
      devToolsPausesOneTarget: true,
      pendingWaitCancelled: true,
      explicitResume: true,
      oldRefsRejected: true,
      sameTargetPartitionCookies: true,
      hidden: true,
      listenersAfterRelease: 0,
      noDebuggingPort: !app.commandLine.hasSwitch("remote-debugging-port"),
    }),
  );
  wins.forEach((w) => w.destroy());
  server.close();
  clearTimeout(failTimer);
  app.quit();
})().catch((e) => {
  console.error(e);
  wins.forEach((w) => w.destroy());
  server?.close();
  app.exit(1);
});
