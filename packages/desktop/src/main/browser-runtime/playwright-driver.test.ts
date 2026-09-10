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

async function fixtureContext(): Promise<BrowserContext> {
  if (context) return context;
  const profile = mkdtempSync(path.join(os.tmpdir(), "codeshell-playwright-driver-"));
  tempProfiles.push(profile);
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 900, height: 700 },
    ...(launchCandidate?.executablePath ? { executablePath: launchCandidate.executablePath } : {}),
    ...(launchCandidate?.channel ? { channel: launchCandidate.channel } : {}),
  });
  return context;
}

afterAll(async () => {
  await context?.close().catch(() => undefined);
  for (const profile of tempProfiles) rmSync(profile, { recursive: true, force: true });
});

describe("PlaywrightBrowserDriver integration", () => {
  test.skipIf(!launchCandidate)(
    "shares editing-host discovery and per-kind media budgets across frames",
    async () => {
      const context = await fixtureContext();
      const page = await context.newPage();
      const driver = new PlaywrightBrowserDriver(context, page);
      try {
        await page.setContent(
          `${'<div role="row">Row</div>'.repeat(300)}<div contenteditable aria-label="Editor">old</div><button>End</button><iframe></iframe>`,
        );
        const snapshot = await driver.snapshot();
        expect(snapshot.elements.map((element) => element.name)).toEqual(["Editor", "End"]);
        expect(await driver.type(snapshot.elements[0]!.ref, "updated")).toMatchObject({ ok: true });
        await page.evaluate(() => {
          const links = document.createElement("section");
          links.innerHTML = Array.from(
            { length: 650 },
            (_, index) => `<a href="https://example.test/${index}">Link</a>`,
          ).join("");
          document.body.prepend(links);
        });
        const image =
          "data:image/svg+xml," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!--INLINE_BODY--></svg>',
          );
        await page
          .frames()[1]!
          .setContent(
            `<img alt="Later frame image" src="${image}"><video src="data:video/mp4;base64,AA=="></video>`,
          );
        const extracted = await driver.extractLinks();
        expect(extracted.links.length).toBe(200);
        expect(extracted.images.length).toBe(1);
        expect(extracted.videos.length).toBe(1);
        expect(extracted.truncated).toBe(true);
        expect(JSON.stringify(extracted)).not.toContain("INLINE_BODY");
        expect(extracted.images[0]!.url).toStartWith("inline:");
        expect((await driver.fetchImages([extracted.images[0]!.ref!]))[0]!.ok).toBe(true);
      } finally {
        driver.dispose();
        await page.close();
      }
    },
  );

  test.skipIf(!launchCandidate)(
    "uses library actionability and invalidates exact refs after navigation",
    async () => {
      const context = await fixtureContext();
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

  test.skipIf(!launchCandidate)(
    "keeps exact nodes across replacement, including replacement during auto-wait",
    async () => {
      const context = await fixtureContext();
      const page = await context.newPage();
      const driver = new PlaywrightBrowserDriver(context, page);
      try {
        await page.setContent('<button onclick="window.hits=(window.hits||0)+1">Same</button>');
        const before = await driver.snapshot();
        await page.$eval("button", (element) => element.replaceWith(element.cloneNode(true)));
        expect(await driver.click(before.elements[0]!.ref)).toMatchObject({
          code: "STALE_SNAPSHOT",
          staleRef: true,
        });
        const current = await driver.snapshot();
        expect(await driver.click(current.elements[0]!.ref)).toMatchObject({ ok: true });
        expect(await page.evaluate(() => (window as any).hits)).toBe(1);
        await page.$eval("button", (element) => element.setAttribute("disabled", ""));
        const waiting = await driver.snapshot();
        const pending = driver.click(waiting.elements[0]!.ref);
        await page.evaluate(() =>
          setTimeout(() => {
            const element = document.querySelector("button")!;
            const replacement = element.cloneNode(true) as HTMLButtonElement;
            replacement.disabled = false;
            element.replaceWith(replacement);
          }, 30),
        );
        expect(await pending).toMatchObject({ code: "STALE_SNAPSHOT" });
        expect(await page.evaluate(() => (window as any).hits)).toBe(1);
      } finally {
        driver.dispose();
        await page.close();
      }
    },
  );

  test.skipIf(!launchCandidate)(
    "binds frame, shadow and media refs to their original page and invalidates detached frames",
    async () => {
      const context = await fixtureContext();
      const page = await context.newPage();
      const driver = new PlaywrightBrowserDriver(context, page);
      try {
        await page.setContent(
          "<div id=\"host\"></div><iframe srcdoc=\"<button onclick=&quot;this.textContent='Frame clicked'&quot;>Frame</button><a href=&quot;https://example.test/frame&quot;>Frame link</a><img alt=&quot;Frame image&quot; src=&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E&quot;>\"></iframe>",
        );
        await page.$eval("#host", (element) => {
          element.attachShadow({ mode: "open" }).innerHTML =
            "<button onclick=\"this.textContent='Shadow clicked'\">Shadow</button>";
        });
        const snapshot = await driver.snapshot();
        const frame = snapshot.elements.find((element) => element.name === "Frame")!.ref;
        const shadow = snapshot.elements.find((element) => element.name === "Shadow")!.ref;
        expect(await driver.click(frame)).toMatchObject({ ok: true });
        expect(await driver.click(shadow)).toMatchObject({ ok: true });
        expect((await driver.readContent()).text).toContain("Frame clicked");
        const extracted = await driver.extractLinks();
        expect(extracted.links[0]!.url).toBe("https://example.test/frame");
        expect((await driver.fetchImages([extracted.images[0]!.ref!]))[0]!.ok).toBe(true);
        await page.$eval("iframe", (element) => element.remove());
        expect(await driver.click(frame)).toMatchObject({ code: "STALE_SNAPSHOT" });
        const other = await context!.newPage();
        await other.setContent("<button>Other</button>");
        expect(await driver.click(shadow)).toMatchObject({ code: "STALE_SNAPSHOT" });
        const newSnapshot = await driver.snapshot();
        expect(newSnapshot.elements[0]!.name).toBe("Other");
        await other.close();
      } finally {
        driver.dispose();
        await page.close();
      }
    },
  );
});
