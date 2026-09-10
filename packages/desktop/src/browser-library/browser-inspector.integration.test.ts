import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { createPlaywrightInspector } from "./browser-inspector.js";

const executablePath = [
  process.env.CODESHELL_TEST_CHROMIUM,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
].find((path): path is string => !!path && existsSync(path));

test.skipIf(!executablePath)(
  "inspects a real page and records diagnostics without exposing request secrets",
  async () => {
    const browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    const inspector = createPlaywrightInspector(page);
    try {
      await page.route("**/*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: '<main id="main"><button>Ready</button><input type="password" value="never-return-this"></main>',
        }),
      );
      await inspector.inspect({ mode: "network" });
      await page.goto("https://fixture.test/?token=never-return-this");
      expect((await inspector.inspect({ mode: "network" })).data).toEqual({
        recording: true,
        entries: [],
      });
      await page.evaluate(async () => {
        await fetch("/resource?token=never-return-this");
      });
      await inspector.inspect({ mode: "console" });
      await page.evaluate(() => console.log("fixture-ready"));
      const dom = await inspector.inspect({ mode: "dom", selector: "#main", maxEntries: 3 });
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
      const performance = await inspector.inspect({ mode: "performance" });
      expect(performance.ok).toBe(true);
      expect(
        (performance.data as any).entries.some((item: any) => item.type === "navigation"),
      ).toBe(true);
      expect((await inspector.inspect({ mode: "dom", selector: "#" })).ok).toBe(false);
      await page.evaluate(() => {
        const editor = document.createElement("div");
        editor.contentEditable = "true";
        editor.innerHTML = "<span>never-return-this</span>";
        document.body.append(editor);
        document.querySelector("button")!.setAttribute("role", "r".repeat(10000));
      });
      const editable = await inspector.inspect({ mode: "dom" });
      expect(JSON.stringify(editable)).not.toContain("never-return-this");
      expect(JSON.stringify(editable).length).toBeLessThan(5000);
      await page.goto("https://other.test/");
      await page.evaluate(() => console.log("other-origin-content"));
      await page.goto("https://fixture.test/");
      expect((await inspector.inspect({ mode: "console" })).data).toEqual({
        recording: true,
        entries: [],
      });
    } finally {
      inspector.dispose();
      await browser.close();
    }
  },
  15000,
);
