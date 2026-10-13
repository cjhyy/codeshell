/*
 * Real compiled Desktop/IPC composer SVG acceptance. The reviewed native
 * installer prepares both entries first; this smoke never fabricates a registry.
 * Run only after the separate runtime plan, driver guard and pack pins are reviewed.
 */
/* global window, document, localStorage, Image */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [planPath, planHash] = process.argv.slice(2);
assert.equal(process.argv.length, 4, "Expected <reviewed-runtime-plan.json> <sha256>");
assert.ok(isAbsolute(planPath) && /^[a-f0-9]{64}$/u.test(planHash));
const driver = globalThis[Symbol.for("codeshell.docker-candidate.pre-core")];
assert.equal(driver?.role, "driver", "Original driver guard must precede the smoke");
assert.equal(driver?.negativeProbes, 6);
assert.equal(driver?.dnsNegativeProbes, 4);
const planStat = await lstat(planPath);
assert.ok(planStat.isFile() && !planStat.isSymbolicLink() && planStat.size <= 65536);
assert.equal(planStat.nlink, 1);
const planBytes = await readFile(planPath);
assert.ok(planBytes.length <= 65536);
assert.equal(hash(planBytes), planHash);
const plan = JSON.parse(planBytes);
assert.equal(plan.version, 1);
assert.equal(plan.kind, "compiled-plugin-composer-svg");
assert.equal(plan.home, await realpath(plan.home));
assert.equal(process.env.HOME, plan.home);
assert.equal(process.env.CODE_SHELL_HOME, join(plan.home, ".code-shell"));
assert.equal(plan.appDir, appDir);
const homeStat = await lstat(plan.home);
assert.ok(homeStat.isDirectory() && !homeStat.isSymbolicLink());
if (process.getuid) assert.equal(homeStat.uid, process.getuid());
if (process.platform !== "win32") assert.equal(homeStat.mode & 0o077, 0);
assert.equal(plan.platform, process.platform);

