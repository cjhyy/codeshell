import { expect, mock, test } from "bun:test";
import type { Page } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "./puppeteer-browser-driver.js";

/** One disabled button whose readiness wait resolves only once `enable()` runs. */
function fixture() {
  let enabled = false;
  const waiters = new Set<() => void>();
  const enable = () => {
    enabled = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const frame = {
    waitForFunction: mock(
      (_fn: unknown, options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const done = () => resolve({ dispose: async () => {} });
          if (enabled) return done();
          waiters.add(done);
          options.signal?.addEventListener(
            "abort",
            () => {
              waiters.delete(done);
              reject(new Error("waiting aborted"));
            },
            { once: true },
          );
        }),
    ),
    evaluateHandle: async () => result,
  };
  const button = {
    frame,
    asElement: () => button,
    dispose: async () => {},
    evaluate: async () => true,
    scrollIntoView: async () => {},
    click: mock(async () => {}),
  };
  const nodes = { dispose: async () => {}, getProperties: async () => new Map([["0", button]]) };
  const metadata = {
    dispose: async () => {},
    jsonValue: async () => [{ role: "button", name: "Submit" }],
  };
  const result = {
    dispose: async () => {},
    getProperty: async (key: string) => (key === "nodes" ? nodes : metadata),
    evaluate: async () => false,
  };
  const driver = new PuppeteerBrowserDriver({
    on() {},
    off() {},
    isClosed: () => false,
    url: () => "https://example.test/form",
    title: async () => "Form",
    frames: () => [frame],
    mainFrame: () => frame,
  } as unknown as Page);
  return { driver, button, enable };
}

test("a cancelled click stops waiting for readiness and never submits input", async () => {
  const f = fixture();
  try {
    const ref = (await f.driver.snapshot()).elements[0]!.ref;
    const click = f.driver.click(ref);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.driver.cancelPendingActions();
    f.enable(); // the page enables the button after the run was stopped
    expect(await click).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(f.button.click).not.toHaveBeenCalled();

    // A later, new request on the same page and ref still works.
    expect(await f.driver.click(ref)).toMatchObject({ ok: true });
    expect(f.button.click).toHaveBeenCalledTimes(1);
  } finally {
    f.driver.dispose();
  }
});
