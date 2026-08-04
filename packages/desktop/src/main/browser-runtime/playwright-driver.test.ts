import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { defaultLaunchCandidates } from "./playwright-backend.js";
import { PlaywrightBrowserDriver } from "./playwright-driver.js";

const launchCandidate = defaultLaunchCandidates()[0];
const tempProfiles: string[] = [];
let context: BrowserContext | undefined;

afterAll(async () => {
  await context?.close().catch(() => undefined);
  for (const profile of tempProfiles) rmSync(profile, { recursive: true, force: true });
});

describe("PlaywrightBrowserDriver integration", () => {
  test.skipIf(!launchCandidate)(
    "uses Locator actionability and invalidates snapshot refs after navigation",
    async () => {
      const profile = mkdtempSync(path.join(os.tmpdir(), "codeshell-playwright-driver-"));
      tempProfiles.push(profile);
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: { width: 900, height: 700 },
        ...(launchCandidate?.executablePath
          ? { executablePath: launchCandidate.executablePath }
          : {}),
        ...(launchCandidate?.channel ? { channel: launchCandidate.channel } : {}),
      });
      const page = context.pages()[0] ?? (await context.newPage());
      const driver = new PlaywrightBrowserDriver(context, page);
      const article = "A".repeat(700);
      await page.setContent(`
        <main>
          <label>Name <input id="name" /></label>
          <button id="submit" onclick="document.querySelector('output').textContent = document.querySelector('input').value">Submit</button>
          <output></output>
          <article>${article}</article>
        </main>
      `);

      const snapshot = await driver.snapshot();
      expect(snapshot.documentId).toBeTruthy();
      expect(snapshot.snapshotId).toStartWith("pw");
      const textbox = snapshot.elements.find((element) => element.role === "textbox");
      const button = snapshot.elements.find((element) => element.name === "Submit");
      expect(textbox).toBeTruthy();
      expect(button).toBeTruthy();

      expect(await driver.type(textbox!.ref, "Locator waited")).toMatchObject({
        ok: true,
        code: "OK",
      });
      expect((await driver.click(button!.ref)).ok).toBe(true);
      expect(await page.locator("output").innerText()).toBe("Locator waited");

      const first = await driver.readContent({ maxChars: 256 });
      expect(first).toMatchObject({ ok: true, done: false, truncated: true });
      expect(first.text.length).toBe(256);
      const second = await driver.readContent({ cursor: first.nextCursor, maxChars: 256 });
      expect(second).toMatchObject({ ok: true });
      expect(second.cursor).toBe(first.nextCursor);

      await driver.navigate("data:text/html,<button>New%20document</button>");
      expect(await driver.click(button!.ref)).toMatchObject({
        ok: false,
        code: "STALE_SNAPSHOT",
        staleRef: true,
      });
    },
    30_000,
  );
});
