/* Real responsive Web workbench + installed Panel, paired with an isolated Desktop. */
/* global window, document */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium } from "playwright";

export async function verifyPairedDownload({ win, project, url, bytes, expectedIds }) {
  await win.evaluate(() => window.codeshell.mobileRemote.start({ mode: "lan" }));
  const pairing = await win.evaluate(() => window.codeshell.mobileRemote.pairingUrl());
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  let page,
    approving = false,
    stopped = false;
  const confirmations = [];
  const timer = setInterval(() => {
    if (approving || stopped || !page || page.isClosed()) return;
    approving = true;
    void (async () => {
      const prompt = page.locator(".panel-host-confirm");
      if (!(await prompt.isVisible())) return;
      const button = prompt.getByRole("button", { name: "确认执行", exact: true });
      if (!(await button.isEnabled())) return;
      confirmations.push(await prompt.innerText());
      await button.click({ timeout: 2000 });
    })()
      .catch(() => {})
      .finally(() => {
        approving = false;
      });
  }, 250);
  async function open(target) {
    page = await context.newPage();
    page.on("pageerror", (error) => console.error("Paired page error:", error.message));
    await page.goto(target);
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click({ timeout: 30000 });
    const projects = page.getByRole("combobox", { name: "选择项目", exact: true });
    await projects.selectOption({ label: "Download test" });
    await page.getByRole("button", { name: "面板", exact: true }).click();
    await page
      .locator(".panels-card")
      .filter({ has: page.locator("small", { hasText: /^video-download$/ }) })
      .getByRole("button", { name: "打开面板", exact: true })
      .click();
    await page.locator("iframe.panel-host-frame").waitFor();
    const frame = await (
      await page.locator("iframe.panel-host-frame").elementHandle()
    ).contentFrame();
    await frame.waitForFunction(() => typeof window.codeshellPanel === "object", null, {
      timeout: 30000,
    });
    console.log("Paired browser: project selected and Panel frame ready.");
    return frame;
  }
  const call = (frame, method, params) =>
    frame.evaluate(({ method, params }) => window.codeshellPanel.call(method, params), {
      method,
      params,
    });
  async function until(read, message, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await read();
      if (result) return result;
      await new Promise((done) => setTimeout(done, 900));
    }
    throw new Error(message);
  }
  try {
    let frame = await open(pairing.pairingUrl);
    await until(async () => {
      const jobs = await call(frame, "tasks.list", {});
      return expectedIds.every((id) =>
        jobs.some((job) => job.id === id && job.status === "succeeded"),
      );
    }, "Paired browser did not recover Desktop task IDs");
    console.log("Paired browser: shared Desktop task IDs recovered.");
    await frame.waitForFunction(
      () => document.querySelectorAll('.queue-item[data-state="completed"]').length === 2,
    );
    await until(
      () =>
        frame
          .locator("#installed-ytdlp-version")
          .textContent()
          .then((text) => /20\d{2}/.test(text)),
      "Paired browser dependencies did not become ready",
    );
    console.log("Paired browser: real downloader ready.");
    await frame.locator("#url-input").fill(url.replace("fixture.mp4", "phone.mp4"));
    await frame.locator("#cookie-select").selectOption("download-fixture");
    await frame.locator("#inspect-button").click();
    await until(async () => {
      const status = frame.locator("#inspect-status");
      const state = await status.getAttribute("data-state");
      if (state === "error")
        throw new Error("Paired metadata failed: " + (await status.innerText()));
      return state === "ready";
    }, "Paired browser metadata did not finish");
    console.log("Paired browser: saved-account metadata read.");
    await frame.locator("#download-button").click();
    const admitted = await until(async () => {
      const error = await frame.locator("#form-error").innerText();
      if (error.trim()) throw new Error("Paired download submission failed: " + error);
      const jobs = await call(frame, "tasks.list", {});
      const job = jobs.find(
        (job) => job.entry.name === "download-runtime" && !expectedIds.includes(job.id),
      );
      if (job?.status === "failed") throw new Error(JSON.stringify(job.error));
      return job?.status === "running" ? job : false;
    }, "Paired browser did not submit its background task");
    const started = await call(frame, "tasks.get", { id: admitted.id });
    assert.equal(started.input.cookieArgument.credentialId, "download-fixture");
    assert.equal(started.input.request.useSavedLogin, true);
    const destination = new URL("/mobile/", pairing.pairingUrl).href;
    await page.close();
    page = undefined;
    frame = await open(destination);
    const completed = await until(async () => {
      const job = await call(frame, "tasks.get", { id: started.id });
      if (job.status === "failed") throw new Error(JSON.stringify(job.error));
      return job.status === "succeeded" ? job : false;
    }, "Paired browser task did not finish after page close");
    assert.deepEqual(
      await readFile(join(project, completed.result.artifacts[0].published.path)),
      bytes,
    );
    assert.doesNotMatch(JSON.stringify(completed), /download-cookie-fixture/);
    await frame.waitForFunction(
      () => document.querySelectorAll('.queue-item[data-state="completed"]').length === 3,
    );
    assert.equal(
      (await call(frame, "tasks.list", {})).filter((job) => job.entry.name === "download-runtime")
        .length,
      3,
    );
    assert.ok(
      confirmations.filter((text) => text.includes("Download fixture account")).length >= 2,
    );
    assert.ok(confirmations.every((text) => !text.includes("download-cookie-fixture")));
    await frame.locator('[data-tab="task"]').click();
    await frame.locator("#open-directory").click();
    const listingPromise = context.waitForEvent("page");
    await page.getByRole("link", { name: "查看并下载文件", exact: true }).click();
    const listing = await listingPromise;
    const savedPromise = listing.waitForEvent("download");
    await listing
      .getByRole("link", {
        name: basename(completed.result.artifacts[0].published.path),
        exact: true,
      })
      .click();
    const saved = await savedPromise;
    assert.deepEqual(await readFile(await saved.path()), bytes);
    await listing.close();
    console.log(
      "Paired 390px browser passed: real pairing/workbench/Panel, Desktop task recovery, account metadata, background submission, browser close/reopen, file saved through browser with exact bytes.",
    );
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(
        "Paired workbench state:",
        (await page.locator("body").innerText()).slice(0, 5000),
      );
      for (const frame of page.frames().filter((frame) => frame !== page.mainFrame()))
        console.error(
          "Paired Panel state:",
          (
            await frame
              .locator("body")
              .innerText()
              .catch(() => "unavailable")
          ).slice(0, 6000),
        );
    }
    throw error;
  } finally {
    stopped = true;
    clearInterval(timer);
    await browser.close();
  }
}
