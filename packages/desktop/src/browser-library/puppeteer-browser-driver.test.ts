import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import type { Browser, Page } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "./puppeteer-browser-driver.js";

const executablePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path): path is string => !!path && existsSync(path));
let browser: Browser;
beforeAll(async () => {
  if (executablePath)
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // Chromium 141 clips compositor wheel hit tests to its native window
      // after screenshot() activates it. Keep that window larger than our
      // 1000×700 emulated test viewport. Production connects with viewport=null.
      args: ["--no-sandbox", "--window-size=1200,900"],
    });
});
afterAll(async () => {
  await browser?.close();
});

async function withPage(run: (page: Page, driver: PuppeteerBrowserDriver) => Promise<void>) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  const driver = new PuppeteerBrowserDriver(page, { actionTimeoutMs: 1500 });
  try {
    await run(page, driver);
  } finally {
    driver.dispose();
    await page.close();
  }
}

describe("Puppeteer exact-node BrowserBridge", () => {
  test.skipIf(!executablePath)("reobserves a child frame navigation with fresh refs", async () => {
    await withPage(async (page, driver) => {
      await page.setContent(
        '<button onclick="window.count=(window.count||0)+1">Main</button><iframe srcdoc="<button>Old child</button>"></iframe>',
      );
      const old = await driver.snapshot();
      const child = page.frames()[1]!;
      const main = page.mainFrame();
      const evaluate = main.evaluateHandle.bind(main);
      let observations = 0;
      const observe = spyOn(main, "evaluateHandle").mockImplementation(async (...args: any[]) => {
        const result = await (evaluate as any)(...args);
        if (++observations === 1) await child.goto("data:text/html,<button>New child</button>");
        return result;
      });
      try {
        const refreshed = await driver.snapshot();
        expect(refreshed.detail).toBeUndefined();
        expect(observations).toBe(2);
        expect(refreshed.elements.map((element) => element.name)).toEqual(["Main", "New child"]);
        expect(await driver.click(old.elements[0]!.ref)).toMatchObject({ code: "STALE_SNAPSHOT" });
        expect(await driver.click(refreshed.elements[0]!.ref)).toMatchObject({ ok: true });
        expect(await page.evaluate(() => (window as any).count)).toBe(1);
      } finally {
        observe.mockRestore();
      }
    });
  });

  test.skipIf(!executablePath)("bounds child-frame observation retries", async () => {
    await withPage(async (page, driver) => {
      await page.setContent(
        '<button>Main</button><iframe srcdoc="<button>Child</button>"></iframe>',
      );
      const child = page.frames()[1]!;
      const main = page.mainFrame();
      const evaluate = main.evaluateHandle.bind(main);
      let observations = 0;
      const observe = spyOn(main, "evaluateHandle").mockImplementation(async (...args: any[]) => {
        const result = await (evaluate as any)(...args);
        await child.goto(`data:text/html,<button>Child ${++observations}</button>`);
        return result;
      });
      try {
        const result = await driver.snapshot();
        expect(result.elements).toEqual([]);
        expect(result.detail).toContain("navigated");
        expect(observations).toBe(3);
      } finally {
        observe.mockRestore();
      }
    });
  });

  test.skipIf(!executablePath)("does not retry into a newly navigated main document", async () => {
    await withPage(async (page, driver) => {
      await page.setContent("<button>Allowed document</button>");
      const main = page.mainFrame();
      const evaluate = main.evaluateHandle.bind(main);
      let observations = 0;
      const observe = spyOn(main, "evaluateHandle").mockImplementation(async (...args: any[]) => {
        const result = await (evaluate as any)(...args);
        if (++observations === 1)
          await page.goto("data:text/html,<button>Requires new authorization</button>");
        return result;
      });
      try {
        const result = await driver.snapshot();
        expect(result.elements).toEqual([]);
        expect(result.detail).toContain("navigated");
        expect(observations).toBe(1);
      } finally {
        observe.mockRestore();
      }
    });
  });

  test.skipIf(!executablePath)(
    "does not retry an observation after control is disposed",
    async () => {
      await withPage(async (page, driver) => {
        await page.setContent("<button>Main</button>");
        const main = page.mainFrame();
        const evaluate = main.evaluateHandle.bind(main);
        let observations = 0;
        const observe = spyOn(main, "evaluateHandle").mockImplementation(async (...args: any[]) => {
          const result = await (evaluate as any)(...args);
          observations++;
          driver.dispose();
          return result;
        });
        try {
          const result = await driver.snapshot();
          expect(result.elements).toEqual([]);
          expect(result.detail).toContain("control lease has ended");
          expect(observations).toBe(1);
        } finally {
          observe.mockRestore();
        }
      });
    },
  );

  test.skipIf(!executablePath)(
    "finds native editing hosts and buttons after a large ARIA table",
    async () => {
      await withPage(async (page, driver) => {
        await page.setContent(`<div role="table">${'<div role="row"><div role="cell">Row</div></div>'.repeat(300)}</div>
        <div contenteditable aria-label="Empty editor">old</div>
        <div contenteditable="plaintext-only" aria-label="Plain editor">old</div>
        <button onclick="this.textContent='Done'">End button</button>`);
        const snapshot = await driver.snapshot();
        expect(snapshot.elements.map((element) => element.name)).toEqual([
          "Empty editor",
          "Plain editor",
          "End button",
        ]);
        for (const name of ["Empty editor", "Plain editor"]) {
          const field = snapshot.elements.find((element) => element.name === name)!;
          expect(field.role).toBe("textbox");
          expect(await driver.type(field.ref, "updated")).toMatchObject({ ok: true });
        }
        expect(
          await page.$$eval("[contenteditable]", (elements) =>
            elements.map((element) => (element as HTMLElement).innerText),
          ),
        ).toEqual(["updated", "updated"]);
        expect(await driver.click(snapshot.elements[2]!.ref)).toMatchObject({ ok: true });
        expect(await page.$eval("button", (element) => element.textContent)).toBe("Done");
      });
    },
  );

  test.skipIf(!executablePath)(
    "keeps independent media budgets across frames and never serializes inline bodies",
    async () => {
      await withPage(async (page, driver) => {
        const links = Array.from(
          { length: 650 },
          (_, index) => `<a href="https://example.test/${index}">Link</a>`,
        ).join("");
        const svg = (label: string) =>
          `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><!--${label}--><rect width="20" height="10" fill="blue"/></svg>`)}`;
        await page.setContent(
          `${links}<img alt="Main image" src="${svg("main")}"><video src="data:video/mp4;base64,AA=="></video><iframe></iframe>`,
        );
        await page.frames()[1]!
          .setContent(`${links}<img alt="Large inline" src="${svg("PRIVATE_INLINE_BODY".repeat(4000))}">
        ${Array.from({ length: 220 }, (_, index) => `<img alt="Child ${index}" src="${svg(String(index))}">`).join("")}
        ${Array.from({ length: 220 }, (_, index) => `<video src="data:video/mp4,child-${index}"></video>`).join("")}`);
        const extracted = await driver.extractLinks();
        expect(extracted.ok).toBe(true);
        expect(extracted.links.length).toBe(200);
        expect(extracted.images.length).toBe(200);
        expect(extracted.videos.length).toBe(200);
        expect(extracted.truncated).toBe(true);
        expect(JSON.stringify(extracted)).not.toContain("PRIVATE_INLINE_BODY");
        expect(
          extracted.images.every(
            (image) => image.url.startsWith("inline:") && image.url.length < 120,
          ),
        ).toBe(true);
        const inline = extracted.images.find((image) => image.alt === "Large inline")!;
        expect((await driver.fetchImages([inline.ref!]))[0]).toMatchObject({
          ok: true,
          mediaType: "image/png",
        });
      });
    },
    20_000,
  );

  test.skipIf(!executablePath)(
    "fills input, textarea and contenteditable, selects labels, releases modifiers and masks secrets",
    async () => {
      await withPage(async (page, driver) => {
        await page.setContent(`<input aria-label="Name" value="old"><textarea aria-label="Notes">old</textarea>
        <div contenteditable="true" aria-label="Editor">old</div><input type="password" aria-label="Password" value="secret">
        <select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
        <input type="date" aria-label="Date" value="2026-09-09"><input type="number" aria-label="Count" value="123">
        <button onclick="this.dataset.clicked='yes'">Save</button>`);
        const snapshot = await driver.snapshot();
        const ref = (name: string) =>
          snapshot.elements.find((element) => element.name === name)!.ref;
        expect(snapshot.elements.find((element) => element.name === "Password")).toMatchObject({
          sensitive: true,
          value: undefined,
        });
        for (const name of ["Name", "Notes", "Editor"])
          expect(await driver.type(ref(name), "新的内容\nSecond")).toMatchObject({ ok: true });
        expect(await page.$eval("input", (element) => element.value)).toBe("新的内容 Second");
        expect(await page.$eval("textarea", (element) => element.value)).toBe("新的内容\nSecond");
        expect(
          await page.$eval("[contenteditable]", (element) => (element as HTMLElement).innerText),
        ).toBe("新的内容\nSecond");
        expect(await driver.type(ref("Name"), "")).toMatchObject({ ok: true });
        expect(await page.$eval("input", (element) => element.value)).toBe("");
        expect(await driver.selectOption(ref("Choice"), "Beta")).toMatchObject({ ok: true });
        expect(await page.$eval("select", (element) => element.value)).toBe("b");
        expect(await driver.type(ref("Date"), "2026-01-01")).toMatchObject({ ok: true });
        expect(await page.$eval("input[type=date]", (element) => element.value)).toBe("2026-01-01");
        expect(await driver.type(ref("Date"), "invalid")).toMatchObject({ ok: false });
        expect(await driver.type(ref("Count"), "456")).toMatchObject({ ok: true });
        expect(await page.$eval("input[type=number]", (element) => element.value)).toBe("456");
        expect(await driver.pressKey("Control+a", ref("Notes"))).toMatchObject({ ok: true });
        expect(await driver.click(ref("Save"))).toMatchObject({ ok: true });
        expect(await page.$eval("button", (element) => element.dataset.clicked)).toBe("yes");
        const down = spyOn(page.keyboard, "down"),
          up = spyOn(page.keyboard, "up");
        const press = spyOn(page.keyboard, "press").mockRejectedValueOnce(
          new Error("fixture input failure"),
        );
        expect(await driver.pressKey("Control+Shift+A")).toMatchObject({
          ok: false,
          retryable: false,
        });
        expect(down.mock.calls.map(([key]) => key)).toEqual(["Control", "Shift"]);
        expect(up.mock.calls.map(([key]) => key)).toEqual(["Shift", "Control"]);
        press.mockRestore();
        down.mockRestore();
        up.mockRestore();
      });
    },
    20_000,
  );

  test.skipIf(!executablePath)(
    "never retargets an identical replacement or a ref from an older snapshot/document",
    async () => {
      await withPage(async (page, driver) => {
        await page.setContent('<button onclick="window.hits=(window.hits||0)+1">Same</button>');
        const first = await driver.snapshot();
        await page.$eval("button", (element) => element.replaceWith(element.cloneNode(true)));
        expect(await driver.click(first.elements[0]!.ref)).toMatchObject({
          code: "STALE_SNAPSHOT",
          staleRef: true,
        });
        expect(await page.evaluate(() => (window as any).hits ?? 0)).toBe(0);
        const second = await driver.snapshot();
        expect(await driver.click(second.elements[0]!.ref)).toMatchObject({ ok: true });
        await driver.snapshot();
        expect(await driver.click(second.elements[0]!.ref)).toMatchObject({
          code: "STALE_SNAPSHOT",
        });
        const current = await driver.snapshot();
        expect(await driver.navigate("data:text/html,<button>Same</button>")).toMatchObject({
          ok: true,
          code: "NAVIGATION",
        });
        expect(await driver.click(current.elements[0]!.ref)).toMatchObject({
          code: "STALE_SNAPSHOT",
        });
        expect((await driver.snapshot()).documentId).not.toBe(current.documentId);
      });
    },
  );

  test.skipIf(!executablePath)(
    "keeps two authorized pages isolated and disposes without closing either",
    async () => {
      await withPage(async (page, driver) => {
        const secondPage = await browser.newPage();
        const second = new PuppeteerBrowserDriver(secondPage, { documentNamespace: "same-grant" });
        try {
          await page.setContent("<button>First</button>");
          await secondPage.setContent("<button>Second</button>");
          const a = await driver.snapshot(),
            b = await second.snapshot();
          expect(await driver.click(b.elements[0]!.ref)).toMatchObject({ code: "STALE_SNAPSHOT" });
          expect(await second.click(a.elements[0]!.ref)).toMatchObject({ code: "STALE_SNAPSHOT" });
          expect(await driver.switchTab((await second.listTabs())[0]!.tabId)).toMatchObject({
            code: "BLOCKED",
          });
          expect((await driver.listTabs()).length).toBe(1);
          driver.dispose();
          expect(await driver.click(a.elements[0]!.ref)).toMatchObject({ code: "BLOCKED" });
          expect(await driver.scroll("down")).toMatchObject({ code: "BLOCKED" });
          expect(page.isClosed()).toBe(false);
          expect(await second.click(b.elements[0]!.ref)).toMatchObject({ ok: true });
        } finally {
          second.dispose();
          await secondPage.close();
        }
      });
    },
  );

  test.skipIf(!executablePath)(
    "supports open shadow DOM and cross-origin frames for actions/read/extract/images",
    async () => {
      const pixel =
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
        );
      const child = `<main>Frame text <a href="/child-link">Child link</a><button onclick="this.textContent='Clicked'">Frame button</button><img alt="Frame image" src="${pixel}"></main>`;
      const server = Bun.serve({
        port: 0,
        hostname: "0.0.0.0",
        fetch(request) {
          return new Response(
            new URL(request.url).pathname === "/child"
              ? child
              : `<main>Main text</main><div id="host"></div><iframe src="http://localhost:${server.port}/child"></iframe>`,
            { headers: { "Content-Type": "text/html" } },
          );
        },
      });
      try {
        await withPage(async (page, driver) => {
          await page.goto(`http://127.0.0.1:${server.port}`);
          await page.$eval("#host", (element) => {
            element.attachShadow({ mode: "open" }).innerHTML =
              "<button onclick=\"this.textContent='Shadow clicked'\">Shadow button</button><p>Shadow text</p>";
          });
          const snapshot = await driver.snapshot();
          expect(snapshot.detail).toBeUndefined();
          const frameRef = snapshot.elements.find(
            (element) => element.name === "Frame button",
          )!.ref;
          expect(await driver.click(frameRef)).toMatchObject({ ok: true });
          expect(
            await driver.click(
              snapshot.elements.find((element) => element.name === "Shadow button")!.ref,
            ),
          ).toMatchObject({ ok: true });
          const read = await driver.readContent();
          expect(read.text).toContain("Frame text");
          expect(read.text).toContain("Shadow text");
          const extract = await driver.extractLinks();
          expect(extract.links.some((link) => link.url.endsWith("/child-link"))).toBe(true);
          const image = extract.images.find((image) => image.alt === "Frame image")!;
          expect((await driver.fetchImages([image.ref!]))[0]).toMatchObject({
            ok: true,
            mediaType: "image/png",
          });
          await page
            .frames()
            .find((frame) => frame.url().includes("/child"))!
            .goto(`http://localhost:${server.port}/child?again`);
          expect(await driver.click(frameRef)).toMatchObject({ code: "STALE_SNAPSHOT" });
        });
      } finally {
        server.stop(true);
      }
    },
    20_000,
  );

  test.skipIf(!executablePath)(
    "chunks frame text, rejects stale cursors and bounds screenshots at DPR 2",
    async () => {
      await withPage(async (page, driver) => {
        await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 2 });
        await page.setContent(
          `<main>${"Content ".repeat(500)}</main><button style="width:100px;height:40px">Capture</button>`,
        );
        const read = await driver.readContent({ maxChars: 256 });
        expect(read.text.length).toBe(256);
        expect(read.done).toBe(false);
        expect((await driver.readContent({ cursor: read.nextCursor })).ok).toBe(true);
        const screenshot = await driver.screenshot();
        expect(screenshot.ok).toBe(true);
        const dimensions = await page.evaluate(async (source) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          return { width: image.width, height: image.height };
        }, `data:${screenshot.mediaType};base64,${screenshot.base64}`);
        expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(1568);
        expect(dimensions.width / dimensions.height).toBeCloseTo(1000 / 700, 2);
        const snapshot = await driver.snapshot();
        expect((await driver.screenshot(snapshot.elements[0]!.ref)).ok).toBe(true);
        await driver.navigate("data:text/html,<main>new</main>");
        expect(await driver.readContent({ cursor: read.nextCursor })).toMatchObject({
          code: "STALE_CURSOR",
        });
      });
    },
  );

  test.skipIf(!executablePath)(
    "abort cancels waiting actions and blocks queued actions without closing the page",
    async () => {
      await withPage(async (page) => {
        const controller = new AbortController();
        const driver = new PuppeteerBrowserDriver(page, { signal: controller.signal });
        await page.setContent("<button disabled>Waiting</button>");
        const ref = (await driver.snapshot()).elements[0]!.ref;
        const action = driver.click(ref);
        const queued = driver.navigate("data:text/html,should-not-open");
        setTimeout(() => controller.abort(), 30);
        expect((await action).ok).toBe(false);
        expect(await queued).toMatchObject({ code: "BLOCKED" });
        expect(page.url()).toBe("about:blank");
        expect(page.isClosed()).toBe(false);
      });
    },
  );
});