function readPrivatePinnedFile(pin, limit) {
  assert.ok(isAbsolute(pin.path) && /^[a-f0-9]{64}$/u.test(pin.sha256));
  assert.equal(realpathSync(pin.path), pin.path);
  const before = lstatSync(pin.path);
  const descriptor = openSync(pin.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    assert.ok(info.isFile() && !before.isSymbolicLink() && info.size <= limit);
    assert.equal(info.nlink, 1);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.dev, before.dev);
    assert.equal(info.ino, before.ino);
    assert.equal(info.dev, pin.dev);
    assert.equal(info.ino, pin.ino);
    const bytes = readFileSync(descriptor);
    assert.ok(bytes.length <= limit);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(hash(bytes), pin.sha256);
    const after = fstatSync(descriptor);
    assert.equal(after.size, info.size);
    assert.equal(after.mtimeMs, info.mtimeMs);
    assert.equal(after.ctimeMs, info.ctimeMs);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

// The external, Core-free preparation ran the real native metadata preflight.
// Under the original driver guard this callback verifies its exact custody;
// it never fabricates a query result or calls the native preflight with a stub.
function verifyPreparedKeychainContext({ home, environment }) {
  assert.equal(home, plan.home);
  assert.equal(environment.HOME, plan.home);
  assert.equal(environment.USERPROFILE, plan.home);
  assert.equal(environment.CODE_SHELL_HOME, join(plan.home, ".code-shell"));
  if (process.platform !== "darwin") {
    assert.equal(plan.keychainPreparation, null);
    return null;
  }
  const prepared = JSON.parse(readPrivatePinnedFile(plan.keychainPreparation, 65536));
  assert.equal(prepared.kind, "real-electron-keychain-metadata-preparation");
  assert.equal(prepared.home, plan.home);
  assert.equal(prepared.appDir, appDir);
  assert.equal(prepared.scope, "metadata-only; not safeStorage acceptance");
  assert.equal(prepared.files.length, 3);
  assert.deepEqual(
    prepared.files.map((pin) => pin.path).sort(),
    [
      join(home, "electron-keychain-reference.json"),
      join(home, "electron-keychain-context.json"),
      join(home, "Library/Preferences/com.apple.security.plist"),
    ].sort(),
  );
  for (const directory of [home, join(home, "Library"), join(home, "Library/Preferences")]) {
    const info = lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(realpathSync(directory), directory);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o700);
  }
  for (const pin of prepared.files) readPrivatePinnedFile(pin, 4096);
  const reference = JSON.parse(
    readPrivatePinnedFile(
      prepared.files.find((pin) => pin.path === join(home, "electron-keychain-reference.json")),
      4096,
    ),
  );
  assert.equal(reference.version, 1);
  assert.equal(reference.home, prepared.operatorHome);
  assert.equal(reference.path, prepared.defaultKeychain.path);
  assert.equal(reference.pathHash, hash(reference.path));
  const info = lstatSync(reference.path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  for (const key of ["dev", "ino", "uid"]) {
    assert.equal(info[key], prepared.defaultKeychain[key]);
    assert.equal(info[key], reference[key]);
  }
  return { home, preparedMetadataVerified: true };
}
assert.ok(
  Array.isArray(plan.sourcePins) && plan.sourcePins.length >= 3 && plan.sourcePins.length <= 64,
);
for (const pin of plan.sourcePins) {
  assert.ok(isAbsolute(pin.path) && /^[a-f0-9]{64}$/u.test(pin.sha256));
  assert.equal(hash(await readFile(pin.path)), pin.sha256, "Source/build/runtime pin changed");
}
assert.equal(plan.entries.length, 2);
assert.deepEqual(plan.entries.map((entry) => entry.kind).sort(), ["genuine", "svg-only-fixture"]);
for (const entry of plan.entries) {
  assert.ok(typeof entry.installKey === "string" && entry.installKey.length <= 512);
  assert.ok(typeof entry.displayName === "string" && entry.displayName.length <= 120);
  assert.ok(/^[a-f0-9]{64}$/u.test(entry.svgSha256));
  assert.equal(entry.svgBytes, 1733);
  assert.equal(entry.svgSha256, "54a632d9ee6197ccbc10d43d42217e23d08375bea63ba8eb4b6af757c1535038");
}
const evidenceDir = await realpath(plan.evidenceDir);
assert.ok(isAbsolute(evidenceDir));
const userDataDir = join(plan.home, "electron-user-data");
const phases = [];

function mainGuardSource(receipt) {
  return `// Test-only synchronous bootstrap; no product imports before guards/probes.
const assert = require("node:assert/strict");
const { app, net: electronNet } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const cp = require("node:child_process");
const http = require("node:http"), https = require("node:https");
const http2 = require("node:http2"), net = require("node:net"), tls = require("node:tls");
const dns = require("node:dns"), dgram = require("node:dgram");
const workers = require("node:worker_threads");
const { syncBuiltinESMExports } = require("node:module");
const home = ${JSON.stringify(plan.home)};
assert.equal(process.env.HOME, home);
assert.equal(fs.realpathSync(home), home);
const counts = { networkAttempts: 0, processAttempts: 0, rendererNetworkAttempts: 0 };
function networkDenied() { counts.networkAttempts++; throw new Error("Composer SVG fixture denied network"); }
function processDenied() { counts.processAttempts++; throw new Error("Composer SVG fixture denied process"); }
globalThis.fetch = networkDenied;
globalThis.WebSocket = networkDenied;
for (const mod of [http, https]) for (const key of ["request", "get"]) mod[key] = networkDenied;
http2.connect = networkDenied;
net.connect = networkDenied; net.createConnection = networkDenied;
net.Socket.prototype.connect = networkDenied; net.Server.prototype.listen = networkDenied;
tls.connect = networkDenied; dgram.createSocket = networkDenied;
for (const target of [dns, dns.promises]) for (const key of Object.keys(target))
  if (typeof target[key] === "function") target[key] = networkDenied;
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[key] = processDenied;
workers.Worker = processDenied;
electronNet.request = networkDenied; electronNet.fetch = networkDenied;
syncBuiltinESMExports();
for (const probe of [() => fetch("https://external.invalid/"), () => http.get("http://127.0.0.1:1"),
  () => net.connect(2, "127.0.0.1"), () => tls.connect({host:"127.0.0.1",port:3}),
  () => dgram.createSocket("udp4"), () => cp.spawn("sh", ["-c", "exit 0"])])
  assert.throws(probe, /Composer SVG fixture denied/);
for (const probe of [() => dns.resolveTxt("external.invalid"), () => dns.promises.resolveAny("external.invalid"),
  () => new dns.Resolver(), () => new dns.promises.Resolver()]) assert.throws(probe, /Composer SVG fixture denied/);
counts.networkAttempts = 0; counts.processAttempts = 0;
const sessions = new Set();
app.on("web-contents-created", (_event, contents) => {
  if (sessions.has(contents.session)) return;
  sessions.add(contents.session);
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    let ownedFile = false;
    if (url.protocol === "file:") {
      try {
        const rel = path.relative(${JSON.stringify(join(appDir, "out/renderer"))}, fs.realpathSync(fileURLToPath(url)));
        ownedFile = rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
      } catch {}
    }
    const imageData = url.protocol === "data:" && ["png", "jpeg", "webp", "svg+xml"].some(type => details.url.startsWith("data:image/" + type + ";base64,"));
    const permit = ownedFile || imageData || details.url === "about:blank";
    if (!permit) counts.rendererNetworkAttempts++;
    callback({cancel:!permit});
  });
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
});
const record = Object.freeze({negativeProbes:6,dnsNegativeProbes:4,snapshot:()=>({...counts})});
Object.defineProperty(globalThis, Symbol.for("codeshell.composer-svg.electron-pre-core"), {value:record});
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid,ppid:process.ppid,negativeProbes:6,dnsNegativeProbes:4,home,network:"deny-all",children:0})+"\\n",{mode:0o600,flag:"wx"});
`;
}

async function imageReport(win, alt) {
  const image = win.getByRole("img", { name: alt, exact: true }).filter({ visible: true }).first();
  await image.waitFor({ state: "visible" });
  return image.evaluate(async (element) => {
    await element.decode();
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      src: element.currentSrc,
      width: element.naturalWidth,
      height: element.naturalHeight,
      visibleWidth: box.width,
      visibleHeight: box.height,
    };
  });
}

