import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CdpActionsDriver } from "@cjhyy/code-shell-cdp";
import { chromium, type Browser, type Page } from "playwright-core";
import { defaultLaunchCandidates } from "../browser-runtime/playwright-backend.js";
import { PlaywrightBrowserDriver } from "../browser-runtime/playwright-driver.js";

const launchCandidate = defaultLaunchCandidates()[0];
let browser: Browser;

beforeAll(async () => {
  if (!launchCandidate) return;
  browser = await chromium.launch({ headless: true, ...launchCandidate });
});
afterAll(async () => {
  await browser?.close();
});

async function withDriver(
  backend: "cdp" | "playwright",
  run: (page: Page, driver: Pick<CdpActionsDriver, "scroll" | "readContent">) => Promise<void>,
) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const cdp = backend === "cdp" ? await page.context().newCDPSession(page) : undefined;
  const forbidRawCdp =
    backend === "playwright"
      ? spyOn(page.context(), "newCDPSession").mockImplementation(async () => {
          throw new Error("Playwright scroll must use its Mouse and screenshot APIs");
        })
      : undefined;
  const driver = cdp
    ? new CdpActionsDriver(
        cdp.send.bind(cdp) as (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>,
        () => ({ url: page.url() }),
      )
    : new PlaywrightBrowserDriver(page.context(), page);
  try {
    await run(page, driver);
    if (forbidRawCdp) expect(forbidRawCdp).toHaveBeenCalledTimes(0);
  } finally {
    forbidRawCdp?.mockRestore();
    await cdp?.detach().catch(() => undefined);
    await page.context().close();
  }
}

