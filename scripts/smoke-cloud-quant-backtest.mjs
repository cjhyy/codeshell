/* Installed Quant browser workflow in two isolated projects; synthetic data only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);

export async function verifyCloudQuantBacktest({
  docker,
  containerA,
  projectA,
  projectB,
  serverUrl,
  password,
  request,
  candidatePanels,
  evidenceDir,
}) {
  const engine = await import(pathToFileURL(join(candidatePanels, "quant-lab/app/engine.mjs")));
  const csv =
    "date,open,high,low,close,volume\n" +
    Array.from({ length: 160 }, (_, i) => {
      const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
      const close = 100 + i / 10 + 8 * Math.sin(i / 7);
      return `${date},${close},${close + 2},${close - 2},${close},10000`;
    }).join("\n") +
    "\n";
  const fingerprint = engine.fingerprintBars(engine.parseOhlcvCsv(csv));
  const datasetPath = "quant/data/cloud-synthetic.csv";
  const metadata = {
    format: "codeshell.quant-dataset",
    fingerprint,
    adjust: "synthetic",
    source: "cloud-acceptance-synthetic",
  };
  await mkdir(evidenceDir, { recursive: true });
  await docker(["exec", "-i", containerA, "node", "--input-type=module"], {
    input: `
    import {mkdirSync,writeFileSync} from "node:fs";
    mkdirSync("/workspace/quant/data", {recursive:true});
    writeFileSync("/workspace/${datasetPath}", ${JSON.stringify(csv)});
    writeFileSync("/workspace/quant/data/cloud-synthetic.meta.json", ${JSON.stringify(JSON.stringify(metadata))});
  `,
  });
  async function files(project, directory) {
    const listing = await request(
      `/p/${project}/api/v1/files?path=${encodeURIComponent(directory)}`,
    );
    if (listing.status === 404) return [];
    assert.equal(listing.status, 200);
    const body = await listing.json();
    assert.equal(body.truncated, false);
    const output = [];
    for (const entry of body.files) {
      assert.equal(entry.kind, "file");
      const response = await request(
        `/p/${project}/api/v1/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      assert.equal(response.status, 200, `Quant output unreadable: ${entry.path}`);
      output.push({
        path: entry.path,
        content: Buffer.from(await response.arrayBuffer()).toString("utf8"),
      });
    }
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }
  const directories = ["quant/strategies", "quant/reports", "quant/exports"];
  const otherBefore = await Promise.all(directories.map((path) => files(projectB, path)));
  async function until(check, message) {
    const end = Date.now() + 150000;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error(message);
  }
  async function browserRun(action) {
    const browser = await chromium.launch({ channel: "chromium", chromiumSandbox: true });
    const pages = [],
      errors = [];
    let approving = false;
    const timer = setInterval(() => {
      if (approving) return;
      approving = true;
      void (async () => {
        for (const page of pages) {
          if (page.isClosed()) continue;
          const button = page
            .locator(".panel-host-confirm")
            .getByRole("button", { name: "确认执行", exact: true });
          if ((await button.isVisible()) && (await button.isEnabled()))
            await button.click({ timeout: 2000 });
        }
      })()
        .catch(() => {})
        .finally(() => {
          approving = false;
        });
    }, 200);
    async function open(project) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${serverUrl}/?project=${project}`);
      await page.getByLabel("用户名", { exact: true }).fill("smoke-admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: "面板", exact: true }).click();
      await page
        .locator(".panels-card")
        .filter({ has: page.locator("small", { hasText: /^quant-lab$/ }) })
        .getByRole("button", { name: "打开面板", exact: true })
        .click();
      const iframe = page.locator("iframe.panel-host-frame");
      await iframe.waitFor();
      const frame = await (await iframe.elementHandle()).contentFrame();
      await frame.locator("#backtest-storage-reload").waitFor({ state: "attached" });
      await until(
        () => frame.locator("#backtest-storage-reload").isEnabled(),
        "Quant project configuration did not load",
      );
      await frame.locator("#module-tab-research").click();
      await frame.locator("#research-advanced-loader > summary").click();
      return { context, page, frame };
    }
    try {
      await action(open);
      assert.deepEqual(errors, [], "Installed Quant must not raise page errors");
    } catch (error) {
      for (const [i, page] of pages.entries())
        if (!page.isClosed()) {
          await page
            .screenshot({ path: join(evidenceDir, `cloud-quant-error-${i}.png`), fullPage: true })
            .catch(() => {});
          for (const [j, frame] of page.frames().entries()) {
            const body = await frame
              .locator("body")
              .innerText()
              .catch(() => "unavailable");
            await writeFile(join(evidenceDir, `cloud-quant-error-${i}-${j}.txt`), body);
          }
        }
      throw error;
    } finally {
      clearInterval(timer);
      await browser.close();
    }
  }
  let saved;
  await browserRun(async (open) => {
    const first = await open(projectA);
    await first.frame.locator("#initial-capital").fill("125000");
    await first.frame.locator("#data-path").fill(datasetPath);
    await first.frame.locator("#load-data").click();
    await until(
      async () =>
        /160/.test(await first.frame.locator("#dataset-meta").innerText()) &&
        (await first.frame.locator("#run-state").innerText()) === "已完成",
      "Project CSV did not run in installed Quant",
    );
    await until(
      async () =>
        (await first.frame.locator("#backtest-storage-status").innerText()).includes(
          "已与项目记录一致",
        ),
      "Quant parameters did not persist",
    );
    for (const [button, directory] of [
      ["#save-strategy", directories[0]],
      ["#save-report", directories[1]],
      ["#export-backtest", directories[2]],
    ]) {
      await first.frame.locator(button).click();
      // A directory entry can appear before the atomic write finishes. Observe
      // the application's completed operation before reading its final bytes.
      await until(
        () => first.frame.locator(button).isEnabled(),
        `Quant save did not finish: ${directory}`,
      );
      await until(
        async () => (await files(projectA, directory)).length === 1,
        `Quant output missing: ${directory}`,
      );
    }
    saved = await Promise.all(directories.map((path) => files(projectA, path)));
    const spec = JSON.parse(saved[0][0].content);
    assert.equal(spec.dataset, datasetPath);
    assert.equal(spec.execution.initialCapital, 125000);
    assert.equal(spec.sample.bars, 160);
    assert.equal(spec.sample.fingerprint, fingerprint);
    assert.equal(spec.datasetMeta.source, metadata.source);
    assert.equal(spec.datasetMeta.adjust, "synthetic");
    assert.match(saved[2][0].content, /125000/);
    for (const group of saved)
      for (const file of group) {
        const response = await request(
          `/p/${projectA}/api/v1/files/content?path=${encodeURIComponent(file.path)}`,
        );
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(file.content));
        assert.equal(
          (
            await request(
              `/p/${projectB}/api/v1/files/content?path=${encodeURIComponent(file.path)}`,
            )
          ).status,
          404,
        );
      }
    await first.context.close();
    const second = await open(projectA);
    assert.equal(await second.frame.locator("#initial-capital").inputValue(), "125000");
    assert.equal(await second.frame.locator("#data-path").inputValue(), datasetPath);
    await second.frame.locator("#load-data").click();
    await until(
      async () => /160/.test(await second.frame.locator("#dataset-meta").innerText()),
      "Independent login did not reload project data",
    );
    await second.page.screenshot({
      path: join(evidenceDir, "cloud-quant-backtest.png"),
      fullPage: true,
    });
    const other = await open(projectB);
    assert.equal(await other.frame.locator("#initial-capital").inputValue(), "100000");
    assert.notEqual(await other.frame.locator("#data-path").inputValue(), datasetPath);
  });
  assert.deepEqual(
    await Promise.all(directories.map((path) => files(projectB, path))),
    otherBefore,
  );
  console.log(
    "PASS: installed cloud Quant reads synthetic project CSV, persists parameters, saves fingerprinted strategy/report/CSV and restores across independent logins without changing project B",
  );
  return async () => {
    await browserRun(async (open) => {
      const { frame } = await open(projectA);
      assert.equal(await frame.locator("#initial-capital").inputValue(), "125000");
      assert.equal(await frame.locator("#data-path").inputValue(), datasetPath);
      await frame.locator("#load-data").click();
      await until(
        async () => /160/.test(await frame.locator("#dataset-meta").innerText()),
        "Restart did not reload Quant CSV",
      );
    });
    assert.deepEqual(await Promise.all(directories.map((path) => files(projectA, path))), saved);
    assert.deepEqual(
      await Promise.all(directories.map((path) => files(projectB, path))),
      otherBefore,
    );
    console.log(
      "PASS: Quant project restart preserves saved parameters and exact strategy/report/CSV without duplicate outputs",
    );
  };
}
