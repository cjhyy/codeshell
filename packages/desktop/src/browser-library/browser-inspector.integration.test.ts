import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { defaultLaunchCandidates } from "../main/browser-runtime/playwright-backend.js";
import { createPlaywrightInspector, type BrowserInspector } from "./browser-inspector.js";

const explicitPath = process.env.CODESHELL_TEST_CHROMIUM;
// Use the same browser/channel as the host and its other Playwright integration
// suites, instead of independently preferring a Linux Chromium wrapper.
const launchCandidate =
  explicitPath && existsSync(explicitPath)
    ? { label: "explicit test browser", executablePath: explicitPath }
    : defaultLaunchCandidates()[0];

async function stage<T>(name: string, run: () => Promise<T>, timeoutMs = 6000): Promise<T> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  console.info(`[browser-inspector] ${name}: start`);
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    throw new Error(`browser inspector integration failed during ${name}`, { cause: error });
  } finally {
    clearTimeout(timer);
    console.info(`[browser-inspector] ${name}: ${Math.round(performance.now() - started)}ms`);
  }
}

test.skipIf(!launchCandidate)(
  "inspects a real page and records diagnostics without exposing request secrets",
  async () => {
    let browser: Browser | undefined;
    let inspector: BrowserInspector | undefined;
    let failed = false;
    let failure: unknown;
    try {
      browser = await stage(`launch ${launchCandidate!.label}`, () =>
        chromium.launch({ headless: true, ...launchCandidate, timeout: 5000 }),
      );
      const page = await stage("create page", () => browser!.newPage());
      page.setDefaultNavigationTimeout(3000);
      inspector = createPlaywrightInspector(page);
      await stage("install fixture route", () =>
        page.route("**/*", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/html",
            body: '<main id="main"><button>Ready</button><input type="password" value="never-return-this"></main>',
          }),
        ),
      );
      await inspector.inspect({ mode: "network" });
      await stage("load fixture", () => page.goto("https://fixture.test/?token=never-return-this"));
      expect((await inspector.inspect({ mode: "network" })).data).toEqual({
        recording: true,
        entries: [],
      });
      await stage("record network request", () =>
        page.evaluate(async () => {
          await fetch("/resource?token=never-return-this");
        }),
      );
      await inspector.inspect({ mode: "console" });
      await stage("record console message", () =>
        page.evaluate(() => console.log("fixture-ready")),
      );
      const dom = await stage("inspect DOM", () =>
        inspector!.inspect({ mode: "dom", selector: "#main", maxEntries: 3 }),
      );
      expect(dom.ok).toBe(true);
      expect((dom.data as any).nodes.length).toBe(3);
      expect(JSON.stringify(dom)).not.toContain("never-return-this");
      const network = await inspector.inspect({ mode: "network" });
      expect((network.data as any).entries[0]).toMatchObject({
        url: "https://fixture.test/resource",
        method: "GET",
        status: 200,
      });
      expect(JSON.stringify(network)).not.toContain("never-return-this");
      const logs = await inspector.inspect({ mode: "console" });
      expect((logs.data as any).entries.some((item: any) => item.text === "fixture-ready")).toBe(
        true,
      );
      const performance = await stage("inspect performance", () =>
        inspector!.inspect({ mode: "performance" }),
      );
      expect(performance.ok).toBe(true);
      expect(
        (performance.data as any).entries.some((item: any) => item.type === "navigation"),
      ).toBe(true);
      expect(
        (
          await stage("inspect invalid selector", () =>
            inspector!.inspect({ mode: "dom", selector: "#" }),
          )
        ).ok,
      ).toBe(false);
      await stage("prepare editable DOM", () =>
        page.evaluate(() => {
          const editor = document.createElement("div");
          editor.contentEditable = "true";
          editor.innerHTML = "<span>never-return-this</span>";
          document.body.append(editor);
          document.querySelector("button")!.setAttribute("role", "r".repeat(10000));
        }),
      );
      const editable = await stage("inspect editable DOM", () =>
        inspector!.inspect({ mode: "dom" }),
      );
      expect(JSON.stringify(editable)).not.toContain("never-return-this");
      expect(JSON.stringify(editable).length).toBeLessThan(5000);
      await stage("navigate to other origin", () => page.goto("https://other.test/"));
      await stage("record other-origin message", () =>
        page.evaluate(() => console.log("other-origin-content")),
      );
      await stage("return to fixture origin", () => page.goto("https://fixture.test/"));
      expect((await inspector.inspect({ mode: "console" })).data).toEqual({
        recording: true,
        entries: [],
      });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      inspector?.dispose();
      if (browser) {
        try {
          await stage("close browser", () => browser!.close(), 3000);
        } catch (error) {
          if (failed) console.error(error);
          else {
            failed = true;
            failure = error;
          }
        }
      }
    }
    if (failed) throw failure;
  },
  15000,
);
