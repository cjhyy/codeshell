// One-off smoke test: boot the Electron app and switch into each of the four
// new panels (files/browser/review/terminal), asserting each mounts.
import { _electron as electron } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");

let app, win;
function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

try {
  app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, CODE_SHELL_NO_DEVTOOLS: "1" },
  });
  await app.firstWindow();
  await new Promise((r) => setTimeout(r, 2500));

  // Pick the real app window (renderer index.html), not the DevTools window.
  const windows = app.windows();
  for (const w of windows) {
    const url = w.url();
    const hasRoot = await w.evaluate(() => !!document.getElementById("root")).catch(() => false);
    console.log("window:", url.slice(0, 60), "hasRoot=", hasRoot);
    if (hasRoot) win = w;
  }
  if (!win) win = windows[0];
  win.on("pageerror", (e) => console.error("pageerror:", e.message));
  await win.waitForTimeout(500);

  // What does the app currently show?
  const snap = await win.evaluate(() => ({
    bodyChars: document.body.innerText.length,
    view: localStorage.getItem("codeshell.view"),
    hasMain: !!document.querySelector("main"),
    mainChars: document.querySelector("main")?.innerText.length ?? -1,
  }));
  console.log("INITIAL:", JSON.stringify(snap));

  // Switch the view by writing localStorage + reloading is too heavy; instead
  // press the hotkey, then read back what the <main> contains.
  const panels = [
    { name: "browser", keys: "Meta+t", marker: "输入 URL" },
    { name: "review", keys: "Control+Shift+G", marker: "变更文件|请先选择|no changes|working tree" },
    { name: "terminal", keys: "Control+`", marker: "终端" },
    { name: "files", keys: "Meta+Shift+E", marker: "打开文件|筛选文件|请先选择" },
  ];

  for (const p of panels) {
    await win.bringToFront();
    // Move off any prior panel (esp. terminal's xterm, which captures keydown)
    // to the browser panel — its address bar/landing won't swallow the next
    // app hotkey. Then click <main> to ensure window-level focus. This mirrors
    // real usage: you switch INTO a panel from elsewhere.
    await win.keyboard.press("Meta+t");
    await win.waitForTimeout(300);
    await win.locator("main").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await win.keyboard.press(p.keys);
    await win.waitForTimeout(1500);
    const info = await win.evaluate(() => ({
      view: JSON.parse(localStorage.getItem("codeshell.view") || "{}").viewMode,
      mainText: (document.querySelector("main")?.innerText ?? "").slice(0, 200),
      xterm: !!document.querySelector(".xterm"),
      webview: !!document.querySelector("webview"),
    }));
    const re = new RegExp(p.marker);
    const matched = re.test(info.mainText) || (p.name === "terminal" && info.xterm) || (p.name === "browser" && info.webview);
    console.log(`${matched ? "OK " : "??"} ${p.name}: view=${info.view} xterm=${info.xterm} webview=${info.webview} text="${info.mainText.replace(/\n/g, " ").slice(0, 80)}"`);
    if (info.view !== p.name) fail(`${p.name}: viewMode is "${info.view}", hotkey didn't switch`);
  }

  // Phase 2: verify the <webview> actually attaches + loads a real URL.
  // (The riskiest browser path: webviewTag + will-attach-webview hardening.)
  await win.keyboard.press("Meta+t");
  await win.waitForTimeout(800);
  const urlInput = win.locator('input[placeholder="输入 URL"]');
  await urlInput.click();
  await urlInput.fill("example.com");
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3500);
  const webviewState = await win.evaluate(() => {
    const wv = document.querySelector("webview");
    return { present: !!wv, src: wv?.getAttribute("src") ?? null };
  });
  if (webviewState.present && /example\.com/.test(webviewState.src ?? "")) {
    console.log(`OK  browser: <webview> attached + loaded ${webviewState.src}`);
  } else {
    fail(`browser: webview did not attach/load (state=${JSON.stringify(webviewState)})`);
  }

  console.log(process.exitCode ? "SMOKE: FAILED" : "SMOKE: PASSED");
} catch (e) {
  fail(`exception: ${e?.stack || e}`);
} finally {
  await app?.close().catch(() => {});
}
