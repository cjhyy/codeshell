import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  installReviewedLocalPanelApp,
  listInstalledPanelApps,
  previewLocalPanelApp,
  uninstallPanelApp,
} from "./installer.js";

let root: string;
let source: string;
let previousHome: string | undefined;

function writePanel(version: string) {
  writeFileSync(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "guard-panel",
      version,
      title: { default: "Guard panel" },
      entry: "app/index.html",
      permissions: [],
      placement: "right-dock",
      icon: "panel",
      singleton: true,
    }),
  );
}

beforeEach(() => {
  previousHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), "cs-panel-commit-guard-"));
  process.env.HOME = join(root, "home");
  source = join(root, "source");
  mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(source, "app"), { recursive: true });
  writeFileSync(join(source, "app/index.html"), "<!doctype html><body>Panel</body>");
  writePanel("1.0.0");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test("a denied commit after full staging leaves no new installation or registry record", async () => {
  const preview = await previewLocalPanelApp({ kind: "dir", path: source });
  const installedRoot = join(process.env.HOME!, ".code-shell/panel-apps");
  let staged = false;
  await expect(
    installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      preview.reviewToken,
      new Date().toISOString(),
      {
        beforeCommit: async () => {
          staged = readdirSync(installedRoot).some((entry) =>
            entry.startsWith(".tmp-guard-panel-"),
          );
          await Promise.resolve();
          throw new Error("owner revoked");
        },
      },
    ),
  ).rejects.toThrow("owner revoked");
  expect(staged).toBe(true);
  expect(await listInstalledPanelApps()).toEqual([]);
  expect(readdirSync(installedRoot).filter((entry) => entry !== ".operations")).toEqual([]);
});

test("same-app updates serialize their reviewed commit guards", async () => {
  const first = await previewLocalPanelApp({ kind: "dir", path: source });
  await installReviewedLocalPanelApp(
    { kind: "dir", path: source },
    first.reviewToken,
    new Date().toISOString(),
  );
  writePanel("2.0.0");
  const reviewed = await previewLocalPanelApp({ kind: "dir", path: source });
  const update = () =>
    installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      reviewed.reviewToken,
      new Date().toISOString(),
      {
        overwrite: true,
        beforeCommit: async () => {
          const current = (await listInstalledPanelApps())[0];
          if (current?.version !== "1.0.0") throw new Error("reviewed revision changed");
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
    );
  const results = await Promise.allSettled([update(), update()]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(
    (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason
      .message,
  ).toBe("reviewed revision changed");
  expect((await listInstalledPanelApps())[0]?.version).toBe("2.0.0");
});

test("separate host processes cannot both commit the same reviewed installed revision", async () => {
  const first = await previewLocalPanelApp({ kind: "dir", path: source });
  await installReviewedLocalPanelApp(
    { kind: "dir", path: source },
    first.reviewToken,
    new Date().toISOString(),
  );
  writePanel("2.0.0");
  const reviewed = await previewLocalPanelApp({ kind: "dir", path: source });
  const script = join(root, "install-child.mjs");
  writeFileSync(
    script,
    `import { installReviewedLocalPanelApp, listInstalledPanelApps } from ${JSON.stringify(new URL("./installer.ts", import.meta.url).href)};
try {
  await installReviewedLocalPanelApp({kind:"dir",path:process.argv[2]},process.argv[3],new Date().toISOString(),{
    overwrite:true,
    beforeCommit:async()=>{
      const current=(await listInstalledPanelApps())[0];
      if(current?.version!=="1.0.0")throw new Error("reviewed revision changed");
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  });
  process.exitCode=0;
}catch(error){
  process.exitCode=error.message==="reviewed revision changed"?2:3;
  if(process.exitCode===3)console.error(error);
}`,
  );
  const run = () =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [script, source, reviewed.reviewToken], {
        env: { ...process.env },
        stdio: "pipe",
      });
      let error = "";
      child.stderr.on("data", (value) => {
        error += String(value);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 3) reject(new Error(error));
        else resolve(code);
      });
    });
  expect((await Promise.all([run(), run()])).sort()).toEqual([0, 2]);
  expect((await listInstalledPanelApps())[0]?.version).toBe("2.0.0");
});

test("denied replacement and deletion both preserve the previous installed snapshot", async () => {
  const first = await previewLocalPanelApp({ kind: "dir", path: source });
  await installReviewedLocalPanelApp(
    { kind: "dir", path: source },
    first.reviewToken,
    new Date().toISOString(),
  );
  writePanel("2.0.0");
  const second = await previewLocalPanelApp({ kind: "dir", path: source });
  const refuse = async () => {
    throw new Error("revision changed");
  };
  await expect(
    installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      second.reviewToken,
      new Date().toISOString(),
      { overwrite: true, beforeCommit: refuse },
    ),
  ).rejects.toThrow("revision changed");
  await expect(uninstallPanelApp("guard-panel", { beforeCommit: refuse })).rejects.toThrow(
    "revision changed",
  );
  expect((await listInstalledPanelApps())[0]?.version).toBe("1.0.0");
  expect(
    existsSync(join(process.env.HOME!, ".code-shell/panel-apps/guard-panel/app/index.html")),
  ).toBe(true);
});