describe("Puppeteer scrolling delegates input to the library", () => {
  test.skipIf(!executablePath)(
    "finds a nested panel outside the viewport center and proves end-of-content",
    async () => {
      await withPage(async (page, driver) => {
        await page.setContent(
          `<style>body{margin:0;overflow:hidden}main{position:absolute;left:600px;top:100px;width:350px;height:550px;overflow:auto}</style><main><div style="height:2000px">Rows</div></main>`,
        );
        const wheel = spyOn(page.mouse, "wheel");
        expect(await driver.scroll("down", 0)).toMatchObject({
          ok: true,
          scroll: { target: "element" },
        });
        expect(wheel).toHaveBeenCalledTimes(1);
        expect(await page.$eval("main", (element) => element.scrollTop)).toBeGreaterThan(100);
        expect(await page.evaluate(() => scrollY)).toBe(0);
        await page.$eval("main", (element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(await driver.scroll("down")).toMatchObject({
          code: "NO_PROGRESS",
          scroll: { atEnd: true },
        });
        wheel.mockRestore();
      });
    },
  );

  for (const paintDelay of [0, 250]) {
    test.skipIf(!executablePath)(
      `delivers one trusted canvas wheel and observes painting delayed by ${paintDelay}ms`,
      async () => {
        await withPage(async (page, driver) => {
          await page.setContent(`<style>body{margin:0;overflow:hidden}canvas{position:absolute;left:580px;top:80px;width:400px;height:550px}</style><canvas width="400" height="550"></canvas>
          <script>const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,400,550);c.addEventListener('wheel',e=>{window.trusted=e.isTrusted;window.wheelCount=(window.wheelCount||0)+1;setTimeout(()=>{ctx.fillStyle='blue';ctx.fillRect(0,0,400,550)},${paintDelay})})</script>`);
          const wheel = spyOn(page.mouse, "wheel");
          try {
            const result = await driver.scroll("down", 450);
            const delivery = await page.evaluate(() => ({
              trusted: (window as any).trusted,
              wheelCount: (window as any).wheelCount,
            }));
            expect({ ...result, ...delivery }).toMatchObject({
              ok: true,
              trusted: true,
              wheelCount: 1,
              contentChanged: true,
              scroll: { target: "canvas", positionKnown: false },
            });
            expect(wheel).toHaveBeenCalledTimes(1);
          } finally {
            wheel.mockRestore();
          }
        });
      },
    );
  }

  test.skipIf(!executablePath)(
    "scrolls frame content and detects navigation even when observation is interrupted",
    async () => {
      await withPage(async (page, driver) => {
        await page.setContent(
          `<style>body{margin:0;overflow:hidden}iframe{position:absolute;left:560px;top:80px;width:400px;height:550px}</style><iframe></iframe>`,
        );
        await page
          .frames()[1]!
          .setContent(
            '<style>body{margin:0;overflow:hidden}main{height:500px;overflow:auto}</style><main><div style="height:2000px">Frame rows</div></main>',
          );
        expect(await driver.scroll("down", 400)).toMatchObject({
          ok: true,
          scroll: { target: "element", y: 400 },
        });
        const original = page.evaluate.bind(page);
        let observed = 0;
        const interrupted = spyOn(page, "evaluate").mockImplementation(async (...args: any[]) => {
          if (typeof args[0] === "string" && ++observed === 2) {
            await page.goto("data:text/html,after-navigation");
            throw new Error("Execution context was destroyed");
          }
          return original(...(args as [any]));
        });
        expect(await driver.scroll("down", 100)).toMatchObject({
          code: "NAVIGATION",
          documentChanged: true,
          retryable: true,
        });
        interrupted.mockRestore();
      });
    },
  );
});