function imageEvidence({ src, ...geometry }) {
  return { ...geometry, sourceSha256: hash(src), mediaType: src.slice(0, src.indexOf(";")) };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  for (let phase = 0; phase < 2; phase++) {
    const bootstrap = join(plan.home, `composer-svg-main-${phase}.cjs`);
    const receipt = join(evidenceDir, `main-pre-core-${phase}.json`);
    const source = mainGuardSource(receipt);
    await writeFile(bootstrap, source, { mode: 0o600, flag: "wx" });
    let app;
    let electronProcess;
    let mainClose;
    let primary;
    const cleanupErrors = [];
    const pids = new Set();
    const phaseReport = { phase, bootstrapSha256: hash(source), entries: [] };
    const observeMainProcess = (application) => {
      if (electronProcess) return;
      electronProcess = application.process();
      assert.ok(Number.isSafeInteger(electronProcess.pid) && electronProcess.pid > 0);
      pids.add(electronProcess.pid);
      mainClose = new Promise((resolve) =>
        electronProcess.once("close", (code, signal) => resolve({ code, signal })),
      );
    };
    const observeMetrics = async (stage) => {
      if (!app) return;
      const metrics = await bounded(
        app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type }) => ({ pid, type }))),
        "Owned Electron process metrics",
      );
      for (const value of metrics) pids.add(value.pid);
      (phaseReport.processObservations ??= []).push({ stage, metrics });
    };
    try {
      app = await launchCodeShellElectron(
        { appDir, home: plan.home, userDataDir, mainBootstrap: bootstrap },
        {
          preflight: verifyPreparedKeychainContext,
          launch: async (options) => {
            // Preserve ownership before the harness watchdog can reject.
            app = await (await import("playwright"))._electron.launch(options);
            observeMainProcess(app);
            return app;
          },
        },
      );
      observeMainProcess(app);
      await observeMetrics("immediately-after-launch");
      const win = await findCodeShellWindow(app);
      const errors = captureRendererErrors(win);
      await win.setViewportSize({ width: 1440, height: 960 });
      await win.evaluate(() => {
        window.__composerSvgSentinel = 0;
        localStorage.setItem("codeshell.uiLanguage", "en");
        window.dispatchEvent(new window.Event("codeshell:language-changed"));
      });
      await navigateSettingsMenu(win, /Open settings/i);
      await win
        .getByRole("navigation", { name: "Settings navigation" })
        .getByRole("button", { name: "Appearance", exact: true })
        .click();
      await win.getByRole("button", { name: /^Light/ }).click();
      await win.waitForFunction(() => !document.documentElement.classList.contains("dark"));
      await win
        .getByRole("navigation", { name: "Settings navigation" })
        .getByRole("button", { name: "Extensions", exact: true })
        .click();
      await win
        .getByRole("navigation", { name: "Extension categories" })
        .getByRole("button", { name: "Packages", exact: true })
        .click();
      for (const entry of plan.entries) {
        const media = await win.evaluate(
          (key) => window.codeshell.getPluginMedia(key),
          entry.installKey,
        );
        assert.ok(media?.composerIconDataUrl?.startsWith("data:image/svg+xml;base64,"));
        const bytes = Buffer.from(media.composerIconDataUrl.split(",")[1], "base64");
        assert.equal(bytes.length, entry.svgBytes);
        assert.equal(hash(bytes), entry.svgSha256);
        // Decode the genuine DTO in Chromium, even when the declared PNG logo wins UI priority.
        const decoded = await win.evaluate(async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 256;
          canvas.height = 256;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, 256, 256);
          const pixels = context.getImageData(0, 0, 256, 256).data;
          let paintedPixels = 0;
          for (let offset = 3; offset < pixels.length; offset += 4)
            if (pixels[offset]) paintedPixels++;
          return { width: image.naturalWidth, height: image.naturalHeight, paintedPixels };
        }, media.composerIconDataUrl);
        assert.ok(
          decoded.width > 0 &&
            decoded.height > 0 &&
            decoded.width <= 8192 &&
            decoded.height <= 8192 &&
            decoded.width * decoded.height <= 40_000_000,
        );
        assert.ok(
          decoded.paintedPixels > 100 && decoded.paintedPixels < 256 * 256,
          "Chromium must render the original SVG geometry",
        );
        const listImage = await imageReport(win, entry.displayName);
        assert.equal(listImage.tag, "IMG");
        assert.equal(
          listImage.src,
          entry.kind === "genuine" ? media.logoDataUrl : media.composerIconDataUrl,
        );
        await win
          .getByRole("button")
          .filter({ has: win.getByText(entry.displayName, { exact: true }) })
          .first()
          .click();
        const detailImage = await imageReport(win, entry.displayName);
        assert.equal(detailImage.src, listImage.src);
        assert.ok(
          detailImage.width > 0 &&
            detailImage.height > 0 &&
            detailImage.visibleWidth > 0 &&
            detailImage.visibleHeight > 0,
        );
        await win.screenshot({
          path: join(evidenceDir, `phase-${phase}-${entry.kind}.png`),
          animations: "disabled",
          scale: "css",
        });
        phaseReport.entries.push({
          kind: entry.kind,
          installKey: entry.installKey,
          svgSha256: hash(bytes),
          svgBytes: bytes.length,
          decoded,
          listImage: imageEvidence(listImage),
          detailImage: imageEvidence(detailImage),
        });
        await win.getByRole("button", { name: /Back/i }).first().click();
      }
      assert.equal(await win.evaluate(() => window.__composerSvgSentinel), 0);
      assert.deepEqual(errors, [], "Plugin media must not raise renderer page errors");
      const guard = await app.evaluate(() => {
        const guard = globalThis[Symbol.for("codeshell.composer-svg.electron-pre-core")];
        return {
          negativeProbes: guard?.negativeProbes,
          dnsNegativeProbes: guard?.dnsNegativeProbes,
          counts: guard?.snapshot(),
        };
      });
      assert.equal(guard.negativeProbes, 6);
      assert.equal(guard.dnsNegativeProbes, 4);
      assert.deepEqual(guard.counts, {
        networkAttempts: 0,
        processAttempts: 0,
        rendererNetworkAttempts: 0,
      });
      await observeMetrics("after-assertions");
      phaseReport.guard = guard;
    } catch (error) {
      primary = error;
      phaseReport.primary = { name: error.name, message: String(error.message).slice(0, 1000) };
    } finally {
      if (app) {
        try {
          observeMainProcess(app);
          await observeMetrics("before-close-in-finally");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await bounded(app?.close(), "Owned Electron close");
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (mainClose) {
        try {
          phaseReport.mainClose = await bounded(mainClose, "Owned Electron terminal event");
          assert.equal(phaseReport.mainClose.code, 0);
          assert.equal(phaseReport.mainClose.signal, null);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      for (const pid of pids) {
        try {
          let alive = true;
          for (let count = 0; count < 20 && alive; count++) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if (error.code === "ESRCH") alive = false;
              else {
                cleanupErrors.push(error);
                break;
              }
            }
            if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(alive, false, "Owned Electron child remains after close");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      phaseReport.cleanupErrors = cleanupErrors.map((error) => ({
        name: error.name,
        message: String(error.message).slice(0, 1000),
      }));
      phaseReport.observedPids = [...pids].sort((a, b) => a - b);
      phases.push(phaseReport);
      try {
        await writeFile(join(evidenceDir, "phases.json"), JSON.stringify(phases, null, 2) + "\n", {
          mode: 0o600,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primary) throw primary;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Owned Electron cleanup failed");
  }
  console.log(
    JSON.stringify({
      fixture: "compiled-plugin-composer-svg",
      passed: true,
      phases: phases.length,
      planSha256: planHash,
    }),
  );
} finally {
  // Preserve the owned HOME, installation and receipts for independent review.
  assert.ok(!relative(plan.home, userDataDir).startsWith(".."));
}
