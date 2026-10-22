/* Real computed colors, geometry and observer lifecycle for native caption sync. */
/* global window */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const source = String.raw`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {useWindowTitleBar} from './app/useWindowTitleBar';
  window.requests=[];
  window.logs=[];
  window.codeshell={
    platform:'win32',
    hasWindowTitleBarOverlay:true,
    getWindowZoomFactor:()=>window.fixtureZoom??1,
    setWindowTitleBarOverlay:async style=>{
      window.requests.push(style);
      if(window.rejectNext){window.rejectNext=false;throw new Error('fixture failure')}
    },
    log:(message,data)=>window.logs.push({message,data}),
  };
  function Header({name}) {
    const ref=React.useRef(null);
    useWindowTitleBar(ref);
    return <header ref={ref} data-header={name}>{name}</header>;
  }
  function Fixture({mounted=true}) {
    return mounted&&<React.StrictMode>
      <section id="chat"><Header name="chat"/></section>
      <section id="settings"><Header name="settings"/></section>
    </React.StrictMode>;
  }
  const root=createRoot(window.document.getElementById('root'));
  window.renderFixture=props=>root.render(<Fixture {...props}/>);
  window.flushFrames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
`;
const bundle = await build({
  stdin: {
    contents: source,
    resolveDir: path.join(desktop, "src/renderer"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"development"' },
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CODESHELL_TEST_CHROMIUM || undefined,
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(5000);
const latest = () => page.evaluate(() => window.requests.at(-1));
const flush = () => page.evaluate(() => window.flushFrames());
const waitForStyle = async (symbolColor, height) => {
  await page.waitForFunction(
    ({ symbolColor, height }) => {
      const latest = window.requests.at(-1);
      return latest?.symbolColor === symbolColor && latest.height === height;
    },
    { symbolColor, height },
  );
};
try {
  await page.route("https://titlebar.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>
        html,body { margin:0 }
        :root { --frame:2px; --caption-color:rgb(32,40,48) }
        .dark { --caption-color:rgb(240,232,224) }
        section { padding:var(--frame) }
        header { box-sizing:border-box; height:44px; min-height:var(--cs-window-titlebar-min-height,0px); color:var(--caption-color) }
        #settings { display:none; padding:0 }
        #settings header { height:48px; color:rgb(180,200,220) }
      </style><div id="root"></div>`,
    }),
  );
  await page.goto("https://titlebar.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.renderFixture({}));
  await waitForStyle("#202830", 46);
  await flush();
  assert.equal(
    await page.evaluate(() => window.requests.length),
    1,
    "initial ResizeObserver and StrictMode do not duplicate native requests",
  );

  await page.evaluate(() => window.document.documentElement.classList.add("dark"));
  await waitForStyle("#f0e8e0", 46);
  await page.evaluate(() => {
    const style = window.document.createElement("style");
    style.id = "cs-theme-pack";
    style.textContent = ".dark{--caption-color:rgb(218,238,255)}";
    window.document.head.appendChild(style);
  });
  await waitForStyle("#daeeff", 46);
  await page.evaluate(() => {
    window.document.getElementById("cs-theme-pack").textContent =
      ".dark{--caption-color:rgb(240,220,230)}";
  });
  await waitForStyle("#f0dce6", 46);

  await page.evaluate(() => {
    const previous = window.document.getElementById("cs-theme-pack");
    const replacement = previous.cloneNode();
    replacement.textContent = ".dark{--caption-color:rgb(176,208,240)}";
    previous.replaceWith(replacement);
  });
  await waitForStyle("#b0d0f0", 46);
  await page.evaluate(() => window.document.getElementById("cs-theme-pack").remove());
  await waitForStyle("#f0e8e0", 46);
  await page.evaluate(() => {
    const style = window.document.createElement("style");
    style.id = "cs-theme-pack";
    style.textContent = ".dark{--caption-color:rgb(240,220,230)}";
    window.document.head.appendChild(style);
  });
  await waitForStyle("#f0dce6", 46);

  await page.evaluate(() => window.document.documentElement.style.setProperty("--frame", "8px"));
  await waitForStyle("#f0dce6", 52);
  await page.evaluate(() => window.document.documentElement.style.setProperty("--frame", "0px"));
  await waitForStyle("#f0dce6", 44);

  await page.evaluate(() => {
    window.document.getElementById("chat").style.display = "none";
    window.document.getElementById("settings").style.display = "block";
  });
  await waitForStyle("#b4c8dc", 48);
  await page.evaluate(() => {
    window.document.documentElement.classList.remove("dark");
  });
  await flush();
  assert.deepEqual(await latest(), { symbolColor: "#b4c8dc", height: 48 });
  await page.evaluate(() => {
    window.document.getElementById("chat").style.display = "";
    window.document.getElementById("settings").style.display = "none";
  });
  await waitForStyle("#202830", 44);

  const stableCount = await page.evaluate(() => window.requests.length);
  await page.evaluate(() => {
    const unrelated = window.document.createElement("style");
    unrelated.textContent = "body{font-family:sans-serif}";
    window.document.head.appendChild(unrelated);
    window.dispatchEvent(new window.Event("resize"));
    window.dispatchEvent(new window.Event("resize"));
  });
  await flush();
  assert.equal(
    await page.evaluate(() => window.requests.length),
    stableCount,
    "unrelated style mutations and resize events retain the native style",
  );

  await page.evaluate(() => {
    window.fixtureZoom = 2;
    window.dispatchEvent(new window.Event("resize"));
  });
  await page.waitForFunction((count) => window.requests.length === count + 1, stableCount);
  assert.deepEqual(
    await latest(),
    { symbolColor: "#202830", height: 44 },
    "page zoom resends CSS geometry for authoritative native DIP conversion",
  );
  await page.evaluate(() => {
    window.fixtureZoom = 0.5;
    window.dispatchEvent(new window.Event("resize"));
  });
  await waitForStyle("#202830", 64);
  assert.equal(
    await page
      .locator('[data-header="chat"]')
      .evaluate((header) => header.getBoundingClientRect().height),
    64,
    "zoomed-out content reserves at least 32 native DIP for caption buttons",
  );
  await page.evaluate(() => {
    window.fixtureZoom = 1;
    window.dispatchEvent(new window.Event("resize"));
  });
  await waitForStyle("#202830", 44);

  await page.evaluate(() => {
    window.rejectNext = true;
    window.document.documentElement.classList.add("dark");
  });
  await page.waitForFunction(() => window.logs.length === 1);
  assert.equal(
    await page.evaluate(() => window.logs[0].data.message),
    "fixture failure",
    "native rejections are handled and reported without unhandled errors",
  );
  const failedCount = await page.evaluate(() => window.requests.length);
  await page.evaluate(() => window.dispatchEvent(new window.Event("resize")));
  await page.waitForFunction((count) => window.requests.length === count + 1, failedCount);
  await waitForStyle("#f0dce6", 44);

  await page.evaluate(() => window.renderFixture({ mounted: false }));
  await page.locator("[data-header]").waitFor({ state: "detached" });
  const unmountedCount = await page.evaluate(() => window.requests.length);
  await page.evaluate(() => {
    window.document.documentElement.classList.remove("dark");
    window.dispatchEvent(new window.Event("resize"));
  });
  await flush();
  assert.equal(
    await page.evaluate(() => window.requests.length),
    unmountedCount,
    "unmounted headers disconnect appearance and geometry observers",
  );

  await page.evaluate(() => {
    window.codeshell.platform = "darwin";
    window.renderFixture({});
  });
  await page.locator('[data-header="chat"]').waitFor();
  await flush();
  assert.equal(
    await page.evaluate(() => window.requests.length),
    unmountedCount,
    "non-Windows headers do not invoke native overlay APIs",
  );
  await page.evaluate(() => window.renderFixture({ mounted: false }));
  await page.locator("[data-header]").waitFor({ state: "detached" });
  await page.evaluate(() => {
    window.codeshell.platform = "win32";
    window.codeshell.hasWindowTitleBarOverlay = false;
    window.renderFixture({});
  });
  await page.locator('[data-header="chat"]').waitFor();
  await flush();
  assert.equal(
    await page.evaluate(() => window.requests.length),
    unmountedCount,
    "Windows popouts without a native overlay do not invoke its APIs",
  );
  assert.deepEqual(errors, [], "caption synchronization has no browser errors");
  console.log("Window titlebar browser smoke passed: palette, frame, routes and lifecycle");
} finally {
  await page.close();
  await browser.close();
}
