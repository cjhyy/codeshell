/**
 * Repeatable real-Electron browser timing probe. Set BROWSER_PROBE_URL, then
 * bundle with esbuild (external: electron, ESM createRequire banner) and run
 * the bundle with Electron. Uses a fresh temporary profile, never user cookies.
 * BROWSER_PROBE_ROUNDS: 1–10 (default 3), BROWSER_PROBE_SETTLE_MS: 0–60000.
 * Only timings/counts/errors are logged, not page contents or credentials.
 */
import { app, BrowserWindow } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getElectronBrowser,
  releaseElectronBrowser,
} from "../src/main/browser-driver/electron-puppeteer.js";

const url = process.env.BROWSER_PROBE_URL;
if (!url || !/^https?:\/\//.test(url)) throw new Error("Set BROWSER_PROBE_URL to an HTTP(S) page");
const rounds = Math.max(1, Math.min(10, Number(process.env.BROWSER_PROBE_ROUNDS) || 3));
const settleMs = Math.max(0, Math.min(60_000, Number(process.env.BROWSER_PROBE_SETTLE_MS) || 0));
app.setPath("userData", mkdtempSync(join(tmpdir(), "codeshell-browser-probe-")));
app.on("window-all-closed", () => undefined);
const started = performance.now();
const log = (value: object) => console.log(JSON.stringify(value));

async function timed(label: string, operation: () => Promise<unknown>) {
  const start = performance.now();
  try {
    const value = await operation();
    log({ label, ms: Math.round(performance.now() - start), value });
  } catch (error) {
    log({ label, ms: Math.round(performance.now() - start), error: String(error) });
  }
}

async function main(pageUrl: string) {
  await app.whenReady();
  log({ label: "electron-ready", ms: Math.round(performance.now() - started) });
  try {
    for (let round = 1; round <= rounds; round++) {
      const start = performance.now();
      const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 720,
        webPreferences: {
          partition: "probe",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      // The outer guard closes this probe target if a regression hangs a queue.
      const deadline = setTimeout(() => {
        log({ round, error: "probe exceeded its overall deadline" });
        app.exit(1);
      }, 120_000 + settleMs);
      try {
        await win.loadURL("about:blank");
        const driver = await getElectronBrowser(win.webContents);
        log({ round, label: "new-window-connect", ms: Math.round(performance.now() - start) });
        await timed(`${round}:navigate`, () => driver.navigate(pageUrl));
        await timed(`${round}:wait`, () => driver.waitForLoad(10_000));
        if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
        log({ round, settleMs, frames: driver.page.frames().length });
        await timed(`${round}:snapshot`, async () => {
          const result = await driver.snapshot();
          return {
            elements: result.elements.length,
            warnings: result.warnings,
            detail: result.detail,
          };
        });
        await timed(`${round}:read`, async () => {
          const result = await driver.readContent();
          return {
            ok: result.ok,
            chars: result.text.length,
            warnings: result.warnings,
            detail: result.detail,
          };
        });
      } finally {
        clearTimeout(deadline);
        releaseElectronBrowser(win.webContents);
        win.destroy();
      }
    }
  } finally {
    app.quit();
  }
}

// Do not await app.whenReady() at ESM top level: Electron waits for module
// evaluation to finish before emitting ready.
void main(url).catch((error) => {
  console.error(error);
  app.exit(1);
});
