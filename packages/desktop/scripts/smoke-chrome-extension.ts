import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { ChromeExtensionBackend } from "../src/main/browser-runtime/chrome-extension-runtime.js";
import { ChromeNativeBridgeServer } from "../src/main/browser-runtime/chrome-native-server.js";
import {
  CHROME_NATIVE_HOST_NAME,
  CODESHELL_CHROME_EXTENSION_ID,
  CODESHELL_CHROME_EXTENSION_ORIGIN,
} from "../src/main/browser-runtime/chrome-native-protocol.js";
import { buildChromeExtension } from "./build-chrome-extension.js";

// All browser profiles, host registrations and pages in this smoke are temporary.
// Chrome resolves user NativeMessagingHosts relative to --user-data-dir.
const temporary = await mkdtemp(path.join(tmpdir(), "codeshell-extension-smoke-"));
const profile = path.join(temporary, "profile");
const desktop = path.resolve(import.meta.dir, "..");
const extension = path.join(desktop, "resources/chrome-extension");
const statePath = path.join(temporary, "native-state.json");
let context: BrowserContext | undefined;
const commands: string[] = [];
const visitedPaths: string[] = [];
let onSlowRequest = () => {};
const server = new ChromeNativeBridgeServer({
  statePath,
  onMessage: (message) => backend.handleExtensionMessage(message),
});
const backend = new ChromeExtensionBackend({
  server: {
    start: () => server.start(),
    stop: () => server.stop(),
    status: () => server.status(),
    request: (type, payload) => {
      commands.push(type);
      return server.request(type, payload);
    },
  },
  policy: () => ({ allowedDomains: ["127.0.0.1", "localhost"] }),
});
const website = createServer((request, response) => {
  visitedPaths.push(request.url ?? "");
  if (request.url === "/slow") {
    onSlowRequest();
    setTimeout(() => {
      if (!response.destroyed) response.end("Slow navigation finished");
    }, 3_000);
    return;
  }
  const isFrame = request.url === "/frame";
  const label = isFrame
    ? "Frame increment"
    : request.url === "/b"
      ? "Second increment"
      : "First increment";
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>${label}</title><style>body{margin:20px}button,input{padding:12px}iframe{width:500px;height:300px}</style>
    <button id="increment" onclick="window.count=(window.count||0)+1">${label}</button>
    <input aria-label="Name"><div id="output"></div>
    ${!isFrame ? `<iframe src="http://localhost:${websitePort}/frame"></iframe>` : ""}`);
});
let websitePort = 0;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitUntil(check: () => Promise<boolean> | boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${detail}`);
}

