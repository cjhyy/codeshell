/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Electron main-process CJS fixture. */
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const { join } = require("node:path");
const { installElectronDebuggerFacade } = require("./electron-debugger-facade.cjs");

const offscreen = process.argv.includes("--offscreen");
app.setPath("userData", join(__dirname, "fixture-profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.commandLine.appendSwitch("site-per-process");
app.on("window-all-closed", () => {});

function fixturePage(port) {
  return `<!doctype html><html><body style="margin:0">
    <h1>Existing target fixture</h1>
    <input id="name"><select id="choice"><option value="a">A</option><option value="b">B</option></select>
    <div id="nested" style="height:150px;width:300px;overflow:auto">
      <div style="height:700px"></div>
      <button id="deep" onclick="window.deepHits=(window.deepHits||0)+1">Nested button</button>
    </div>
    <iframe src="http://localhost:${port}/frame" style="height:240px"></iframe>
    <div style="height:1100px"></div>
    <button id="far" onclick="window.farHits=(window.farHits||0)+1">Far button</button>
    <div style="height:1200px"></div>
    </body></html>`;
}

async function checkWindow(puppeteer, server, zoom) {
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      offscreen,
      backgroundThrottling: false,
      partition: `library-probe-${zoom}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const sibling = new BrowserWindow({
    show: false,
    webPreferences: { partition: "unrelated-probe" },
  });
  const wc = window.webContents;
  const originalId = wc.id;
  const originalSession = wc.session;
  const facade = installElectronDebuggerFacade(wc);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  let browser;
  const connect = async () => {
    const transport = await puppeteer.ExtensionTransport.connectTab(wc.id);
    return puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: 5000 });
  };
  try {
    await sibling.loadURL("data:text/html,Unrelated fixture target");
    await originalSession.cookies.set({
      url,
      name: "fixtureLogin",
      value: "preserved",
      httpOnly: true,
    });
    await window.loadURL(url);
    wc.setZoomFactor(zoom);
    browser = await connect();
    const pages = await browser.pages();
    assert.equal(pages.length, 1, "Only the selected target is exposed");
    const page = pages[0];
    page.setDefaultTimeout(5000);

    await page.locator("#name").fill("existing signed-in tab");
    assert.equal(await page.$eval("#name", (element) => element.value), "existing signed-in tab");
    await page.select("#choice", "b");
    assert.equal(await page.$eval("#choice", (element) => element.value), "b");
    await page.locator("#deep").click();
    assert.equal(await page.evaluate(() => window.deepHits), 1);
    const nestedScroll = await page.$eval("#nested", (element) => element.scrollTop);
    assert(nestedScroll > 500, "Locator reveals a nested scroll container target");
    await page.locator("#far").click();
    assert.equal(await page.evaluate(() => window.farHits), 1);
    const documentScroll = await page.evaluate(() => window.scrollY);
    assert(documentScroll > 1000, "Locator reveals a document target outside the viewport");

    const frames = page.frames();
    const frame = frames.find((candidate) => candidate.url().endsWith("/frame"));
    assert(frame, "Cross-origin child frame is discovered");
    assert(facade.childSessions.size > 0, "OOPIF events include a native child session");
    await frame.locator("#frameButton").click();
    let iframeClicked = false;
    try {
      await frame.waitForFunction(() => window.document.body.dataset.clicked === "yes", {
        timeout: 1000,
      });
      iframeClicked = true;
    } catch (error) {
      if (!offscreen) throw error;
      // Keep the offscreen diagnostic running so it also checks target lifetime.
    }

    assert.equal(wc.id, originalId);
    assert.equal(wc.session, originalSession);
    assert.equal(
      (await originalSession.cookies.get({ name: "fixtureLogin" }))[0].value,
      "preserved",
    );
    assert(!window.isVisible());
    assert(!sibling.webContents.debugger.isAttached());
    // Disconnect releases automation without closing either browser window.
    await browser.disconnect();
    browser = undefined;
    assert(!wc.debugger.isAttached());
    assert(!wc.isDestroyed());
    assert.equal(facade.listeners.size, 0);

    browser = await connect();
    const resumed = (await browser.pages())[0];
    resumed.setDefaultTimeout(5000);
    await resumed.locator("#name").fill("resumed on the same target");
    assert.equal(
      await resumed.$eval("#name", (element) => element.value),
      "resumed on the same target",
    );
    await browser.disconnect();
    browser = undefined;
    assert(!wc.debugger.isAttached());
    assert.equal(wc.id, originalId);
    assert.equal(wc.session, originalSession);
    assert.equal(
      (await originalSession.cookies.get({ name: "fixtureLogin" }))[0].value,
      "preserved",
    );
    assert(!window.isVisible());
    assert(!sibling.webContents.debugger.isAttached());
    assert.equal(facade.listeners.size, 0);

    return {
      zoom,
      dpr: await wc.executeJavaScript("devicePixelRatio"),
      offscreen,
      fill: true,
      select: true,
      nestedScroll,
      documentScroll,
      iframeFrames: frames.length,
      iframeClicked,
      childSessions: facade.childSessions.size,
      sameTarget: true,
      samePartition: true,
      cookiePreserved: true,
      hidden: true,
      siblingUntouched: true,
      debuggerReleased: true,
      reconnected: true,
    };
  } finally {
    if (browser) await browser.disconnect();
    window.destroy();
    sibling.destroy();
    delete globalThis.chrome;
  }
}

async function main() {
  // Both imported entry points are public; there are no Puppeteer internal imports.
  const puppeteer = await import("puppeteer-core");
  const version = require("puppeteer-core/package.json").version;
  assert.equal(version, "23.7.1");
  assert.equal(
    process.versions.electron,
    "33.4.11",
    "Use the repository's reviewed Electron runtime",
  );
  assert(!app.commandLine.hasSwitch("remote-debugging-port"));
  assert(!app.commandLine.hasSwitch("remote-debugging-pipe"));
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      request.url === "/frame"
        ? '<button id="frameButton" onclick="document.body.dataset.clicked=\'yes\'">Frame button</button>'
        : fixturePage(server.address().port),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await app.whenReady();
    const results = [];
    for (const zoom of [1, 1.25]) {
      results.push(await checkWindow(puppeteer, server, zoom));
    }
    const passed = results.every((result) => result.iframeClicked);
    console.log(
      JSON.stringify(
        {
          passed,
          puppeteer: version,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          noDebuggingPort: true,
          results,
        },
        null,
        2,
      ),
    );
    app.exit(passed ? 0 : 1);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