for (const backend of ["cdp", "playwright"] as const) {
  describe(`${backend} real browser scrolling`, () => {
    test.skipIf(!launchCandidate)(
      "targets the main nested panel away from window center and stops at its end",
      async () => {
        await withDriver(backend, async (page, driver) => {
          await page.setContent(`<style>body {margin:0;overflow:hidden} aside {width:300px;height:220px;overflow:auto}
          main {position:absolute;left:600px;top:100px;width:360px;height:550px;overflow:auto}</style>
          <aside><div style="height:1800px">Navigation</div></aside>
          <div style="position:absolute;top:0;width:500px;height:10px;overflow:hidden">
            <div style="height:600px;overflow:auto"><div style="height:3000px">Clipped panel</div></div>
          </div>
          <main><div style="height:2000px">Rows</div></main>`);
          expect((await driver.readContent()).scroll).toMatchObject({
            target: "element",
            y: 0,
            maxY: 1450,
            atEnd: false,
          });
          expect(await driver.scroll("down", 0)).toMatchObject({
            ok: true,
            scroll: { target: "element" },
          });
          expect(await page.locator("main").evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
          expect(await page.locator("aside").evaluate((el) => el.scrollTop)).toBe(0);
          expect(await page.evaluate(() => window.scrollY)).toBe(0);
          expect((await driver.scroll("up", 200)).ok).toBe(true);
          await page.locator("main").evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          expect(await driver.scroll("down", 500)).toMatchObject({
            ok: false,
            code: "NO_PROGRESS",
            scroll: { atEnd: true },
          });
        });
      },
      30_000,
    );

    test.skipIf(!launchCandidate)(
      "scrolls a same-origin frame's nested content and reports its position",
      async () => {
        await withDriver(backend, async (page, driver) => {
          await page.setContent(
            `<style>body{margin:0;overflow:hidden}iframe{position:absolute;left:560px;top:80px;width:400px;height:550px}</style><iframe></iframe>`,
          );
          await page
            .frames()[1]
            .setContent(
              `<style>body{margin:0;overflow:hidden}main{height:500px;overflow:auto}</style><main><div style="height:2000px">Frame rows</div></main>`,
            );
          expect((await driver.readContent()).text).toContain("Frame rows");
          expect(await driver.scroll("down", 300)).toMatchObject({
            ok: true,
            scroll: { target: "element", y: 300 },
          });
          expect(
            await page
              .frames()[1]
              .locator("main")
              .evaluate((el) => el.scrollTop),
          ).toBe(300);
        });
      },
      30_000,
    );

    test.skipIf(!launchCandidate)(
      "wheels an opaque frame and verifies its visual progress without claiming DOM offsets",
      async () => {
        await withDriver(backend, async (page, driver) => {
          const frameHtml = `<style>body{margin:0}div{height:2000px;background:linear-gradient(red,blue)}</style><div></div>`;
          await page.setContent(`<style>body{margin:0;overflow:hidden}iframe{position:absolute;left:580px;top:80px;width:400px;height:550px}</style>
            <iframe src="data:text/html,${encodeURIComponent(frameHtml)}"></iframe>`);
          await page.frames()[1].waitForLoadState();
          expect((await driver.readContent()).scroll).toMatchObject({
            target: "frame",
            positionKnown: false,
            atEnd: false,
          });
          expect(await driver.scroll("down", 300)).toMatchObject({
            ok: true,
            contentChanged: true,
          });
          expect(await page.frames()[1].evaluate(() => window.scrollY)).toBe(300);
        });
      },
      30_000,
    );

    test.skipIf(!launchCandidate)(
      "drives a canvas wheel handler and validates painted progress without invented offsets",
      async () => {
        await withDriver(backend, async (page, driver) => {
          await page.setContent(`<style>body{margin:0;overflow:hidden}canvas{position:absolute;left:580px;top:80px;width:400px;height:550px}</style>
          <canvas width="400" height="550"></canvas><script>
            const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
            window.row=0;window.trustedWheel=false;
            function paint(){ctx.fillStyle=['#ff0000','#0000ff','#00aa00'][window.row];ctx.fillRect(0,0,400,550);}
            paint();canvas.addEventListener('wheel',e=>{e.preventDefault();window.trustedWheel=e.isTrusted;window.row=Math.max(0,Math.min(2,window.row+Math.sign(e.deltaY)));paint();},{passive:false});
          </script>`);
          expect((await driver.readContent()).scroll).toMatchObject({
            target: "canvas",
            positionKnown: false,
            atEnd: false,
          });
          expect(await driver.scroll("down", 300)).toMatchObject({
            ok: true,
            contentChanged: true,
            scroll: { positionKnown: false },
          });
          expect(await page.evaluate(() => (window as any).trustedWheel)).toBe(true);
          expect(await page.evaluate(() => (window as any).row)).toBe(1);
          expect(await driver.scroll("down", 300)).toMatchObject({
            ok: true,
            contentChanged: true,
          });
          expect(await driver.scroll("down", 300)).toMatchObject({
            ok: false,
            code: "NO_PROGRESS",
          });
        });
      },
      30_000,
    );
  });
}

test.skipIf(!launchCandidate)(
  "Playwright observes delayed canvas painting without repeating wheel input",
  async () => {
    await withDriver("playwright", async (page, driver) => {
      await page.setContent(`<style>body{margin:0;overflow:hidden}canvas{position:absolute;left:580px;top:80px;width:400px;height:550px}</style><canvas width="400" height="550"></canvas>
      <script>const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,400,550);c.addEventListener('wheel',e=>{window.trusted=e.isTrusted;window.wheelCount=(window.wheelCount||0)+1;setTimeout(()=>{ctx.fillStyle='blue';ctx.fillRect(0,0,400,550)},250)})</script>`);
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

for (const observation of ["evaluate", "screenshot"] as const) {
  test.skipIf(!launchCandidate)(
    `Playwright reports navigation when wheel navigation interrupts the final ${observation}`,
    async () => {
      await withDriver("playwright", async (page, driver) => {
        let releaseNavigation!: () => void;
        const navigationGate = new Promise<void>((resolve) => {
          releaseNavigation = resolve;
        });
        await page.route("https://scroll.fixture.invalid/**", async (route) => {
          if (route.request().url().endsWith("/destination")) {
            await navigationGate;
            await route.fulfill({ contentType: "text/html", body: "<main>Destination</main>" });
          } else {
            await route.fulfill({
              contentType: "text/html",
              body: `<style>body{margin:0;overflow:hidden}canvas{width:900px;height:600px}</style>
              <canvas></canvas><script>document.querySelector('canvas').addEventListener('wheel',e=>{
                e.preventDefault(); location.href='/destination';
              },{passive:false});</script>`,
            });
          }
        });
        await page.goto("https://scroll.fixture.invalid/source");
        const beforeDocument = (await driver.readContent()).documentId;
        const navigationCompleted = page.waitForURL("**/destination", {
          waitUntil: "domcontentloaded",
          timeout: 10_000,
        });
        // Keep the real wheel-triggered navigation pending until the driver's
        // final observation is in flight, then model the context-destroyed
        // rejection deterministically for both supported observation APIs.
        const originalEvaluate = page.evaluate.bind(page);
        let savedState: unknown;
        const heldEvaluation =
          observation === "screenshot"
            ? spyOn(page, "evaluate").mockImplementation(async (...args: unknown[]) => {
                // Let the DOM observation finish with its previous state while
                // the navigation response is gated; the screenshot is the API
                // whose rejection this variant exercises.
                savedState ??= await (originalEvaluate as (...args: unknown[]) => Promise<unknown>)(
                  ...args,
                );
                return savedState;
              })
            : undefined;
        let observations = 0;
        const original = page[observation].bind(page);
        const interruptedObservation = spyOn(page, observation).mockImplementation(
          async (...args: unknown[]) => {
            if (++observations === 2) {
              releaseNavigation();
              await navigationCompleted;
              throw new Error(
                "Execution context was destroyed, most likely because of a navigation",
              );
            }
            return (original as (...args: unknown[]) => Promise<any>)(...args);
          },
        );
        try {
          const result = await driver.scroll("down", 300);
          expect(result).toMatchObject({
            ok: false,
            code: "NAVIGATION",
            retryable: true,
            documentChanged: true,
          });
          expect(result.documentId).not.toBe(beforeDocument);
          expect(page.url()).toBe("https://scroll.fixture.invalid/destination");
        } finally {
          releaseNavigation();
          interruptedObservation.mockRestore();
          heldEvaluation?.mockRestore();
          await navigationCompleted.catch(() => undefined);
        }
      });
    },
    30_000,
  );
}
