import { afterAll, describe, expect, test } from "bun:test";
import { CdpActionsDriver } from "@cjhyy/code-shell-cdp";
import { chromium, type Browser, type Page } from "playwright-core";
import { defaultLaunchCandidates } from "../browser-runtime/playwright-backend.js";

const launchCandidate = defaultLaunchCandidates()[0];
let browser: Browser | undefined;

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

async function backendNodeId(page: Page, selector: string): Promise<number> {
  const session = await page.context().newCDPSession(page);
  try {
    const document = await session.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    const { node } = await session.send("DOM.describeNode", { nodeId });
    if (!node.backendNodeId) throw new Error(`no backend node for ${selector}`);
    return node.backendNodeId;
  } finally {
    await session.detach();
  }
}

describe("CdpActionsDriver Chromium integration", () => {
  test.skipIf(!launchCandidate)(
    "fills controls and focuses keys without accidental activation",
    async () => {
      browser = await chromium.launch({
        headless: true,
        ...(launchCandidate?.executablePath
          ? { executablePath: launchCandidate.executablePath }
          : {}),
        ...(launchCandidate?.channel ? { channel: launchCandidate.channel } : {}),
      });
      const page = await browser.newPage();
      await page.setContent(`
        <input id="query" value="old value" />
        <button id="submit" onclick="window.clickCount += 1">Submit</button>
        <script>
          window.clickCount = 0;
          window.inputEvents = [];
          query.addEventListener("input", () => window.inputEvents.push("input"));
          query.addEventListener("change", () => window.inputEvents.push("change"));
        </script>
      `);

      const cdp = await page.context().newCDPSession(page);
      const driver = new CdpActionsDriver(
        (method, params) => cdp.send(method as never, params),
        () => ({ url: page.url(), title: "CDP integration" }),
      );
      const queryId = await backendNodeId(page, "#query");
      const submitId = await backendNodeId(page, "#submit");

      expect(await driver.typeNode(queryId, "replacement")).toMatchObject({
        ok: true,
        code: "OK",
      });
      expect(await page.locator("#query").inputValue()).toBe("replacement");
      expect(await page.evaluate(() => window.inputEvents)).toEqual(["input"]);

      expect(await driver.focusNode(submitId)).toMatchObject({ ok: true, code: "OK" });
      expect(await page.evaluate(() => window.clickCount)).toBe(0);
      expect((await driver.pressKey("Enter")).ok).toBe(true);
      expect(await page.evaluate(() => window.clickCount)).toBe(1);

      await cdp.detach();
    },
    30_000,
  );
});

declare global {
  interface Window {
    clickCount: number;
    inputEvents: string[];
  }
}
