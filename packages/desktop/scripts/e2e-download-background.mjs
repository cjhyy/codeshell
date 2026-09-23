/* Actual installed Download Panel, Electron bridge, native task and yt-dlp.
 * Uses only an isolated project and an FFmpeg-generated loopback video. */
/* global window, document */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
const packagePath = process.argv[2];
const authenticated = process.argv.includes("--cookies");
if (!packagePath) throw new Error("Pass the Download Panel package directory");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-download-background-");
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const project = join(isolated.home, "project"),
  install = join(isolated.codeShellHome, "panel-apps/video-download");
let electron, server;
async function until(read, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 900));
  }
  throw new Error(message);
}
try {
  await mkdir(join(project, ".code-shell"), { recursive: true });
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await cp(resolve(packagePath), install, { recursive: true });
  const manifest = JSON.parse(await readFile(join(install, ".codeshell-panel/panel.json"), "utf8"));
  const installedAt = new Date().toISOString();
  await writeFile(
    join(install, ".cs-panel-app-meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      source: install,
      installedAt,
    }),
  );
  await writeFile(
    join(isolated.codeShellHome, "panel-apps/installed.json"),
    JSON.stringify({
      version: 1,
      apps: [
        {
          id: manifest.id,
          version: manifest.version,
          source: install,
          installedAt,
          lastUpdated: installedAt,
        },
      ],
    }),
  );
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [manifest.id] }),
  );
  await writeFile(
    join(isolated.codeShellHome, "desktop/recents.json"),
    JSON.stringify([{ path: project, name: "Download test", lastOpenedAt: Date.now() }]),
  );
  const source = join(isolated.home, "fixture.mp4");
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=128x72:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    source,
  ]);
  const bytes = await readFile(source);
  let tls, caFile, fixtureBin;
  const diagnostic = join(isolated.home, "fixture-downloader.log");
  let authorizedRequests = 0,
    deniedRequests = 0;
  if (authenticated) {
    caFile = join(isolated.home, "fixture-cert.pem");
    const keyFile = join(isolated.home, "fixture-key.pem");
    const configFile = join(isolated.home, "fixture-openssl.conf");
    await writeFile(
      configFile,
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n",
    );
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      configFile,
      "-keyout",
      keyFile,
      "-out",
      caFile,
    ]);
    tls = { key: await readFile(keyFile), cert: await readFile(caFile) };
    const downloader = (await promisify(execFile)("which", ["yt-dlp"])).stdout.trim();
    fixtureBin = join(isolated.userDataDir, "bin");
    await mkdir(fixtureBin, { recursive: true });
    // Trust only this test CA through Python's SSL_CERT_FILE. No system trust
    // store changes or disabled TLS verification; real yt-dlp handles the download.
    await writeFile(
      join(fixtureBin, "yt-dlp"),
      "#!" +
        process.execPath +
        "\n" +
        "const {spawnSync}=require('node:child_process'); const result=spawnSync(" +
        JSON.stringify(downloader) +
        `,["--compat-options","no-certifi",...process.argv.slice(2)],{stdio:['inherit','inherit','pipe'],env:{...process.env,SSL_CERT_FILE:${JSON.stringify(caFile)}}}); require('node:fs').writeFileSync(${JSON.stringify(diagnostic)},result.stderr || String(result.error || '')); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);\n`,
      { mode: 0o700 },
    );
    await promisify(execFile)(join(fixtureBin, "yt-dlp"), ["--ignore-config", "--version"], {
      timeout: 120000,
    });
    await writeFile(
      join(project, ".code-shell/credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "download-fixture",
            type: "cookie",
            label: "Download fixture account",
            meta: { domain: "127.0.0.1" },
            secret: JSON.stringify([
              {
                domain: "127.0.0.1",
                path: "/",
                secure: true,
                name: "session",
                value: "download-cookie-fixture",
              },
            ]),
          },
        ],
      }),
      { mode: 0o600 },
    );
  }
  const respond = (request, response) => {
    if (authenticated && request.headers.cookie !== "session=download-cookie-fixture") {
      deniedRequests++;
      response.writeHead(403).end("Fixture requires its saved account");
      return;
    }
    if (authenticated) authorizedRequests++;

    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    if (request.method === "HEAD") return response.end();
    const timer = setTimeout(() => response.end(bytes), 4000);
    response.on("close", () => clearTimeout(timer));
  };
  server = authenticated ? createTlsServer(tls, respond) : createServer(respond);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `${authenticated ? "https" : "http"}://127.0.0.1:${server.address().port}/fixture.mp4`;
  electron = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    ...(authenticated
      ? {
          env: {
            SSL_CERT_FILE: caFile,
            REQUESTS_CA_BUNDLE: caFile,
            PATH: fixtureBin + ":" + process.env.PATH,
          },
        }
      : {}),
  });
  if (authenticated)
    await electron.evaluate(({ dialog }) => {
      globalThis.__downloadCookiePrompts = [];
      dialog.showMessageBox = async (_owner, options) => {
        globalThis.__downloadCookiePrompts.push(options);
        return { response: 0, checkboxChecked: false };
      };
    });
  const win = await findCodeShellWindow(electron);
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 3000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await win.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), project);
  const descriptor = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.listPanelApps(cwd, "en")).find(
        (item) => item.appId === "video-download",
      ),
    project,
  );
  assert.ok(descriptor);
  async function open() {
    const prepared = await win.evaluate(
      ({ id, cwd }) => window.codeshell.preparePanelApp(id, cwd),
      { id: descriptor.id, cwd: project },
    );
    await win.evaluate(({ src, partition }) => {
      const view = document.createElement("webview");
      view.id = "download-background";
      view.setAttribute("partition", partition);
      view.setAttribute("src", src);
      view.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:99999";
      document.body.appendChild(view);
    }, prepared);
    await win.waitForFunction(
      () => document.getElementById("download-background")?.getWebContentsId?.() > 0,
    );
    const view = win.locator("#download-background");
    const guestId = await view.evaluate((view) => view.getWebContentsId());
    await win.evaluate(
      ({ guestId, id, cwd }) =>
        window.codeshell.bindPanelApp({
          guestId,
          appDescriptorId: id,
          tabId: "download-background",
          bucket: "download-background",
          projectPath: cwd,
          cwd,
          visible: true,
          busy: false,
          theme: "light",
          locale: "en",
        }),
      { guestId, id: descriptor.id, cwd: project },
    );
    return (code) => view.evaluate((view, code) => view.executeJavaScript(code), code);
  }
  let guest = await open();
  await until(
    async () =>
      guest(
        'Boolean(document.querySelector("#installed-ytdlp-version")?.textContent.match(/20\\d{2}/))',
      ).catch(() => false),
    "Download Panel dependencies did not become ready",
  );
  await guest(
    `document.querySelector("#url-input").value = ${JSON.stringify(url + "\n" + url.replace("fixture.mp4", "second.mp4"))}; document.querySelector("#url-input").dispatchEvent(new Event("input", {bubbles:true}));`,
  );
  await until(
    () => guest('!document.querySelector("#download-button").disabled'),
    "Download form did not become ready",
  );
  await guest(
    'window.codeshellPanel.call("tasks.queue.set", {expectedRevision:0, paused:false, maxConcurrent:1})',
  );
  if (authenticated) {
    await until(
      () =>
        guest(
          'document.querySelector("#cookie-select")?.querySelector(' +
            JSON.stringify('option[value="download-fixture"]') +
            ") !== null",
        ),
      "Saved download account was not listed",
    );
    await guest(
      'document.querySelector("#cookie-select").value = "download-fixture"; document.querySelector("#cookie-select").dispatchEvent(new Event("change", {bubbles:true}));',
    );
  }
  if (authenticated) {
    await guest('document.querySelector("#inspect-button").click()');
    await until(
      async () => {
        const state = await guest(
          '({state:document.querySelector("#inspect-status").dataset.state,text:document.querySelector("#inspect-status").textContent})',
        );
        if (state.state === "error")
          throw new Error("Saved-account metadata failed: " + state.text);
        return state.state === "ready";
      },
      "Saved-account metadata did not complete",
      180000,
    );
  }
  await guest('document.querySelector("#download-button").click()');
  const admitted = await until(async () => {
    const jobs = await guest('window.codeshellPanel.call("tasks.list", {})');
    const downloads = jobs.filter((job) => job.entry.name === "download-runtime");
    return downloads.length === 2 &&
      downloads.some((job) => job.status === "running") &&
      downloads.some((job) => job.status === "queued")
      ? downloads
      : false;
  }, "UI did not admit a running background download");
  await win.evaluate(() => document.getElementById("download-background").remove());
  guest = await open();
  await until(
    async () => {
      const tasks = await guest('window.codeshellPanel.call("tasks.list", {})');
      const downloads = tasks.filter((task) => task.entry.name === "download-runtime");
      for (const task of downloads)
        if (task.status === "failed")
          throw new Error(
            JSON.stringify({
              error: task.error,
              authorizedRequests,
              deniedRequests,
              diagnostic: await readFile(diagnostic, "utf8").catch(() => "wrapper not invoked"),
            }),
          );
      return downloads.length === 2 && downloads.every((task) => task.status === "succeeded");
    },
    "Background queue did not finish after closing its original page",
    180000,
  );
  for (const job of admitted) {
    const completed = await guest(
      `window.codeshellPanel.call("tasks.get", {id:${JSON.stringify(job.id)}})`,
    );
    if (authenticated) {
      assert.equal(completed.input.cookieArgument.credentialId, "download-fixture");
      assert.equal(completed.input.request.useSavedLogin, true);
      assert.doesNotMatch(JSON.stringify(completed), /download-cookie-fixture/);
    }
    const artifact = completed.result.artifacts[0];
    assert.deepEqual(await readFile(join(project, artifact.published.path)), bytes);
  }
  await until(
    () => guest("document.querySelectorAll('.queue-item[data-state=\"completed\"]').length === 2"),
    "Reopened UI did not recover the completed task",
    30000,
  );
  assert.equal(
    (await guest('window.codeshellPanel.call("tasks.list", {})')).filter(
      (task) => task.entry.name === "download-runtime",
    ).length,
    2,
  );
  if (authenticated) {
    assert.ok(authorizedRequests >= 2);
    assert.equal(deniedRequests, 0);
    const prompts = await electron.evaluate(() => globalThis.__downloadCookiePrompts);
    assert.equal(prompts.length, 3);
    assert.ok(
      prompts.every((prompt) => JSON.stringify(prompt).includes("Download fixture account")),
    );
    assert.equal(
      (await readdir(join(isolated.userDataDir, "panel-task-cookies"))).filter((name) =>
        name.startsWith("cookies-"),
      ).length,
      0,
    );
    console.log(
      "Authenticated fixture passed: real HTTPS requests required saved Cookie; metadata and both tasks confirmed; no anonymous fallback; private files cleaned.",
    );
  }
  console.log(
    "Actual Download UI passed: native submission, page removal, remount recovery, two stable queued tasks and exact output bytes.",
  );
} finally {
  await electron?.close();
  if (server) await new Promise((done) => server.close(done));
  await isolated.cleanup();
}