try {
  await buildChromeExtension();
  await mkdir(path.join(profile, "NativeMessagingHosts"), { recursive: true });
  const nativeEntry = path.join(temporary, "native-host.mjs");
  const source = path.join(desktop, "src/main/browser-runtime/chrome-native-protocol.ts");
  await build({
    stdin: {
      contents: `import {runChromeNativeMessagingHost} from ${JSON.stringify(source)}; await runChromeNativeMessagingHost(process.argv[2], ${JSON.stringify(statePath)}); process.exit(0);`,
      resolveDir: desktop,
    },
    outfile: nativeEntry,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const launcher = path.join(temporary, "native-host");
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(nativeEntry)} "$@"\n`,
  );
  await chmod(launcher, 0o700);
  await writeFile(
    path.join(profile, "NativeMessagingHosts", `${CHROME_NATIVE_HOST_NAME}.json`),
    JSON.stringify({
      name: CHROME_NATIVE_HOST_NAME,
      description: "CodeShell isolated extension smoke",
      path: launcher,
      type: "stdio",
      allowed_origins: [CODESHELL_CHROME_EXTENSION_ORIGIN],
    }),
  );
  await server.start();
  await new Promise<void>((resolve) => website.listen(0, "0.0.0.0", resolve));
  websitePort = (website.address() as { port: number }).port;
  const executablePath = process.env.CODESHELL_TEST_CHROMIUM || chromium.executablePath();
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--site-per-process",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  assert.equal(new URL(worker.url()).hostname, CODESHELL_CHROME_EXTENSION_ID);
  const popup = await context.newPage();
  await popup.goto(`${CODESHELL_CHROME_EXTENSION_ORIGIN}popup.html`);
  await waitUntil(
    () => server.status().connected,
    "production extension native messaging connection",
  );
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto(`http://127.0.0.1:${websitePort}/a`);
  await second.goto(`http://127.0.0.1:${websitePort}/b`);

  async function pair(sessionId: string, page: Page) {
    const pairing = backend.beginPairing(sessionId);
    const tabId = await worker.evaluate(async (url) => {
      const api = (globalThis as any).chrome;
      const tabs = await api.tabs.query({});
      const tab = tabs.find((candidate: any) => candidate.url === url);
      await api.tabs.update(tab.id, { active: true });
      return tab.id as number;
    }, page.url());
    const result = await popup.evaluate(
      async (code) =>
        (globalThis as any).chrome.runtime.sendMessage({ type: "pairing.grant", code }),
      pairing.pairing!.code,
    );
    assert.equal(result.error, undefined, `pairing failed: ${result.error}`);
    assert.equal(result.granted.tabId, tabId);
    return result.granted as { tabId: number; grantId: string };
  }
  const grantA = await pair("extension-a", first);
  const grantB = await pair("extension-b", second);
  const action = async (sessionId: string, request: any) =>
    JSON.parse((await backend.dispatch(sessionId, request))!);
  const snapshot = await action("extension-a", { action: "snapshot" });
  const firstRef = snapshot.elements.find(
    (element: any) => element.name === "First increment",
  )?.ref;
  const frameRef = snapshot.elements.find(
    (element: any) => element.name === "Frame increment",
  )?.ref;
  assert.ok(firstRef && frameRef, "main page and cross-origin iframe refs are present");
  assert.equal((await action("extension-a", { action: "click", ref: firstRef })).ok, true);
  assert.equal(await first.evaluate(() => (window as any).count), 1);
  assert.equal(await second.evaluate(() => (window as any).count ?? 0), 0);
  assert.equal((await action("extension-a", { action: "click", ref: frameRef })).ok, true);
  assert.equal(await first.frames()[1].evaluate(() => (window as any).count), 1);
  const screenshot = await action("extension-a", { action: "screenshot" });
  assert.equal(screenshot.ok, true);
  assert.ok(Buffer.from(screenshot.base64, "base64").length > 100);
  assert.equal((await action("extension-b", { action: "click", ref: firstRef })).ok, false);
  await assert.rejects(
    server.request("browser.action", {
      tabId: grantB.tabId,
      grantId: grantA.grantId,
      request: { action: "click", ref: firstRef },
    }),
    /not granted/,
  );
  assert.equal((await action("extension-a", { action: "requestTakeover" })).ok, true);
  assert.equal(
    (await action("extension-a", { action: "navigate", url: first.url() })).code,
    "NEEDS_HUMAN",
  );
  assert.equal((await action("extension-a", { action: "resumeControl" })).ok, true);
  assert.equal((await action("extension-a", { action: "click", ref: firstRef })).ok, false);
  const refreshed = await action("extension-a", { action: "snapshot" });
  assert.ok(refreshed.elements.some((element: any) => element.name === "First increment"));
  assert.equal(
    (await action("extension-a", { action: "inspect", inspect: { mode: "dom", maxEntries: 10 } }))
      .ok,
    true,
  );

  const slowStarted = new Promise<void>((resolve) => {
    onSlowRequest = resolve;
  });
  const running = action("extension-a", {
    action: "navigate",
    url: `http://127.0.0.1:${websitePort}/slow`,
  });
  await slowStarted;
  const queued = action("extension-a", {
    action: "navigate",
    url: `http://127.0.0.1:${websitePort}/must-not-run`,
  });
  backend.revoke("extension-a");
  assert.equal((await running).ok, false);
  assert.equal((await queued).code, "NEEDS_HUMAN");
  assert.equal(visitedPaths.includes("/must-not-run"), false);
  await waitUntil(async () => {
    return worker.evaluate(async (tabId) => {
      try {
        await (globalThis as any).chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "1",
        });
        return false;
      } catch {
        return true;
      }
    }, grantA.tabId);
  }, "revoked first tab detaches");
  assert.equal(backend.status("extension-b").granted?.tabId, grantB.tabId);
  assert.equal(
    (await action("extension-b", { action: "snapshot" })).elements.some(
      (element: any) => element.name === "Second increment",
    ),
    true,
  );
  await worker.evaluate(
    (tabId) => (globalThis as any).chrome.debugger.detach({ tabId }),
    grantB.tabId,
  );
  // chrome.debugger.detach() called by the owning extension does not emit its
  // onDetach event. Verify a normal action still cannot silently reattach.
  await action("extension-b", { action: "snapshot" });
  assert.equal(
    await worker.evaluate(async (tabId) => {
      try {
        await (globalThis as any).chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "1",
        });
        return true;
      } catch {
        return false;
      }
    }, grantB.tabId),
    false,
  );
  await second.close();
  await waitUntil(() => !backend.status("extension-b").granted, "closed tab revokes desktop grant");
  assert.equal((await action("extension-b", { action: "snapshot" })).code, "NEEDS_HUMAN");
  const replacement = await context.newPage();
  await replacement.goto(`http://127.0.0.1:${websitePort}/b`);
  const replacementGrant = await pair("extension-b", replacement);
  await server.stop();
  await waitUntil(async () => {
    return worker.evaluate(async (tabId) => {
      try {
        await (globalThis as any).chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "1",
        });
        return false;
      } catch {
        return true;
      }
    }, replacementGrant.tabId);
  }, "native channel disconnect detaches browser control");
  assert.equal(commands.includes("cdp.command"), false);
  assert.ok(commands.includes("browser.action"));
  const bundle = await readFile(path.join(extension, "service-worker.js"), "utf8");
  assert.equal(bundle.includes('"cdp.command"'), false);
  console.log(
    "Chrome extension smoke passed: production native messaging, official Puppeteer transport, two-tab and iframe isolation, grant mismatch, screenshot, handover/resume, stale refs, inspect, revoke, no implicit reattach, tab closure, native disconnect.",
  );
} finally {
  await context?.close();
  await backend.stop();
  await new Promise<void>((resolve) => website.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
}
