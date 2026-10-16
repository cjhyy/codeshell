import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DESKTOP_LINK_PROVIDER_BUNDLE,
  desktopLinkProviderModuleUrl,
} from "./link-provider-module.js";

test("packaged Link providers resolve inside the application, including spaces and non-ASCII paths", () => {
  const appPath = join(tmpdir(), "Code Shell 测试.app", "Contents", "Resources", "app.asar");
  const url = desktopLinkProviderModuleUrl({ isPackaged: true, getAppPath: () => appPath }, () => {
    throw new Error("Packaged workers must not resolve a development workspace");
  });
  expect(url).toBe(pathToFileURL(join(appPath, DESKTOP_LINK_PROVIDER_BUNDLE)).href);
  expect(new URL(url).protocol).toBe("file:");
  expect(new URL(url).pathname).toContain("%E6%B5%8B%E8%AF%95");
});

test("development Link providers keep the workspace resolver without reading an application path", () => {
  let resolutions = 0;
  const development = "file:///fixture/server/dist/index.links.js";
  expect(
    desktopLinkProviderModuleUrl(
      {
        isPackaged: false,
        getAppPath: () => {
          throw new Error("Development resolution must not need a packaged application");
        },
      },
      () => {
        resolutions++;
        return development;
      },
    ),
  ).toBe(development);
  expect(resolutions).toBe(1);
});

test("a missing packaged provider bundle fails to import without falling back to development", async () => {
  const appPath = await mkdtemp(join(tmpdir(), "missing-worker-link-bundle-"));
  let resolutions = 0;
  try {
    const url = desktopLinkProviderModuleUrl(
      { isPackaged: true, getAppPath: () => appPath },
      () => {
        resolutions++;
        return "file:///fixture/server/dist/index.links.js";
      },
    );
    await expect(import(url)).rejects.toThrow();
    expect(url).toBe(pathToFileURL(join(appPath, DESKTOP_LINK_PROVIDER_BUNDLE)).href);
    expect(resolutions).toBe(0);
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});
